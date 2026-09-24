# Clockify (LocalThought)

Clockify runs entirely in the browser through LocalThought: no AtomicServer-side
code, no stored secret, no server-initiated calls to Clockify. The personal API
key (Preferences → **Manage API keys** → **Generate new** at
https://app.clockify.me/manage-api-keys) is entered on LocalThought's consent
page and sealed into a per-connection credential by the integration proxy. The
generic Syncables engine pages through `timeEntries` from the proxy's Clockify
catalog document; `localthought.ts` and the lens it re-exports from
`devonian/clockify/` are the only Clockify-specific code.

## What the lens does

- **Workspace and account picker.** The catalog document only lists time
  entries, so setup reads `/api/v1/workspaces` and `/api/v1/user` through the same
  proxy (`parameterOptions.ts`) and offers them as dropdowns; the account is
  filled in automatically since there is only one.
- **Rolling look-back.** Setup offers the past 7 or 30 days. The window is
  recomputed as `start`/`end` query overrides on every refresh, not frozen at
  installation.
- **Time Tracker projection.** Each completed `REGULAR` entry gets typed
  `start`/`end` timestamps and is named after its description. Running timers
  (no end) and breaks are skipped; the table's own timer owns anything without
  an end. Provider fields stay on the record.
- **Timer view.** The folder's table opens in a Timer view with a derived
  Duration, per-day totals and an "All entries" list — the same views the
  built-in Time Tracker template creates.

Refresh, conflict handling, limits and storage follow the generic LocalThought
flow (see `../localthought/README.md`): import only, local edits preserved,
nothing written back to Clockify.

## Not covered (v1 reductions, see `planning/timesheets.md`)

- Project and Person linked records: Clockify only returns raw `projectId` /
  `userId` strings on entries.
- Tags, tasks, rates, custom fields, active timers; regional/private API
  origins.
- Automatic migration of tables created by the retired server-side plugin.
  They stay readable; reconnect through the Integrations page to start a
  LocalThought folder.

Live account data must never be checked into fixtures.

## Drive-plugin app (`app/`)

`app/` is the replacement for the LocalThought extension path above:
Clockify as an Atomic **App** ("drive plugin"). `app/build.mjs` bundles it
into one ES module (`app/dist/ui.js`, about 52 KB unminified, no imports) that exports
only `view({ root, store })`; the host stores it as the App's entry-point
source and runs it in a null-origin, `allow-scripts`-only iframe
(`plugin_ui.rs`). Plain DOM, no framework, no stylesheet.

- **Connecting.** "Connect Clockify" calls
  `store.proxy.connect({ platform: 'clockify' })`. The host, not the frame,
  draws a consent bar; only a click there starts the PKCE handoff to the
  integration proxy, where the person enters their Clockify API key; the
  proxy keeps it, sealed. The host redeems the handoff (signed with the
  user's key, so the user owns the connection), delegates it to this app
  and navigates back. The app finds the connection with
  `store.proxy.connections({ platform: 'clockify' })`. The app's code and
  the drive never hold a key, token or capability (#21); the frame's
  requests are signed by the host's frame client.
  Connections live at the proxy under the user's agent, so another browser
  signed in as the same user finds the same connection (not tried in the
  e2e, which uses one browser).
- **Setup.** Once connected, the frame reads the account (`/api/v1/user`)
  and its workspaces (`/api/v1/workspaces`) through the proxy and asks for
  a workspace and a 7- or 30-day look-back. It stores only the workspace id,
  the account id and the look-back on the App resource, as three Properties
  (`clockify-workspace`, `clockify-account`, `clockify-lookback-days`).
  "Change settings" reopens the same form.
- **Schema.** A host's `/app-write` rejects a property URL that does not
  resolve to a Property. So `app/schema.ts` creates one Property per field
  under the row class's ontology (inside the app's own subtree), finds them
  again by shortname on later runs, and adds the row fields to the row
  class's `recommends` so the table shows them: `start`/`end` (timestamp),
  `billable` (boolean), `clockify-entry-id`, `clockify-project-id`,
  `project`, `clockify-user-id`, `member` (string). The same pattern as the
  Pets and Notion drive apps.
- **Observation log** (#123 M1, design #97). Once set up, the app syncs on
  open and on "Sync now". Each pass records what it _saw_ in Clockify, not
  what Clockify "is":
  - `clockifyObserve.ts` reads the rolling look-back window, starting 24 h
    earlier (the margin), as one observation: all pages, with its scope
    (workspace, user, `start` in `[from, to)`) and the fields returned.
    Clockify reads the list's bounds as wall-clock time in the user's
    profile time zone, so each pass reads that zone (`GET /user` →
    `settings.timeZone`, `timeZone.ts`) and the workspace's `forceProjects`
    (`GET /workspaces`), sends local wall-clock bounds with a `Z`, and
    records the UTC span they cover. When a bound falls in a repeated DST
    hour, the span recorded is the smaller of the two readings; if the zone
    is unknown, 14 h is taken off each end.
    Each entry is kept canonically: exact instant strings, and every field
    the app does not interpret (`timeZone`, `duration`, …) verbatim in
    `extra`.
  - `observations.ts` (generic, pure) diffs it against the mirror (the
    mask-diff) and folds it in, ordered by `(receivedAt, id)`. An entry a
    complete read no longer returns is only an absence _candidate_; the
    next pass confirms it with `GET /time-entries/{id}`: Clockify's 400
    "Time entry doesn't belong to Workspace" (or a 404 from Clockify) is a
    deletion, 200 restores it (it was skipped between pages, or moved), and
    any other answer leaves the candidate with a warning.
  - `observationLog.ts` stores each non-empty diff as its own resource
    under a log head in the app's subtree, writes a snapshot every 50
    diffs or 256 KB, and keeps everything (nothing is pruned). A pass with
    no change stores no diff; it only confirms the coverage in the head.
  - **Coverage.** Time in the window that no complete read covers is
    _unknown_, never "not worked". Starts are known from where reads
    looked; a moment counts as known only if starts are covered back by
    the longest entry seen (at least 24 h), so an entry longer than the
    margin leaves the window's first part unknown until an older range is
    read.
  - **Rows.** The table's rows are a read-only projection of the mirror
    (#97 answer 2): completed `REGULAR` entries through the one Clockify
    lens (`devonian/clockify/`; running timers and breaks skipped), by
    `clockify-entry-id` among the table's children, with project and user
    names. A row whose entry Clockify confirmed deleted is removed. Edits
    made in the table are overwritten on the next pass; the table's
    description (if it has none) says so.
  - **Status line.** Created/updated/unchanged as before, plus rows
    removed, entries waiting for a re-check, how much of the window is not
    loaded, and whether the workspace requires a project on every entry
    (`forceProjects`: "worked, no project" cannot be written back there),
    each only when it applies.
    Nothing is written to Clockify. Requests are sequential; each is one
    relay round trip.
- **Timeline lens** (#123 M2, read-only). Two stages over the mirror, full
  recompute on every build (not measured; #97 §3.2 estimates single-digit
  ms at 2,000 entries):
  - _Map_ (`devonian/clockify/lens/claims.ts`): each entry becomes at most
    one claim over `[start, end)` with the exact instant strings:
    `worked(P)`, `worked(none)` (no project: a label, not a conflict, #97
    answer 3), a running timer up to now (`open`), and `didNotWork` with a
    badge for `BREAK`, `HOLIDAY` and `TIME_OFF` (the last two are spec enum
    values, never seen live). Locked entries and entries with custom field
    values are flagged.
  - _Aggregate_ (`app/timeline/sweep.ts`): a sweep over the claims and the
    coverage gives non-overlapping segments per local day in the profile
    time zone, from the day holding the window's start up to now; DST days
    are 23 or 25 h. A segment is `unknown` where M1's coverage says so
    (absence candidates included; this wins over any claim), `didNotWork`
    where coverage is complete and no entry claims it, `worked`, `worked`
    - `duplicate` (same project twice), or `conflict`: "unclear which
      project" (different projects, "no project" included) or "unclear
      whether worked" (work overlapping a break, holiday or time off). Each
      segment lists why it would not be editable (running, locked, entry
      type, custom fields, and `worked(none)` under `forceProjects`).
      Sorted throughout, so equal mirrors give equal timelines.
  - _View model_: `app/model/source.ts` fills the #89 views' `Timesheet`
    hooks from it: `unknown` (the window's unknown spans) and `conflicts`
    (`app/timeline/types.ts` `TimelineConflict`: the views' `Conflict` plus
    kind, span, entries and candidates). `app/ui/coverage.ts` renders them
    as a "Not loaded" note and a read-only "Conflicts in Clockify" list.
    Nothing can be resolved from the app yet (M4).
- **Errors.** If the window's first page fails, the pass fails and rows
  are not touched ("Import failed: …. Rows already in the table are
  kept."). If a later page fails, what was read is kept as an incomplete
  observation (no absences, no coverage) and the pass fails the same way.
  A failing re-check `GET` is a warning; the candidate is re-checked next
  time. A 403/404 on projects or users is a warning, and rows keep raw ids.
- **Checked against a live account** (2026-09-24, findings on #123; the
  mock models them): the list's bounds as wall-clock time in the profile
  time zone, the filter on an entry's start in `[start, end)`, newest
  start first with `Last-Page`, a running timer from `PUT` without `end`,
  400 for GET of a deleted entry and 404 for DELETE of one, overlapping
  entries allowed, instants truncated to whole seconds, and 400 without a
  project under `forceProjects`.
- **Not verified live:** how Clockify resolves a bound inside a repeated or
  skipped DST hour (the app assumes the reading that covers least), that a
  deletion between pages really skips an entry (inferred from the order),
  custom fields, and locked entries. Whether atomic-server accepts a
  snapshot of ~1 MB (about 2,000 entries) in one commit is not checked.
  Two devices saving the log head at the same moment can drop one's diff
  from the head (no compare-and-swap on `/app-write`; M5).

```sh
# from an atomic-server checkout with this repo's integrations/ in place (AGENTS.md)
node integrations/tooling/run-lane.mjs timesheets               # typecheck + unit
node integrations/tooling/run-lane.mjs timesheets --tier e2e    # real host + mock proxy
node integrations/timesheets/app/build.mjs                      # -> app/dist/ui.js (git-ignored)
```

### What is verified, and how

- **Unit** (`app/*.test.ts`, mock fixture `fixtures/clockify/scenario.mjs`
  through an in-memory store that rejects unknown properties like the host
  does): setup, schema creation, window, paging, idempotency, updates,
  failures. The observation log's #123 scenarios S1–S5, S8 and S27
  (`app/observationLog.test.ts`), and fold property tests over 40 seeded
  random observation sets (`app/observations.test.ts`): appending equals
  refolding, any permutation folds the same, snapshot + tail equals the
  full fold, two devices' diffs fold the same, fields equal the latest read.
  The timeline's #123 scenarios S1, S6 and S7 (display only), conflict
  kinds, `forceProjects`, the DST days of 29 March and 25 October 2026 in
  Europe/Amsterdam, the rendering hooks, and the merge property over 40
  seeded observation sets (any fold order and record order gives equal
  segments and conflicts) are in `app/timeline/timeline.test.ts`.
- **Host e2e** (`e2e/clockify.spec.ts`, the `timesheets` lane's `e2e` tier)
  against the pinned atomic-server (`.atomic-server-ref`, which includes
  frame capabilities from atomic-server#1697) and the local mock proxy,
  which checks the proxy's 0.2 signatures: connect through
  the consent bar, setup in the frame, Property and row writes through the
  real `/app-write`, 2 completed entries imported (running timer and break
  not), reopen with no duplicates, a changed entry updated in place, the
  window start moving forward between runs (from the mock's request log),
  7 → 30 days adding exactly the older entry, and a 503 that leaves the
  three rows readable in the table and recovers on reopen. Provider changes
  and failures are driven through the mock proxy's local-only
  `POST /__fixture/clockify`.
- **Mock endpoints** (`app/fixture.test.ts`, #123 M0), modelled on
  Clockify behaviour checked against a live account on 2026-09-24 (the
  findings on #123), not on a recording:
  - lists: `start`/`end` are wall-clock time in the user's profile time
    zone (`GET /user` → `settings.timeZone`, Europe/Amsterdam by default
    here); a `Z` or offset is required but ignored; the filter is the
    entry's start in `[start, end)`; newest start first, with `Last-Page`;
  - `GET` one entry, and a 400 "Time entry doesn't belong to Workspace"
    for a deleted or unknown id; `DELETE` of a deleted one is a 404;
  - `POST`, and `PUT` as full replacement (`start` required, fields left
    out cleared, no `end` makes a running timer), instants truncated to
    whole seconds, a 400 without `projectId` when the workspace's
    `forceProjects` is on; overlapping entries are allowed;
  - not checked live, the mock's own choices: 400 on a locked entry, and
    how a wall-clock bound in a repeated or skipped DST hour resolves
    (as java.time's `atZone`);
  - a 404 for any operation the catalog document does not declare, as the
    proxy answers.

  Test switches on `POST /__fixture/clockify`: `settings` (`timeZone`,
  `forceProjects`), `forbid` (403 without applying), `catalog`
  (`readOnly`: the catalog before the write overlay), `applyThenDrop`,
  `failBefore`, `onNextRequest`, `deleteDuringPaging`, `add`, `delete`.
  The app does not write to Clockify.

- **Not verified:** a real integration proxy or a real Clockify account.
  The `/api/v1/...` paths match the mock fixture, not a recorded live
  response. No live evidence is recorded, so every capability here is
  declared, not verified.

### Known host limits (atomic-server)

Read from the pinned atomic-server, and reproduced by the e2e where noted.

- **Stale reads after an app write**: fixed at the current pin. Earlier
  pins kept the page's pre-write copy of a row after an `/app-write`, so a
  second sync in the same page re-saved its own last write. The pin
  (`2f403624e`, with atomic-server#1690) re-reads a resource after an app
  saves it; the e2e now runs "Sync now" twice in one page without reopening.
- **Local-first reads on open** (reproduced, intermittently). The host
  reads memory, then its local database, then the server, so right after a
  reload the App can come back without settings saved moments before. The
  app subscribes to the App and, while it is still asking for settings,
  re-reads them when the host reports a change.
- **Removing a value.** Earlier pins dropped `resource.remove()` in the
  frame. The current pin sends it as an `/app-write` `remove`
  (atomic-server#1690). This app does not remove values, so nothing here
  verifies that path.
- App writes are signed by the node that holds the app's key, so they work
  on one node only for now (#41).

### What still has to happen

1. **Install flow** (#94): catalog entry → the published module → an App
   with its entry point, table and ontology, without the test-side
   `setAppSource` the e2e uses.
2. **Disconnect**: there is no `store.proxy.disconnect()` in the host
   contract.
3. **The designed UI** (week grid, entries, projects; branch
   `claude/design-timesheets`, #89).
4. **Removal** of the LocalThought-extension Clockify path in
   `data-browser`, and pruning `localthought.ts` to what `app/` imports.
