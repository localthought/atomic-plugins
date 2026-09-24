# Notion drive plugin: implementation issues

From [`DESIGN.md`](DESIGN.md) and [`mockups.html`](mockups.html) (#89).
Each issue below is written to be filed as-is with
`gh issue create --title "<title>" --body-file <body>`. All work stays inside
`integrations/notion/` (plugin-folder containment). Every issue is read-only
scope unless it says "Later".

Dependency graph (→ means "needs"):

```
N1 shell ─────────────┬─> N5 table ─┬─> N8 peek
N2 controller states ─┤             ├─> N9 board
N3 progress ──────────┘             └─> N11 narrow/list
N4 read rows back ────────> N5, N6, N9, N11
N6 per-database columns ──> N5 (scope chips), N9
N7 option names/colours ──> N5, N8, N9 (pills; ids render until then)
N10 sync details  (needs N2's persisted result)
N12 e2e + fixtures (needs whichever states it covers)
N13, N14 later
```

N1, N2, N3, N4, N6 and N7 have no dependencies on each other and can start in
parallel. N5 can start against N4's interface with a stub.

---

## N1. notion UI: app shell, tokens and injected stylesheet

**Body**

Part of #89; design in `integrations/notion/design/DESIGN.md` §4, §8 and
`mockups.html` (all frames).

Replace `app/main.ts`'s `h1` + `p` + `button` with the shared plugin shell:
header row (mark, name, source-chip slot, status pill, primary action),
connection bar, and the `pl-banner` / `pl-empty` building blocks.

- Inject one `<style>` element from `view()` (the drive plugin is one
  module; no stylesheet file). Copy the `PLUGIN CSS` block from
  `mockups.html` as the starting point.
- `--pl-*` tokens map to host `--t-*` variables with fallbacks, exactly as in
  the DESIGN.md §8 table. No `prefers-color-scheme` in the app: the host
  swaps the values.
- Pure render functions (`renderHeader(state)`, `renderBanner(...)`, …) so
  they are testable in happy-dom/jsdom without the host.
- Width breakpoints via a container query on the app root (`< 640px`,
  `640–959px`, `≥ 960px`), not viewport media queries.

Acceptance:

- Each S1/S2/S3 state renders with the shell, verified by a unit test on the
  DOM output (role, labels, button text).
- `node integrations/notion/app/build.mjs` still produces one `dist/ui.js`;
  record its size in the PR (today about 75 KB).
- Screenshots in light and dark host themes in the PR (atomic-server
  AGENTS.md asks for screenshots on UI PRs).

Not in scope: the table (N5), sync details (N10).

---

## N2. notion UI: controller states for reauth, rate limit, nothing shared; persist last sync

**Body**

Part of #89; DESIGN.md §6 (S4, S5, S11, S12, S13) and §12 gaps 4, 5, 7.

`app/controller.ts` has one failure shape (`last: { ok: false, error }`)
and keeps the last sync in memory only. Extend `ViewState`:

- `importing` (connected, table has no rows yet),
- `no-databases` (search returned zero data sources),
- `reauth` (relay answered 401/403, or `connections()` no longer lists the
  connection),
- `rate-limited` with `retryAt` from `retry-after` (seconds or HTTP date),
- `failed` with a user-facing message and a `technical` string
  (status, path, time).

Classify errors in the transport (`app/transport.ts`) by status, not by
message text. Persist `{ at, created, updated, unchanged, perDataSource,
warnings }` after each sync; proposed location is a JSON string property on
the data table resource (DESIGN.md §12 decision: confirm before merging).
On open, show cached state immediately and sync only when the last sync is
older than 15 minutes or unknown.

Acceptance:

- Unit tests in `app/sync.test.ts`/a new `controller.test.ts` for each
  state, driven by the fake store and a fake transport returning 401, 403,
  429 (both `retry-after` forms), 502, and an empty search.
- Reload keeps "Synced N min ago".
- `describe()`/`action()` updated or replaced; no state has more than one
  primary action.

---

## N3. notion sync: progress callback per data source

**Body**

Part of #89; DESIGN.md S4, S9.

`syncNotion` reports nothing until it finishes. Add an optional
`onProgress({ dataSource, title, phase: 'listing' | 'reading' | 'writing' | 'done', pages })`
called at most once per page of results (Notion returns up to 100 per
query page), never per row. The controller turns it into the pill text
("Syncing… Reading list") and S4's per-database list.

If `readPlatform` in `syncables/browser` cannot report per-request progress,
document that and report at the granularity it does allow (per data source
after read, per row batch during write); do not change `syncables/` in this
issue.

Acceptance: unit test asserting the callback order for the two-row-per-page
fixture (`fixtures/notion/`), and that a thrown error after the first data
source still leaves its rows written.

---

## N4. notion UI: read imported rows back from the drive table

**Body**

Part of #89; DESIGN.md §1 ("the app never shows them"), §7 (open shows
cached rows).

Add a small view model: `loadRows(store): Promise<Row[]>` using
`store.query({ property: parent, value: table })` and `getResource`, mapping
each row to `{ subject, name, dataSource, url, lastEdited, values:
Record<shortname, JSONValue> }` using the column Properties the sync created.
Subscribe to the table (`store.subscribe`) so rows added by a sync appear
without reload.

Measure and state in the PR: time to load 45, 500 and 2 000 rows with the
fake store, and the number of `getResource` calls (one per row today; note
whether the host offers a batched read).

Acceptance: unit tests with the fake store; no DOM in this issue.

---

## N5. notion UI: table view with type glyphs, sort, search, "show more"

**Body**

Part of #89; DESIGN.md §5, §7; mockups S6, S6·dark, S9.
Needs N1 (shell) and N4 (rows); can start against a stubbed `loadRows`.

- Real `<table>`, `<th scope=col>` with the property-type glyph (the inline
  SVG sprite in `mockups.html`), `aria-sort` on the sorted column.
- Sticky header row and sticky first (title) column; horizontal scroll inside
  its own container.
- Cell renderers per projected type: title, text, number (right-aligned,
  `tabular-nums`), checkbox (check/dash with `aria-label`), url/email/phone
  (link or selectable text), select/status/multi-select (pills; until N7
  lands, show the option id shortened, with a TODO).
- Client-side search over title and text columns (150 ms debounce); sort
  by header click (asc, desc, off); default "Last edited in Notion" desc.
- First 200 rows, then "Show 200 more".
- Row highlight for rows changed by the latest sync (none under
  `prefers-reduced-motion`).

Acceptance: DOM unit tests for sort, search and each cell type; screenshots
at 1160px and 900px, light and dark.

---

## N6. notion sync: per-database column lists and source chips

**Body**

Part of #89; DESIGN.md §5 "Scope", §12 gap 3; mockups S6 vs S9.

Today all databases' columns merge by property id, and two same-named
properties become two indistinguishable columns. Store, per data source,
the ordered list of column shortnames it has (Notion's property order), e.g.
as a JSON property on the data table resource next to N2's sync record.

UI: header chips "All N" + one per database with its row count (N1 slot).
A database chip shows exactly its columns; "All" shows Name, Database,
Last edited plus columns whose name _and_ type every database shares.
Chip selection is remembered in `localStorage` (try/catch).

Acceptance: unit test with two data sources whose "Status" properties have
different ids (extend the fixture or add a second one); chip counts equal
row counts.

---

## N7. notion sync: store option names and colours for select, status and multi-select

**Body**

Part of #89; DESIGN.md §1, §8 "Notion option colours"; all pills in the
mockups.

Cells hold option ids (stable across renames, as the README says) — keep
that. Additionally store an option dictionary `{ [optionId]: { name, color } }`
per property, refreshed on each sync from the data source schema (the
search/data source response already carries `options`). The UI resolves ids
to names at render time, so a rename in Notion shows on the next sync
without rewriting every row.

Colour names are Notion's ten (`default`, `gray`, `brown`, `orange`,
`yellow`, `green`, `blue`, `purple`, `pink`, `red`); render with the `c-*`
classes from `mockups.html`. An id missing from the dictionary renders as a
neutral pill "Unknown option" with the id in `title`.

Where the dictionary lives is the same decision as N2's sync record.
Does not change the Devonian lens (`devonian/notion/`).

Acceptance: unit test that a renamed option shows the new name after one
sync with no row writes.

---

## N8. notion UI: side peek (row details) and narrow sheet

**Body**

Part of #89; DESIGN.md §6 S7, S14b, §9; mockups S7, S14b.
Needs N5.

- Wide frames: non-modal `<aside aria-label="Row details">`, 400px, next to
  the table when the table keeps ≥ 520px, otherwise overlaying it.
- Narrow (< 640px): modal `<dialog>`, focus trapped, Esc closes.
- Content: database, title, property list with glyphs, last edited,
  "Open in Notion" (`target=_blank rel=noopener`; if the host sandbox
  blocks it, fall back to selectable URL + copy button and note that in the
  PR), read-only note, and "Not copied from this page" (skipped property
  names and types, formatted text).
- Keyboard: Enter opens, Esc closes and returns focus to the row, ↑/↓ move
  rows while open.

Acceptance: DOM tests for keyboard behaviour and focus return; screenshots
at 1160px and 360px.

---

## N9. notion UI: board view grouped by status or select (read-only)

**Body**

Part of #89; mockup S8. Needs N5's cell renderers, N6 (single-database
scope) and N7 (option order and names).

Columns in Notion's option order, plus "No value" last if any row has none;
card = title + priority/tags + one number; count per column. Disabled on
"All" with an explanation. Group-by defaults to the first status property,
then the first select; a small menu switches. No drag and drop (read-only).

Acceptance: DOM test for grouping and order; screenshot.

---

## N10. notion UI: sync details panel and warning grouping

**Body**

Part of #89; DESIGN.md §5 "Sync details", S10; mockup S10. Needs N2's
persisted sync record (per data source counts and warnings).

Replace the `;`-joined warnings with a panel from the connection bar: last
sync time and duration; per database the counts, "Not copied" property
names by type, grouped warnings (formatted text per property, archived pages
kept, datatype clashes from `ensureColumns`). "Technical details"
disclosure with raw lens errors for bug reports. Pill reads
"Synced · N notes" when there are warnings.

Needs the sync to report _which_ properties were skipped and why; today the
lens silently drops unsupported types. Add that to the sync result
(not to the lens).

Acceptance: unit tests on grouping; screenshot.

---

## N11. notion UI: narrow layout and list view

**Body**

Part of #89; DESIGN.md §10; mocks S14a, S14b. Needs N1, N5.

Below 640px: chips become a `<select>`, connection bar shortens, List is
the default view (card per row: title, status/priority pills, last edited),
targets ≥ 44px. View choice remembered per app in `localStorage`
(try/catch). Table stays available with horizontal scroll and sticky title
column.

Acceptance: screenshots at 360px and 640px; no horizontal page scroll at
360px.

---

## N12. notion e2e: one spec per state, plus mock-proxy fixtures for failures

**Body**

Part of #89. Extends `e2e/notion.spec.ts` and `fixtures/notion/`.

Add mock-proxy scenarios: zero shared data sources, 401 on search, 429 with
`retry-after`, 502, two data sources with clashing property names, a
renamed option between two syncs. Then one Playwright test per state
S2, S4 (or S9), S5, S6, S7, S10, S11, S12, S13, asserting visible text and
roles (not pixels), and saving screenshots as test artefacts.

Acceptance: `platforms: ["notion"]`, `tiers: ["live", "e2e"]` unchanged;
CI green against the pinned `.atomic-server-ref`. Nothing here claims live
Notion evidence.

---

## N13. Later — notion UI: inline edit and "changes not sent" bar

**Body**

Part of #89; DESIGN.md S15; mockup S15. **Blocked** on the Devonian write
bridge (#8 item 2: journalled `PATCH /v1/pages/{id}` through the relay).

Editable cells for the supported subset (README "Supported subset"), an
accent dot on edited cells, and a pending bar ("N changes not sent to
Notion · Review · Discard · Send to Notion"). Nothing is sent without
"Send". A row whose send fails carries its own error. Connection bar reads
"Two-way".

---

## N14. Later — notion UI: conflict review

**Body**

Part of #89; DESIGN.md S16; mockup S16. **Blocked** on N13.

When the Notion page changed since our baseline and a local edit is
pending, mark the row and open a conflict panel: per property, the Atomic
value (who, when) vs the Notion value, a radio per property, "Keep all from
Notion", "Apply and send". Missing pages are conflicts, never deletes
(`model.ts` rules).
