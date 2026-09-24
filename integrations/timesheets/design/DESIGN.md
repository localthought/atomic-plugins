# Timesheets (Clockify): frontend design

Status: proposal for ontola/atomic-plugins#89. Nothing here is implemented.
The screens are drawn in [`mockups.html`](mockups.html) (open it locally in a
browser; no network needed). The implementation breakdown is
[`issues.md`](issues.md).

This document designs the iframe app in `../app/`: the module the host loads
with `view({ root, store })`. It does not change the LocalThought path in
`../localthought.ts`, which `../README.md` already marks for removal.

## 1. What exists today

`app/main.ts` renders three elements: an `<h1>` "Clockify timesheets", a
`role="status"` paragraph, and one "Sync now" button. Behind them:

- `controller.ts` has five states: `loading`, `unconfigured` (the App resource
  lacks `connection-id`, `workspace-id` or `user-id`), `no-proxy`, `ready`,
  `syncing`. A sync result is shown as one sentence ("Synced: 12 created, 3
  updated, 40 unchanged.").
- `sync.ts` imports the signed-in user's completed `REGULAR` entries from the
  last 7 or 30 days into the host's data table, named after the description,
  with `start`/`end` (epoch ms), `billable`, project id/name, member id/name.
  Running timers and breaks are skipped by the lens and not counted anywhere.
- Import only. Nothing is written to Clockify. A row edited in the Atomic
  table is overwritten on the next sync for any field the sync writes
  (`sync.ts` compares and re-sets every projected field).
- Connecting is not possible from inside the app: `unconfigured` tells the
  user to go to the Integrations page. The notion app (`../../notion/app/`)
  already uses the newer `store.proxy.connections()` / `store.proxy.connect()`
  flow; timesheets does not.
- The app never reads the rows it wrote back for display. The README records
  a host bug (`hostStore.ts` answers with `propVals`, `view-client.js` reads
  `props`) under which `resource.get()` returns `undefined` in a real frame.
  Not re-verified for this design.

So today the user sees whether an import happened, never what was imported.
Every screen below except the connect and error states is new.

## 2. Users and core jobs

The user is one person who tracks time in Clockify (timer or manual entry)
and wants that time in their own Atomic Server: to reference it from
invoices, notes or project pages, to keep a copy they control, and to see it
next to their other data. Clockify stays where they _track_; this app is
where they _look back_.

Jobs, in priority order:

1. **"How much did I work this week, and on what?"** Week total, per-day
   totals, per-project totals. This is Clockify's Timesheet page and
   Harvest's week view; both answer it with a project × day grid.
2. **"What exactly did I do on Tuesday?"** A day-grouped list of entries
   with times and descriptions (Clockify's Time Tracker list, Toggl's List
   view, Harvest's Day view).
3. **"Is my copy current?"** When the last import ran, what it covered, and
   what it did not bring over (running timers, entries outside the window).
4. **"How is the month split across projects and billable time?"** A
   per-project summary for the whole import window.
5. **Set-up and recovery**: connect, pick a workspace, choose the window,
   reconnect after a revoked key.

Out of scope as jobs for now: starting or stopping timers, entering or
editing time, approvals, team timesheets, rates and amounts. Those are what
Clockify itself is for; §9 says which of them could come later.

## 3. What the competitors do, and what we take

Sources: Clockify Help "Timesheet"
(https://clockify.me/help/track-time-and-expenses/timesheet-view); Toggl
Track Knowledge Base "The Timer Page"
(https://support.toggl.com/the-timer-page); Harvest Help Center
"Submitting and approving timesheets"
(https://support.getharvest.com/hc/en-us/articles/360048181832-Submitting-and-approving-timesheets).
Read September 2026 from public help pages. Not verified against logged-in
accounts, so details such as exact cell formats are from documentation, not
observation.

| Pattern                                                      | Clockify          | Toggl Track                     | Harvest    | Here                               |
| ------------------------------------------------------------ | ----------------- | ------------------------------- | ---------- | ---------------------------------- |
| Week grid: project rows × day columns, row and column totals | Timesheet page    | Timesheet view (with approvals) | Week view  | **Yes, default view**              |
| Day-grouped entry list with day totals                       | Time Tracker page | List view                       | Day view   | **Yes, "Entries" view**            |
| Week navigator (previous / next / this week)                 | top right         | date-range picker + arrows      | arrows     | **Yes**                            |
| Day-totals strip above one day's entries                     | no                | sidebar stats                   | week strip | **Yes, as the narrow layout**      |
| Project colour dot next to project name                      | yes               | yes                             | no         | **Yes, always with the name**      |
| Billable marker                                              | `$` icon          | `$` icon                        | reports    | **Yes, `$` plus text alternative** |
| Timer bar at the top                                         | yes               | yes                             | yes        | **No** (import only; §9)           |
| Calendar (time-of-day) view                                  | yes               | yes                             | no         | **No** (later, §9)                 |
| Approval / submit week                                       | paid plans        | paid plans                      | yes        | **No**                             |
| Copy last week, templates                                    | yes               | favourites                      | yes        | **No** (they create time)          |

Where this app should do better than a plain mirror: every view says which
dates the local copy covers, and a week partly or fully outside the import
window says so instead of showing zeros that read as "no work".

## 4. Shared visual language (with the sibling designs for #89)

Aligned with the Money design (`integrations/money/design/`, written in
parallel) so every plugin frame looks like one family. If that document and
this one disagree, reconcile to whichever lands first; this section states
what Timesheets assumes.

**Tokens.** All colour comes from `--pl-*` custom properties on the app
root, each mapped from the theme variables the host already posts into
plugin frames (`__atomic_style`, built by `useCreateThemeVars.ts` in
atomic-server's data-browser and applied by `plugin_ui.rs`; read on the
pinned atomic-server checkout, not observed in a running host):

| Token              | Host variable                               | Fallback light / dark (standalone only)    |
| ------------------ | ------------------------------------------- | ------------------------------------------ |
| `--pl-bg`          | `--t-color-bg-body`                         | `#fafafa` / `#000000`                      |
| `--pl-surface`     | `--t-color-bg`                              | `#ffffff` / `#000000`                      |
| `--pl-subtle`      | `--t-color-bg-1`                            | `#f2f2f2` / `#1a1a1a`                      |
| `--pl-border`      | `--t-color-bg-2`                            | `#cccccc` / `#4d4d4d`                      |
| `--pl-text`        | `--t-color-text`                            | `#000000` / `#ffffff`                      |
| `--pl-muted`       | `--t-color-text-light`                      | `#666666` / `#999999`                      |
| `--pl-accent`      | `--t-color-main`                            | `#1b50d8` / same                           |
| `--pl-accent-soft` | `--t-color-main-selected-bg`                | light tint / dark tint of main             |
| `--pl-neg`         | `--t-color-alert`                           | `#cf5b5b`                                  |
| `--pl-warn`        | `--t-color-warning`                         | `#f5a623`                                  |
| `--pl-pos`         | none                                        | `#2f8f5b` (the host has no success colour) |
| `--pl-radius`      | `--t-radius`                                | `9px`                                      |
| font               | `--t-font-family`, `--t-font-family-header` | system-ui                                  |

Dark mode is the host swapping these values, so the frame needs no
`prefers-color-scheme` logic of its own; the fallbacks exist for the
standalone mockups and tests. Consequences: `--pl-warn` (#f5a623) is too light
for text on white, so warning banners use it only as a tinted background
(`color-mix` at 12%), border and icon, with text in `--pl-text`; `--pl-neg` (#cf5b5b) on white is about 4:1, so
error text is bold 14px+ or uses `--pl-text` with a `--pl-neg` icon. The
Money, Notion, Calendar and Issue-tracker designs use the same names;
Issue-tracker calls the `bg-1` token `--pl-sunken` where Notion and this
document say `--pl-subtle` (**to reconcile**, trivial).

**Header row.** `[plugin mark + name] [source chip] … [status pill] [primary action]`.
For Timesheets: a clock mark, "Timesheets", one chip "Clockify · <workspace>",
the status pill, and "Sync now".

**Status pill.** One of: `Not connected` (muted), `Syncing…` (accent, pulsing
dot, static under `prefers-reduced-motion`), `Synced 4 min ago` (pos),
`Sync failed` (neg), `Reconnect needed` (warn), `Offline` (muted, host cannot
relay). The Money design names the same states as a `data-state` attribute
(`idle|syncing|synced|paused|reauth|error`); `Offline` maps to `paused`. The
pill is the only place the sync state lives in the header; the
same text goes to one `role="status"` region, so screen readers hear each
change once.

**Connection bar.** One line under the header: who is connected, the
import window as real dates ("Importing 25 Aug – 24 Sep, your entries
only"), and a "Settings" button. It wraps to two lines below ~520px.

**Empty state.** Centred in the content area: a line icon, one sentence
saying what is empty and why, one primary button, optionally one text link.

**Error.** An inline banner at the top of the content area (never a modal,
never a toast that disappears): what went wrong in the user's terms, one
recovery button, and a "Details" disclosure with the raw provider status and
message for bug reports. Data already on screen stays visible under it.

## 5. Information architecture

```
Header row      Timesheets · [Clockify · Studio Veldkamp] ····· (● Synced 4 min ago) [Sync now]
Connection bar  Mira Janssen · importing 25 Aug – 24 Sep, your entries only · Settings
Toolbar         [‹] 21 – 27 Sep 2026 [›] [This week]    (Week | Entries | Projects)    Week 26:50
Content         one of the three views
Drawer          entry detail (overlay)
Sheet           settings (overlay)
```

- **Week** (default): project × day grid for the selected week.
- **Entries**: the same week as a list grouped by day, newest day first.
- **Projects**: the whole import window, one bar per project, billable split.
- Week and Entries share the week navigator. Projects hides it and states its
  range instead ("25 Aug – 24 Sep, the whole import window").
- The selected view and week live in memory for the life of the frame. The
  frame is null-origin with no storage, so they reset on reload. They are
  not stored on the App resource: that would be a signed write per click,
  readable by anyone who can read the App.

## 6. Screens and states

Letters match the frames in `mockups.html`.

### A. Week (populated, default)

- Rows: one per project with time in the week, sorted by week total,
  descending. Row label: colour dot + project name, client name muted under
  it. Entries with no project form a final "No project" row.
- Columns: seven days starting on the user's Clockify week start
  (`/api/v1/user` → `settings.weekStart`; Monday when unavailable). Today's
  column is tinted. A final "Total" column.
- Cells: `h:mm`, tabular numerals, right-aligned. Zero is an en dash in the
  muted colour, not "0:00", so the eye finds worked time.
- Footer row: day totals and the week total, bold.
- Under the grid: "Billable 21:15 · Not billable 5:35".
- Clicking a non-empty cell switches to Entries scrolled to that day, with
  that project's rows highlighted. A popover was considered; one fewer
  overlay keeps focus handling simple.
- If the last sync saw a running timer: a muted note above the grid, "1 timer
  is running in Clockify. It appears here after you stop it and sync."
  Needs the sync to count skipped running entries (gap 4, §10).

### B. Entries

- Day header: "Thursday 24 Sep", day total right-aligned.
- Row: description (or "(no description)" muted), project dot + name, `$`
  when billable, time range `12:15 – 14:15`, duration `2:00`. Each row is a
  button that opens the detail drawer.
- Days without entries are omitted.
- Expected size: tens to a few hundred entries per 30-day window for one
  person. `clockifyApi.ts` stops at 200 pages of 50 (10,000 entries). No
  virtualisation is planned; rendering has not been measured above the
  mockup's sample size.

### C. Projects

- One row per project across the import window: dot, name, client, a
  horizontal bar scaled to the largest project, the total `h:mm`, and its
  share of the window's total as a percentage with one decimal.
- A summary line above: total, billable, not billable.
- The bar is the project's colour at reduced opacity with a full-opacity
  billable segment. The numbers carry the meaning; the bar only helps scan.

### D. Entry detail (drawer)

- Opens from the right at widths ≥ 720px; a full-height sheet below that.
- Shows description, project and client, date, start, end, duration,
  billable, member, and a provenance block: "Imported from Clockify, last
  checked 24 Sep 14:03. Changes made in Clockify replace this copy on the
  next sync."
- v1 is **read-only**. One external link, "Open Clockify", to
  `https://app.clockify.me/tracker`. Clockify documents no per-entry URL;
  not verified that one exists.
- "Open row in Atomic" links to the row resource, where the user can add
  their own properties. Today's sync only sets the fields it projects, so
  added properties survive a sync; that is observed from the code, not a
  tested guarantee. **Decision needed:** make it one (a test in `sync.test.ts`).

### E. Narrow (360 – 559px)

- Seven day columns plus a project label do not fit at 360px. Below 560px
  the Week view becomes a **week strip** (seven buttons: weekday letter,
  date, day total) above the selected day's entry list. The strip is a
  `role="tablist"`, the list its `tabpanel`.
- The source chip moves into the connection bar; "Sync now" becomes an icon
  button with the same accessible name.
- Projects keeps its layout, with bars under the names.

### F. First run: not connected

Centred card: what it does ("Copies your Clockify time entries from the last
7 or 30 days into this drive, so you can see and link them here"), what it
needs ("a Clockify API key, entered on the next page; this app never sees
it"), what it does not do ("Nothing is written to Clockify"), and one button,
**Connect Clockify**, which calls `store.proxy.connect({ platform: 'clockify' })`.

### G. Connecting, then workspace and window

- While the host's consent bar is open: "Finish connecting in the bar above
  this app", and the button becomes a disabled "Waiting…". Cancelling returns
  to F with no error.
- After connecting, if the key sees more than one workspace: a radio list of
  workspaces and a segmented control "Last 7 days / Last 30 days" (30
  preselected, since it fills four weeks of the Week view), then **Import
  entries**. With one workspace, only the window is asked.
- Stored on the App resource as `workspace-id`, `user-id`, `lookback-days`
  (`ontology.ts` already defines them).

### H. First import (syncing, no data yet)

A skeleton in the shape of the Week view plus a progress line under the
connection bar: "Fetching time entries… page 2", then "Saving 61 entries… 24
of 61". Needs a progress callback from `syncClockify` (gap 4).

### I. Empty

Connected and synced, zero completed entries in the window: "No completed
time entries between 25 Aug and 24 Sep." Primary **Sync now**; link "Open
Clockify". With a 7-day window, a second line offers "Import 30 days instead".

### J. Errors (banners over existing data)

| Cause, as the sync sees it                    | Banner                                                                                                                 | Recovery                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 401, or the proxy reports the connection gone | "Clockify no longer accepts this connection. The API key may have been deleted or regenerated." (warn)                 | **Reconnect Clockify**             |
| 403 on time entries                           | "This Clockify account cannot read time entries in Studio Veldkamp." (neg)                                             | **Choose another workspace**       |
| 429                                           | "Clockify asked for fewer requests. Try again in 30 seconds." (warn; seconds from `retry-after` when relayed, else 60) | **Try again**, disabled until then |
| network or proxy unreachable                  | "Could not reach the integration proxy. Your imported entries are still here." (neg)                                   | **Try again**                      |
| projects or users 403/404 (a warning today)   | "Project names could not be loaded, so some entries show a project id." (warn)                                         | dismiss only                       |
| more than 200 pages                           | "Clockify returned more than 10,000 entries for this window, the most this app imports at once." (neg)                 | **Import 7 days instead**          |

The pill becomes `Sync failed` or `Reconnect needed`. The data below stays:
it is the last good copy, and the connection bar keeps "Last synced 2 h ago"
so its age is visible.

### K. Host cannot relay

`store.proxy` missing: "This Atomic Server can't connect apps to Clockify
yet. Entries imported earlier are still shown." No button; Details names the
missing host capability for an admin. Existing rows still render, read-only,
with the pill `Offline`. (Depends on the row reader, gap 1.)

### L. Week outside the import window

Navigating to a week that starts before the window shows a muted band above
the grid: "Before 25 Aug is outside your 30-day import window. Only entries
imported earlier are listed." In a partial week, the days before the window
are hatched and their column headers' accessible names say "outside import
window". With a 7-day window, the band offers "Import 30 days".

**Decision needed:** sync never deletes, so rows imported earlier still
exist for old weeks. Show them (they are real data the user owns) or hide
them (to avoid a week that looks complete but is not)? This design shows
them under the band.

### M. Settings (sheet)

Workspace (select), window (7 / 30 days), connected account (read-only),
the time zone used for grouping days (read-only, §7), and **Disconnect**
(danger text button). Disconnect clears the connection reference on the App
resource and asks the host to forget the connection. It does not delete
imported rows; the confirmation says so in one line. **Gap:** there is no
`store.proxy.disconnect()` today (gap 6).

### N. Conflict (later, two-way only)

Only relevant once edits flow back to Clockify (§9). A banner "2 entries
changed in both places" opens a side-by-side compare per entry: field, "In
this drive", "In Clockify", one radio per differing field, and **Keep
selected**. Drawn in the mockups to reserve the layout; not in the v1 issues.

### O. Dark

Same layout; the host sends dark values for the same tokens (§4). Project colours appear only as dots and
bars, never as text colour, so they need no dark variants. Dots get a 1px
`--pl-border` ring so a near-background project colour stays visible.

## 7. Interactions

- **Sync.** On open, if connected and configured, the app syncs once (as the
  notion app does), then only on "Sync now". No background timer. "Sync now"
  is disabled while syncing and keeps its label, so the header does not jump.
- **Week navigation.** `‹` / `›` and "This week". `›` is disabled on the
  current week: no future time is imported. Not bound to global arrow keys,
  because focus may be in the grid.
- **Grid keyboard.** A plain `<table>`; each non-empty cell holds a button,
  so Tab walks them in reading order. Roving-tabindex arrow navigation is a
  later enhancement.
- **Drawer.** Opens on row click or Enter; focus moves to its heading; Esc and
  the close button return focus to the row that opened it.
- **Durations.** Shown as `h:mm` (Clockify's default display). Each entry's
  duration is `end - start` in integer milliseconds; totals sum those
  integers and round to whole minutes only when formatting. A displayed day
  total can therefore differ by one minute from the sum of the displayed
  rows. Decimal hours (`7.42`) are a later setting.
- **Days.** Entries are bucketed by the browser's time zone at their start
  instant; an entry that crosses midnight counts wholly on its start day,
  as Clockify's timesheet does (not verified for Clockify). **Gap:** Clockify
  has a per-user time zone; if it differs from the browser's, an entry near
  midnight can land on a different day here than in Clockify. v1 uses the
  browser zone and shows it in Settings.

## 8. Accessibility and responsive

- Week grid: `<table>` with `<caption>` ("Hours per project, 21 – 27 Sep
  2026"), `<th scope="col">` for days, `<th scope="row">` for projects. Every
  duration has a spoken form ("2 hours 30 minutes") in a visually hidden span.
- Colour is never the only signal: the project dot always has the name next
  to it; billable is `$` with "Billable" as accessible text; the pill has a
  word.
- Contrast: `--pl-text` and `--pl-muted` on `--pl-surface` meet 4.5:1 with
  the host's default values (#666 on #fff is about 5.7:1; #999 on #000
  about 7.4:1; computed, not tool-checked). The host lets users pick a main
  colour, so `--pl-accent` text contrast is not guaranteed; accent is used
  for fills with white text and focus rings, and links also get an underline.
- Focus: a 2px `--pl-accent` outline with 2px offset on every control.
- Motion: only the syncing dot pulses and the drawer slides in; both are
  disabled under `prefers-reduced-motion`.
- Widths: drawn at 360, 560, 760 and 1080px. Breakpoints: < 560 narrow
  (§6E); 560 – 719 grid without the client line, detail as a sheet; ≥ 720
  drawer. Content max width 1200px. No horizontal page scroll; the grid
  scrolls in its own container if a long project name forces it.
- Plain DOM built in `view()`, with one `<style>` element injected into
  `root`: the module ships no stylesheet today and `build.mjs` bundles JS
  only.

## 9. Scope

**Now (v1, the issues in `issues.md`):** states A–M and O; read-only; the
signed-in user's entries; 7- or 30-day window; Clockify only.

**Later, each needing its own decision:**

- Two-way edit of description, project and times, with conflicts (N). Needs
  a write path through the lens and a proxy catalog entry that allows `PUT`
  on time entries. Neither exists.
- Showing the running timer; then start/stop, which writes to Clockify.
- Calendar (time-of-day) view.
- Tags, tasks and clients as linked records; teammates' time; rates.
- Toggl Track and Harvest as further sources. The header's source chip
  anticipates more than one.
- Windows longer than 30 days, or loading an older week on demand.

## 10. Gaps between this design and today's code

1. The view does not read imported rows. It needs a row reader (`store.query`
   by parent, then `getResource`), which depends on the atomic-server
   `props`/`propVals` fix. Until then the view can render from the last
   sync's projected entries held in memory, which are gone after a reload.
2. Connecting: `controller.ts` expects the connection on the App resource and
   has no `connect()`. Move to `store.proxy.connections()` / `connect()` as
   notion does. **Decision needed:** keep storing `connection-id` on the App
   (today), or look it up via `connections()` on every load (notion). The
   second means a different browser shows "Not connected" until the user
   connects there too, because connections live in the browser.
3. The sync fetches no project colour, client name, user week start or time
   zone, and stores no project colour or client. New properties in
   `ontology.ts` (whose URLs are still provisional).
4. The sync reports no skipped running timers or breaks, no progress, and no
   status class (errors are message strings). The table in §6J needs a typed
   error carrying `status` and `retry-after`.
5. No stylesheet and no DOM beyond three elements; the host's `--t-*`
   variables are available to the frame but unused.
6. No `store.proxy.disconnect()` in the host contract.
7. No duration or day-bucketing helpers; the lens yields epoch ms only.
8. The transport predates `syncables/browser`, which notion and pets use.
   Migrating is independent of this design and not required by it.
