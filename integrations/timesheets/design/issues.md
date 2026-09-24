# Timesheets frontend: implementation issues

Derived from [`DESIGN.md`](DESIGN.md) and [`mockups.html`](mockups.html)
(ontola/atomic-plugins#89). Each issue below is a title plus a body ready for
`gh issue create`. All work stays inside `integrations/timesheets/` (plugin
folder containment). Every new `.ts` file starts with `// @wc-ignore-file`.

To keep issues parallel, each owns separate files: the pure view model
(`app/model/`), the controller (`app/controller.ts`), the sync
(`app/sync.ts`, `app/clockifyApi.ts`, `app/ontology.ts`), and one file per UI
piece under `app/ui/`. UI issues build against the view-model types from
T4 and can start from a stub of those types before T4 merges.

Every issue is checked with the lane command from an atomic-server checkout
with this repo's `integrations/` in place (see AGENTS.md):

```sh
node integrations/tooling/run-lane.mjs timesheets
node integrations/timesheets/app/build.mjs
```

## Dependency overview

```
T1 theme ─────────────┐
T2 controller ────────┼─> T6 shell ─┬─> T11 set-up/empty/error states
T3 sync data+progress │             ├─> T12 settings sheet
T4 view model ────────┼─> T7 week ──┤
                      ├─> T8 entries┼─> T13 narrow layout
                      ├─> T9 projects
                      └─> T10 detail drawer
T5 row reader (blocked on atomic-server props/propVals fix)
T14 a11y + DOM tests (after T6–T13)
Later: T15 two-way + conflicts, T16 running timer
```

---

## T1. Timesheets app: theme tokens and injected stylesheet

**Labels:** timesheets, frontend · **Depends on:** none

Add `app/ui/theme.ts` exporting a `css` string and `installStyles(root)` that
appends one `<style>` element to the view root (the module ships no
stylesheet; `build.mjs` bundles JS only).

- Define the `--pl-*` tokens on the app root, each as
  `var(--t-…, fallback)` per the table in DESIGN.md §4 (the host posts
  `--t-*` via `__atomic_style`). Fallbacks equal the host's light defaults.
- Base styles for: header row, chip, status pill (`data-state`
  `idle|syncing|synced|paused|reauth|error`), buttons (primary, secondary,
  ghost, danger, icon), segmented control, card, banner (warn/neg/info),
  focus ring, `.sr` visually-hidden, tabular numerals. Copy values from
  `design/mockups.html`.
- Pulse animation off under `prefers-reduced-motion`.

Acceptance: `build.test.ts` still passes and asserts the bundle contains no
`@import` or external URL; bundle size stated in the PR (today ~17 KB).
Not required: pixel comparison.

---

## T2. Timesheets controller: connect in-frame, workspace set-up, auto-sync

**Labels:** timesheets, frontend · **Depends on:** none

Bring `app/controller.ts` to the notion app's connection model and add the
set-up step.

- States (as data, DOM-free): `loading`, `no-proxy`, `not-connected`,
  `connecting`, `choose-workspace` (with the workspace list and user), `ready`,
  `syncing` (with progress, see T3), plus `last` outcome on `ready` carrying a
  typed error (`kind: 'reauth' | 'forbidden' | 'rate-limited' | 'network' |
  'too-many' | 'other'`, `retryAfterSeconds?`, `detail`).
- `load()` uses `store.proxy.connections({ platform: 'clockify' })`;
  `connect()` calls `store.proxy.connect(...)` and returns to `not-connected`
  on cancel.
- `chooseWorkspace(workspaceId, lookbackDays)` writes `workspace-id`,
  `user-id`, `lookback-days` on the App resource. With one workspace, skip the
  list.
- After `load()` reaches `ready`, sync once (notion does the same).
- **Needs a decision first** (DESIGN.md §10.2): keep `connection-id` on the
  App resource, or look it up via `connections()` each load. Default in
  this issue: look it up, and stop writing `connection-id`.

Acceptance: `controller.test.ts` covers every transition with `fakeStore.ts`,
including cancel during connect and a 401 mapping to `reauth`.

---

## T3. Timesheets sync: project colour, client, week start, skipped counts, progress

**Labels:** timesheets, sync · **Depends on:** none

Extend `app/clockifyApi.ts`, `app/sync.ts`, `app/ontology.ts` so the views
have what they show.

- Fetch `/api/v1/user` settings (`weekStart`, `timeZone`) once per sync and
  return them in the result (not stored on rows).
- Store per row: `project-color` (Clockify project `color`, a `#rrggbb`
  string), `client-name` (from the project's `clientName`). New provisional
  property URLs in `ontology.ts`, same pattern as the existing ones.
- Count, do not import: running entries (no `end`) and breaks. Return
  `skippedRunning`, `skippedBreaks` in `SyncResult`.
- Accept an `onProgress({ phase: 'fetch' | 'save', done, total? })`
  callback; call it per fetched page and per saved row.
- Throw a typed `ProxyError` that keeps `status` and, when relayed,
  `retry-after`; T2 maps it to the error kinds.
- Test that a property the user added to a row survives a sync (DESIGN.md §6D).

Acceptance: `sync.test.ts` covers each new field, the counts, progress call
order, and 401/403/429 errors. Not verified live against Clockify; say so in
the PR.

---

## T4. Timesheets view model: weeks, days, durations, projects (pure)

**Labels:** timesheets, frontend · **Depends on:** none

Add `app/model/` with pure functions and types, no DOM, no store:

- `Entry` input type (id, name, start ms, end ms, billable, project id /
  name / colour / client).
- `formatDuration(ms)` → `h:mm`; `spokenDuration(ms)` → "2 hours 30 minutes".
  Sum integer ms; round only when formatting (DESIGN.md §7).
- `weekOf(date, weekStart, timeZone)`; bucket entries by start instant in
  the given IANA zone (use `Intl.DateTimeFormat`, no library).
- `weekGrid(entries, week)` → rows sorted by total desc, "No project" last,
  day totals, week total, billable / not billable totals, and per-day
  `inWindow` flags given the import window.
- `dayList(entries, week)` → days newest first, empty days omitted.
- `projectSummary(entries, window)` → totals, billable part, share with one
  decimal whose displayed values sum to 100.0 (largest-remainder rounding).

Acceptance: unit tests reproduce every number in `design/mockups.html`
(week 21–27 Sep 2026 = 26:50; window = 94:50, shares 40.6/36.1/10.3/8.8/4.2),
plus a DST-change week in Europe/Amsterdam and an entry crossing midnight.

---

## T5. Timesheets row reader: render from rows in the drive

**Labels:** timesheets, frontend, blocked · **Depends on:** atomic-server fix
for `hostStore.ts` answering `propVals` while `view-client.js` reads `props`
(see `integrations/timesheets/README.md`, "Host bugs found")

Add `app/rows.ts`: list the data table's children (`store.query` by
`parent`), `getResource` each, map to T4's `Entry`. Subscribe to the table
and re-read after a sync. Until the host fix lands, fall back to the last
sync's projected entries held in memory and say in the PR that the view is
empty after a reload.

Acceptance: `fakeStore.ts` test with 300 rows; state the number of store
round trips per load in the PR. Not verified in a real host until the fix
lands.

---

## T6. Timesheets shell: header, connection bar, status pill, toolbar

**Labels:** timesheets, frontend · **Depends on:** T1, T2

Replace `app/main.ts`'s three elements with `app/ui/shell.ts`: header row
(mark, "Timesheets", source chip, pill, Sync now), connection bar (account,
window as dates, entry count, Settings), toolbar (week navigator, view
switcher as `role="tablist"`, week total). One `role="status"` region
announces pill changes. Next week is disabled on the current week. View and
week live in memory only.

Acceptance: renders each controller state from T2 without throwing (DOM test
with the lane's test environment); matches frames A, B, C header and toolbar.

---

## T7. Timesheets Week grid view

**Labels:** timesheets, frontend · **Depends on:** T4 (types), T6 to mount

`app/ui/week.ts`: `<table>` with `<caption>`, `th scope`, today tint, en dash
for zero, row and footer totals, billable line, running-timer note (from T3's
`skippedRunning`), hatched out-of-window days with the accessible name from
DESIGN.md §6L. Non-empty cells are buttons that switch to Entries at that day
with the project's rows highlighted. Grid scrolls in its own container.

Acceptance: frames A, L and O.

---

## T8. Timesheets Entries (day list) view

**Labels:** timesheets, frontend · **Depends on:** T4, T6 to mount

`app/ui/entries.ts`: day cards (day name, total), entry rows as buttons
(description or "(no description)", project dot + name, `$` with "Billable"
text, time range, duration). Accepts a `highlight` (day + project) from T7.

Acceptance: frame B; clicking a row calls the drawer opener from T10 (stub
until T10 lands).

---

## T9. Timesheets Projects summary view

**Labels:** timesheets, frontend · **Depends on:** T4, T6 to mount

`app/ui/projects.ts`: summary line (total, billable, not billable), one row
per project with bar scaled to the largest, billable segment, total, share.
Hides the week navigator and shows the window range instead.

Acceptance: frame C, numbers from T4's tests.

---

## T10. Timesheets entry detail drawer (read-only)

**Labels:** timesheets, frontend · **Depends on:** T4

`app/ui/detail.ts`: drawer at ≥ 720px, full sheet below. Fields, provenance
text, "Open row in Atomic", "Open Clockify" (`https://app.clockify.me/tracker`).
Focus to heading on open; Esc / close returns focus to the opener; focus is
kept inside while open.

Acceptance: frames D and E (right); a keyboard test for focus return.

---

## T11. Timesheets set-up, empty and error states

**Labels:** timesheets, frontend · **Depends on:** T1, T2 (T6 to mount)

`app/ui/states.ts`: first run (F), waiting on consent (G1), workspace and
window form (G2), first-import skeleton with progress text (H), empty (I),
error banners for each kind in DESIGN.md §6J with the recovery actions, and
no-relay (K). Banners keep data visible below them. 429 disables Try again
until `retryAfterSeconds` (default 60) has passed.

Acceptance: frames F, G, H, I, J, K; each error kind rendered from a
controller state in a DOM test.

---

## T12. Timesheets settings sheet and disconnect

**Labels:** timesheets, frontend · **Depends on:** T2

`app/ui/settings.ts`: account (read-only), workspace select, window, time
zone (read-only), Save / Cancel, and Disconnect with inline confirmation
("The N entries already imported stay"). Disconnect clears the App's
connection properties.

Needs a host op to forget the connection in the browser
(`store.proxy.disconnect`), which does not exist; this issue only clears the
App side and states that gap in the PR. File the host op separately against
atomic-server (feat/plugin-debug) if wanted.

Acceptance: frame M.

---

## T13. Timesheets narrow layout (< 560px)

**Labels:** timesheets, frontend · **Depends on:** T7, T8

Below 560px (container width via `ResizeObserver` on `root`, not the
viewport, since the frame width is the host's): week strip `role="tablist"`
over the selected day's entries; source chip moves into the connection bar;
Sync now becomes an icon button with the same accessible name. 560–719px:
grid without the client line.

Acceptance: frame E at 360px and frame L at 560px; no horizontal page scroll
at 360px.

---

## T14. Timesheets accessibility pass and DOM tests

**Labels:** timesheets, frontend, a11y · **Depends on:** T6–T13

Check against DESIGN.md §8: table semantics, spoken durations, no
colour-only signals, focus rings, reduced motion, status announcements not
repeated. Run axe-core in the lane's DOM test environment if it can be added
as a dev dependency inside `integrations/timesheets/`; otherwise list the
manual checks done. State contrast figures measured with the host's default
tokens in both themes.

---

## Later (not v1; file only when decided)

### T15. Timesheets two-way edit and conflict review

**Depends on:** a lens write path, a proxy catalog entry allowing `PUT` on
Clockify time entries, and a decision to write to Clockify at all. Layout is
reserved in frame N.

### T16. Timesheets running timer display (then start/stop)

Show the running entry read-only from the sync's data; start/stop writes to
Clockify and follows T15's decision.
