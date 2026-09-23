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

## Drive-plugin app (`app/`, in progress — ontola/atomic-plugins#20)

`app/` is the planned replacement for the LocalThought extension path above:
Clockify as an Atomic **App** ("drive plugin") whose module is fetched once at
install time, stored as the App's `plugin-source` string, and served back by
the host (`plugin_ui.rs`), which calls its exported `view({ root, store })`.
No build-time coupling to `atomic-server` or `data-browser`.

What it does today, covered by unit tests only:

- `sync.ts` fetches the rolling look-back window (`clockifyImportQuery`, the
  same window as above), plus projects and users for naming, runs the one
  Clockify lens (`devonian/clockify/`) over them, and
  reconciles rows into the host's data table (`store.getData()`), or under the
  App when there is none. Identity is a stored `entry-id` found via
  `store.query()`, restricted to children of that table; `create` in
  `app_write.rs` never accepts a caller-chosen subject. Import only: nothing is
  written back to Clockify, and a vanished entry is never deleted.
- The App resource holds only a **connection reference** (`connection-id`,
  `workspace-id`, `user-id`, `lookback-days`; see `ontology.ts`). No connection
  code, token or capability is ever stored or held by the frame (#21).
- All provider traffic goes through `ProxyTransport` (`transport.ts`). The only
  implementation is `hostTransport()`, which feature-detects a `store.proxy`
  op that **no host provides yet**. Without it the app says it cannot sync and
  fetches nothing. There is deliberately no fallback that holds a code.
- `build.mjs` bundles `main.ts` into one ES module (~17 KB, no imports, exports
  only `view`). `@tomic/lib` is aliased to `tomic-lib-shim.ts`, because the lens
  needs only `Datatype.TIMESTAMP` from it.

```sh
# from an atomic-server checkout with this repo's integrations/ in place (AGENTS.md)
node integrations/tooling/run-lane.mjs timesheets   # typecheck + unit, includes app/
node integrations/timesheets/app/build.mjs          # -> app/dist/ui.js (git-ignored)
```

Not verified: the app has not been loaded by a real host. It has not been
tested against the real integration proxy. The `/api/v1/...` request paths
match `localthought/mock-clockify.mjs`, not a live proxy. It is also unknown
whether `/app-write` accepts the provisional property URLs in `ontology.ts`,
which do not resolve.

App writes are signed by the node that holds the app's key, so they work on
one node only for now (ontola/atomic-plugins#41).

### Host bugs found while porting (atomic-server, not fixed here)

Read from `server/src/plugins/assets/view-client.js` and
`browser/data-browser/src/chunks/AppPage/hostStore.ts` on a recent
`atomic-server` branch. Not reproduced in a running host.

- `hostStore.ts` answers `get`/`create` with `{ subject, title, propVals }`,
  but `view-client.js` builds resources from `result.props`. So
  `resource.get(...)` would always return `undefined` in a real frame. This
  app's config read would then report "not connected". Reconciliation avoids
  depending on reads (membership comes from two `query` calls), but without
  reads every run counts every existing row as "updated" and re-saves it.
- `getApp()` resolves to the app's subject string, not an object. The Phase 1
  scaffold typed it as an object.

### What still has to happen outside this repo

1. **Proxy access for the frame** (atomic-server#1624): either a host relay op,
   where the parent's `BrowserIntegrations` performs the call and returns
   `{ status, body }` (the shape `store.proxy` expects here), or a capability
   minted as the app agent against #40's DID-bound connections. #40 is not
   accepted yet.
2. **Install flow**: catalog entry → fetch the built module → App resource with
   `plugin-source`, a data table, and properties for `ontology.ts`, modelled on
   `ConnectPets.tsx`'s `ensureInstallationResource`. The catalog needs a field
   for the module URL, distinct from `pluginUrl`. It is not added yet, and no
   host reads one.
3. **Connect flow in the parent page** (PKCE is a full-page redirect and cannot
   run in the frame), which writes the connection reference onto the App.
4. **Publishing** `dist/ui.js` next to the gh-pages `catalog.json`.
5. **Removal** of the LocalThought-extension Clockify path in `data-browser`,
   and pruning `localthought.ts` to what `app/` still imports.

The Phase 1/2 code on the unmerged branch `claude/hopeful-hawking-kqlrdy`
(`integrations/clockify/app/`) is superseded by `app/` and should not be
merged. It persisted the rotating code on the App resource (#21). No shipped
host ever installed it, so no drive holds that property.
