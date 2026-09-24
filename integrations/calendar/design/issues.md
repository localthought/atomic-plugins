# Calendar plugin — implementation issues

Derived from [`DESIGN.md`](DESIGN.md) and [`mockups.html`](mockups.html)
(issue #89). Each issue is sized to be done in its own branch in parallel
once its dependencies are merged. All code stays inside
`integrations/calendar/` (per-plugin containment); anything that would
belong in a shared package is flagged, not extracted.

Dependency graph (→ means "needs"):

```
C1 scaffold ─┬─ C2 chrome ──┬─ C5 agenda ─┐
             │              ├─ C6 week ───┼─ C8 drawer ── C9 review ── C10 conflicts
             │              └─ C11 errors │
             ├─ C3 transport ── C4 import+picker
             └─ C12 a11y/keys (after C5, C6, C8)   C13 e2e screenshots (after C2, C5, C6)
X1 relay If-Match (atomic-server + proxy) ── C9 send
Later: C14 create event, C15 recurring read-only, C16 Outlook, C17 Apple spike
```

C2, C3 and the pure-function parts of C5/C6 (grouping, column packing) can
start the day C1's types land; the view components can be built against
fixtures from `fixtures/google-calendar/scenario.mjs` without a live
connection.

---

## C1. Calendar: iframe app scaffold and view-state machine

**Labels:** calendar, frontend · **Depends on:** none

Create `integrations/calendar/app/` in the Notion/Pets shape: `main.ts`
exporting `view({ root, store })` (renders nothing on import), `store.ts`
(hand-kept copy of the `PluginStore`/`HostProxy` types, noting
view-client.js is ground truth), `controller.ts`, `build.mjs` producing
`integrations/calendar/plugin.js`, and `build.test.ts`.

`ViewState` covers: `loading`, `no-proxy`, `not-connected`, `connecting`,
`choose-calendars`, `importing` (per-calendar progress), `ready` (with
`pending`, `conflicts`, `last` outcome), `error` (kind: `reauth` | `forbidden`
| `not-found` | `rate-limited` | `network` | `too-many-events`). `describe()`
and `action()` are pure and unit-tested, as in Notion's controller.

Acceptance:

- `node integrations/tooling/run-lane.mjs calendar` passes, including new
  controller tests for every state transition.
- Every `.ts` file starts with `// @wc-ignore-file`.
- The view renders the correct placeholder text for each state (no styling
  yet).

## C2. Calendar: shared plugin chrome and `--pl-*` tokens

**Labels:** calendar, frontend, design-system · **Depends on:** C1

Implement the shared visual language (DESIGN.md §3) as plain-DOM helpers in
`integrations/calendar/app/ui/`: token stylesheet mapping `--pl-*` to host
`--t-*` with fallbacks; header row (icon, title, calendar chips, status pill,
primary action); connection bar with indeterminate progress; empty-state
card; banner (neg/warn/info, one action, Details disclosure); button, pill,
segmented control. One `<style>` element injected by `view()` — the drive
shell loads no stylesheet.

Note in the PR that Money, Timesheets, Notion and Issue tracker designs use
the same chrome; extracting it into a shared module is a separate decision
for the maintainer (containment rule).

Acceptance:

- Screens 5.1–5.3 of `mockups.html` reproduced with real DOM.
- Switching the host theme (re-sent `__atomic_style`) restyles without
  reload.
- `prefers-reduced-motion` stops the spinner and progress animation.

## C3. Calendar: Google Calendar transport through the host proxy

**Labels:** calendar, sync · **Depends on:** C1

Replace the sandbox `Host.read` path for the iframe with
`store.proxy.request({ platform: 'google-calendar', connectionId, path, query, body })`,
following `integrations/notion/app/transport.ts`. Provide a
`CalendarRequest` implementation (the type already in
`devonian/google-calendar/sync.ts`) and a `Host` adapter so `adapter.ts`'s
`preview()`, `planEdit()` and `applyEdit()` are reused unchanged.

Must preserve: `If-Match` on PATCH; 412 surfaced distinctly;
`retry-after` surfaced on 429. **Blocker for writes:** `HostProxyRequest`
(`integrations/notion/app/store.ts`, mirroring atomic-server's
view-client.js) has no request-headers field, so the iframe cannot send
`If-Match` today. Reads work now; the PATCH path needs an atomic-server PR
(against `feat/plugin-debug`) adding an allowlisted `ifMatch` request field,
plus the matching integration-proxy change (duplicated to
`localthought/integration-proxy` for the Heroku deploy). Until then, C9 must
refuse to send rather than PATCH without a precondition.

Acceptance:

- Unit tests with a fake proxy for list pagination (250/page), 401, 403,
  404, 412, 429 with `retry-after`, network failure.
- No credential or `secret:` header appears in any request from the iframe.

## C4. Calendar: calendar picker and multi-calendar import

**Labels:** calendar, sync, frontend · **Depends on:** C2, C3

Add a `calendarList` read (`/users/me/calendarList`), render screen 5.4,
persist the selection on the App resource, and run `preview()` once per
selected calendar, merging changes and conflicts. Keep per-calendar colour,
summary and `accessRole` for chips, swatches and the Read-only tag.
Extend the projection to keep `htmlLink` and the event's `timeZone` (gap 7)
without changing the five-field write mapping. Show per-calendar progress
(screen 5.5) and the "Not shown: N recurring, M cancelled" counts.

Acceptance:

- Importing two calendars writes rows to the table with
  `atomic-calendar-day`/`-end-day`/`-all-day` set as the lens does today.
- Read-only calendars' rows are marked so C8 never offers Edit.
- Skipped recurring/cancelled counts match the fixture scenario.

## C5. Calendar: Agenda view

**Labels:** calendar, frontend · **Depends on:** C2 (C1 for types)

Screen 5.8: day strip, day-grouped list with sticky headers, all-day rows
first ("Day 2 of 3" for multi-day), time column, swatch, title, location or
calendar name, "Not sent yet"/"Conflict" tags. Default below 720px. Pure
grouping function (`agendaDays(events, from, days, zone)`) unit-tested for
exclusive all-day ends and events crossing midnight.

Acceptance:

- Matches mockup 5.8 at 360px in both themes.
- Rows ≥ 48px; every row is a button with a complete accessible name.

## C6. Calendar: Week view

**Labels:** calendar, frontend · **Depends on:** C2 (C1 for types)

Screen 5.7: time grid with hour gutter, all-day row with spanning bars,
overlap column packing (collapse to "+N" below 44px), now line, today tint,
edited (dashed) and conflict ("!") markers, 3/5/7-day widths by iframe width
(DESIGN.md §8), initial scroll to one hour before now. Pure layout function
(`packWeek(events, days, zone)`) unit-tested.

Acceptance:

- Matches mockup 5.7 at 1120px in both themes and degrades per §8 at 720,
  560 and 360px without horizontal scroll.
- Each day column is a labelled `<section>` with a list of event buttons.

## C7. Calendar: Month handoff (or Month view)

**Labels:** calendar, frontend, needs-decision · **Depends on:** C2, and
the maintainer's answer to DESIGN.md §11 decision 1

Default proposal: the "Month" segment opens the host table's existing
`CalendarView` for this table. If the decision is to draw it in the plugin,
this issue becomes a Month grid with the same event chips as C5.

## C8. Calendar: event detail drawer and local edit

**Labels:** calendar, frontend · **Depends on:** C5 or C6 (either one), C4
for read-only/htmlLink data

Screen 5.9: drawer (≥ 720px) / full-screen sheet (< 720px); view mode with
viewer-zone time and event-zone secondary line; "Open in Google Calendar";
edit mode for exactly title, all-day, start, end, location, description;
validation messages mirroring `adapter.ts` `validate()`; local save that
marks the row pending and shows the "Saved here · not sent" strip.

Acceptance:

- Offsets are attached from the viewer's zone; stored values stay
  offset-qualified strings (never floats or Date objects in storage).
- Focus moves to the drawer heading and returns to the invoking event.
- Read-only calendars show no Edit button.

## C9. Calendar: review-and-send sheet

**Labels:** calendar, sync, frontend · **Depends on:** C3, C8, X1 (for the actual send)

Screen 5.10: list pending edits with per-field before/after from
`preview()` + `planEdit()`; per-event Discard; "Send N changes" calls
`applyEdit()` with the preview-time ETag; per-row sending/sent/failed
status; 412 marks only that row "Changed in Google" with "Review again".
Header primary action and status pill open this sheet.

Acceptance:

- Nothing is written to Google except from this sheet.
- A 412 on one event does not stop the others; the baseline advances only
  for events that were sent.
- Blocked on the maintainer's `sendUpdates` decision for the footer copy
  (DESIGN.md §11 decision 3); ship with the current `sendUpdates=all` and
  the "Guests may be notified" line if undecided.

## C10. Calendar: conflicts panel

**Labels:** calendar, sync, frontend · **Depends on:** C9

Screen 5.11: one card per `preview().conflicts` entry; both-changed fields
with unselected "Keep mine"/"Use Google's" options and Resolve enabled only
when all fields are chosen; missing-in-Google card with "Keep as local
event"/"Remove local copy" (local delete only, behind an in-page
confirmation — `confirm()` is not available in the frame); rebound/missing
local row card with "Open row in table".

Acceptance:

- No path deletes a local row without the explicit Remove action.
- Choosing "Keep mine" queues the field for C9's review sheet rather than
  sending directly.

## C11. Calendar: error and reconnect banners

**Labels:** calendar, frontend · **Depends on:** C2, C3

Screen 5.12 and the table in DESIGN.md §5.12: map 401/403/404/429/5xx/
network/too-many-events to banners with one recovery action each and a
Details disclosure; `role="alert"` for 401/403 only; 429 counts down from
`retry-after`; status pill shows "Reconnect needed" on 401.

Acceptance:

- Unit tests map each status to the exact copy in DESIGN.md.
- Existing rows stay visible under every banner.

## C12. Calendar: keyboard shortcuts and accessibility pass

**Labels:** calendar, a11y · **Depends on:** C5, C6, C8

Shortcuts from DESIGN.md §6 (`t`, `←`/`→`, `j`/`k`, `a`/`w`/`m`, `Enter`,
`e`, `Esc`, `?` overlay), inactive inside text fields. Axe (or equivalent)
check on each screen; contrast check of event tints against `--pl-text` for
Google's 24 default calendar colours in both themes.

Acceptance:

- Zero axe violations at 360px and 1120px, light and dark.
- Any Google default colour whose tint fails 4.5:1 is listed with the
  adjusted tint percentage used for it.

## C13. Calendar: responsive and theme e2e screenshots

**Labels:** calendar, e2e · **Depends on:** C2, C5, C6

Playwright run (in the calendar lane's e2e tier, see
`integrations/LIVE_TESTING.md`) rendering the plugin against fixture data at
360, 720 and 1200px iframe widths in light and dark host themes, asserting
no horizontal scroll and saving screenshots as CI artifacts for review
against `design/mockups.html`.

## X1. Host proxy relay: forward `If-Match` on write requests (outside this repo)

**Labels:** atomic-server, integration-proxy · **Depends on:** none · **File
in:** ontola/atomic-server (PR against `feat/plugin-debug`), then bump
`.atomic-server-ref` in its own PR; proxy change duplicated to
`localthought/integration-proxy`.

`HostProxyRequest` has no request headers, so an iframe app cannot make a
conditional write. Add an optional `ifMatch: string` field to the relay
request in view-client.js, forwarded as `If-Match` by the proxy (and only
that header). Needed by Calendar's review-and-send (C9); likely useful to any
two-way plugin that writes with ETags.

---

## Later (file when scheduled)

### C14. Calendar: create event (local, sent via review)

Depends on C8, C9. The manifest declares `create_event`, but `adapter.ts`
has no create path in `preview()`/`applyEdit()`; add `planCreate` +
`applyCreate` (POST, then bind the returned id/ETag) and a "New event"
button / click-empty-slot interaction.

### C15. Calendar: recurring events, read-only

Depends on C4, C6. Use `calendarRecurrenceProjection` to display series
occurrences with a lock icon and "Edit in Google Calendar"; replace the
"Not shown" count. Reverse sync of recurrence stays out of scope.

### C16. Calendar: Outlook Calendar via Microsoft Graph

Needs a Graph OpenAPI overlay in `localthought/overlays`, a proxy OAuth app
(and the Heroku `localthought/integration-proxy` deploy), and a second
adapter with the same `Projection`. The UI needs only a provider tile and a
provider mark in the connection bar.

### C17. Calendar: Apple Calendar spike

Blocked on DESIGN.md §11 decision 4 (app-specific password in the proxy vs
read-only `.ics` URL vs drop). Output: a short written recommendation, no
UI code.
