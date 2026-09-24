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

Refresh, conflict handling, limits and storage of this LocalThought path
follow the generic LocalThought flow (see `../localthought/README.md`):
import only, nothing written back to Clockify. For the drive app below, what
happens to edits made in Atomic is its own policy, described under "Local
edits".

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
into one ES module (`app/dist/ui.js`, about 25 KB, no imports) that exports
only `view({ root, store })`; the host stores it as the App's entry-point
source and runs it in a null-origin, `allow-scripts`-only iframe
(`plugin_ui.rs`). Plain DOM, no framework, no stylesheet.

- **Connecting.** "Connect Clockify" calls
  `store.proxy.connect({ platform: 'clockify' })`. The host, not the frame,
  draws a consent bar; only a click there starts the PKCE handoff to the
  integration proxy, where the person enters their Clockify API key. The
  host redeems the handoff, keeps the rotating connection code in its own
  `localStorage`, bound to this app, and navigates back. The app finds the
  connection with `store.proxy.connections({ platform: 'clockify' })`. The
  frame and the drive never hold a code, token or connection id (#21).
  Connections live in one browser: another browser shows "Not connected"
  until the person connects there too.
- **Setup.** Once connected, the frame reads the account (`/api/v1/user`)
  and its workspaces (`/api/v1/workspaces`) through the relay and asks for
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
- **Import.** Once set up, the app syncs on open and on "Sync now".
  `sync.ts` fetches the rolling look-back window (`clockifyImportQuery`,
  recomputed on every run, never stored), plus projects and users for
  naming, runs the one Clockify lens (`devonian/clockify/`) and reconciles
  rows into the app's table by their import identity (`localId` =
  `clockify-time-entry:<id>`; older rows by `clockify-entry-id`), restricted
  to children of that table. Running timers and breaks are skipped by the
  lens. What a refresh may change in an existing row is the "Local edits"
  policy below. Import only: nothing is written back to Clockify, and a
  vanished entry is never deleted. Requests are sequential; each is one
  relay round trip.
- **Errors.** A proxy or Clockify error fails the sync before anything is
  written ("Import failed: …. Rows already in the table are kept."). The
  next "Sync now", or reopening the app, retries. A 403/404 on projects or
  users is a warning, and rows keep raw ids.

```sh
# from an atomic-server checkout with this repo's integrations/ in place (AGENTS.md)
node integrations/tooling/run-lane.mjs timesheets               # typecheck + unit
node integrations/tooling/run-lane.mjs timesheets --tier e2e    # real host + mock proxy
node integrations/timesheets/app/build.mjs                      # -> app/dist/ui.js (git-ignored)
```

### Local edits (#97)

The policy, the same as the Notion drive app's and the sandbox importers':
**an edit made in Atomic is kept; Clockify only overwrites a value nobody
changed in Atomic since the last import; a value changed in both places is
kept as it is in Atomic and reported.** This is a proposal awaiting the
maintainer's decision (see #97); the alternative is Clockify-owned columns.

- Each row stores what it last imported, per column, in the host's import
  metadata (`importBaseline`, with `localId` as identity), the format the
  sandbox importers write through `importRecords`. The server checks every
  such write (`validate_baseline`): a write may only change a value that
  still equals the baseline, so a stale import is refused rather than
  overwriting an edit made in between. `app/reconcile.ts` plans each row.
- Per column: Clockify unchanged → the row's value stays, edited or not.
  Clockify changed and the row not edited → the new value. Both changed →
  the row's value stays, and the status line says "Kept your edits where
  Clockify also changed: <row> (<columns>)" on every sync until the two
  agree. Cleared in Clockify (for example the project removed from an
  entry) and not edited → removed; cleared and edited → kept and reported.
- Project and member names are left alone, not cleared, on a sync that
  could not read the projects or users list.
- Columns added in Atomic are never read or written.
- Rows imported before this policy have no baseline: a column that equals
  Clockify is adopted, any other is reported until the two agree.
- A partial failure converges: every row is written in one save, and a
  removal goes first, so a retry sees either the old row or the new one.
- Removing a cleared value needs the host to remove properties for apps,
  which no host build does yet (see "Known host limits"). The app then warns
  ("Could not clear …") and retries on the next sync; the baseline keeps the
  old value so the leftover is not mistaken for a local edit.

### What is verified, and how

- **Unit** (`app/*.test.ts`, mock fixture `fixtures/clockify/scenario.mjs`
  through an in-memory store that rejects unknown properties like the host
  does): setup, schema creation, window, paging, idempotency, updates,
  failures.
- **Host e2e** (`e2e/clockify.spec.ts`, the `timesheets` lane's `e2e` tier)
  against the pinned atomic-server (`.atomic-server-ref`, which includes the
  relay from atomic-server#1657) and the local mock proxy: connect through
  the consent bar, setup in the frame, Property and row writes through the
  real `/app-write`, 2 completed entries imported (running timer and break
  not), reopen with no duplicates, a changed entry updated in place, the
  window start moving forward between runs (from the mock's request log),
  7 → 30 days adding exactly the older entry, and a 503 that leaves the
  three rows readable in the table and recovers on reopen. Then local
  edits: a row renamed in the table keeps its name while Clockify renames
  the entry too (reported), an unedited row follows a changed billable
  flag, a cleared project is removed or, at a host that cannot remove,
  reported for retry, and a reopen reports the conflict again. Provider
  changes and failures are driven through the mock proxy's local-only
  `POST /__fixture/clockify`.
- **Unit, local edits** (`app/reconcile.test.ts`): every case above, with
  the server's `validate_baseline` ported into the fake store
  (`app/hostRules.ts`), so a plan the host would refuse fails the test.
- **Not verified:** a real integration proxy or a real Clockify account.
  The `/api/v1/...` paths match the mock fixture, not a recorded live
  response. No live evidence is recorded, so every capability here is
  declared, not verified.

### Known host limits (atomic-server)

Read from the pinned atomic-server, and reproduced by the e2e where noted.

- **Stale reads after an app write** (reproduced). The host writes through
  `/app-write`, but the page's store keeps its cached copy of the row, so a
  second sync in the same page reads its own previous write as missing and
  re-saves it. With import baselines the server then refuses that write as
  stale, so the sync fails until the app is reopened; the e2e reopens
  between syncs. atomic-server branch `claude/app-write-refresh` (not yet a
  PR) refreshes the page's copy after each app write; the e2e passes against
  a build of it, but the reopen has not been removed and re-tested there.
- **Local-first reads on open** (reproduced, intermittently). The host
  reads memory, then its local database, then the server, so right after a
  reload the App can come back without settings saved moments before. The
  app subscribes to the App and, while it is still asking for settings,
  re-reads them when the host reports a change.
- **Removing a value does not work for apps** (reproduced). At the pin,
  view-client.js drops the property locally and `save` only sets. The same
  branch sends it as an `/app-write` `remove`, but against a build of it the
  e2e still finds the value on the server afterwards; the server side needs
  a look. The app reports this ("Could not clear …") and retries.
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
