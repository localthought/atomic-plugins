# Plugin readiness

What each plugin in this repo can do today, where a user would install it,
and what evidence backs that. Checked against atomic-plugins `main` and the
pinned atomic-server commit in [`.atomic-server-ref`](../.atomic-server-ref)
(`bae5cdbe3`, `feat/plugin-debug`, 2026-09-23). When the pin or a plugin
changes, update this file in the same PR.

Evidence levels are kept apart. None of them implies the next one:

- **Declared**: catalog copy (`catalog.json`) or a package's
  `atomicCertification.capabilities`. A claim, not a result.
- **Unit**: Vitest against synthetic fixtures or a fake host store, in CI.
- **Host E2E**: Playwright against the pinned atomic-server with the shared
  mock proxy standing in for the provider, in a CI lane.
- **Live**: against the real provider through a real integration proxy.
- **Historical**: evidence from a runtime or host UI that the pin no longer
  has. It is kept for context and is named with the runtime it exercised.
  It does not certify the current code path.

## What the pinned host offers

These facts decide the "Install entry point" column below. Each one was
read from the atomic-server source at the pin.

- **Integrations page.** It lists only this server's own published Listings
  (`GET /plugin-catalog`), each opening an installation review. It fetches
  this repo's `catalog.json` from GitHub Pages
  (`https://ontola.github.io/atomic-plugins/integrations/catalog.json`,
  configurable in Settings → Integration), but only reads `shortname`,
  `enabled`, `experimental` and `requires-api-plugins`. Those flags decide
  whether the "Show experimental plugins" toggle is shown; an entry with
  `requires-api-plugins` does not count. No catalog card, name or copy is
  rendered (`pluginCatalog.ts`, `IntegrationStore.tsx`).
- **Drive apps.** `New app` creates an App whose entry point's source can be
  replaced. The app's view runs in a null-origin iframe. It reaches the
  integration proxy only through the host relay, `store.proxy.request`,
  `.connections` and `.connect` (ontola/atomic-server#1657). The top page
  holds the connection and draws the consent bar. No UI installs a drive
  app from the catalog; the E2Es below install test-side
  ([#94](https://github.com/ontola/atomic-plugins/issues/94)).
- **Sandbox plugins.** The QuickJS/WASM runtime is present
  (`server/src/plugins/js_runtime.rs`). The generic ways in are a published
  Listing, a plugin zip upload and a `New plugin` draft. None of this repo's
  bundles is published as a Listing, and none has been installed through
  the other two at this pin.
- **Removed.** atomic-server `4bab16ee6` removed the per-plugin setup UI
  (`ConnectPets`, `ConnectNotion`, the MT940 upload dialog
  `ImportMT940`, `IntegrationDiscovery`) and the Rust sandbox tests named in
  `package.json` `atomicCertification.sandboxTests`. `ce0087321` (#1612)
  removed the in-browser Devonian demo. `f3efedf65` removed the Todoist and
  Clockify lens hooks and the Moneybird picker. `c707ca4ed` removed the
  LocalThought connect dialog and sync panel; the data-browser no longer
  imports `integrations/localthought/`.

## Matrix

| Plugin (catalog id)                            | Runtime of the current code                                                                                   | Install entry point at the pin                                                                                                                                                                                                            | Import / write scope (declared)                                                                                 | Evidence                                                                                                                                                                                                                                              | Open blockers                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pets, drive app (`pets`)                       | Drive app `pets/app/`: iframe, `syncables/browser` over the host relay                                        | None in UI. Host E2E installs test-side (`setAppSource`)                                                                                                                                                                                  | Read-only. Pets from the mock `pets` platform into the app's own table                                          | Unit; **Host E2E** (`pets` lane: connect, 5 rows, datatypes)                                                                                                                                                                                          | [#94](https://github.com/ontola/atomic-plugins/issues/94) install from catalog                                                                                                                  |
| Pets, static demo (`pets`)                     | Sandbox `pets/plugin.js`, no network                                                                          | None. Its setup dialog was removed in `4bab16ee6`                                                                                                                                                                                         | Five static pets into a Pets table                                                                              | Unit; `certify.mjs --layer js`. Historical: Rust sandbox test (removed from atomic-server in `4bab16ee6`)                                                                                                                                             | None filed; the catalog card still describes this demo, not the drive app                                                                                                                       |
| Notion, drive app (`notion`, `enabled: false`) | Drive app `notion/app/`: iframe, `syncables/browser` + Devonian `AtomicLens` over the relay                   | None in UI. Host E2E installs test-side                                                                                                                                                                                                   | Read-only. Every shared data source into one table; plain fields only                                           | Unit; **Host E2E** (`notion` lane: connect, 3 rows, column datatypes, formatted-text warning). No live run                                                                                                                                            | [#94](https://github.com/ontola/atomic-plugins/issues/94), [#97](https://github.com/ontola/atomic-plugins/issues/97) local edits, [#8](https://github.com/ontola/atomic-plugins/issues/8) write |
| Notion, two-way pilot (`notion`)               | Sandbox `notion/plugin.js`                                                                                    | None. `ConnectNotion` was removed in `4bab16ee6`                                                                                                                                                                                          | Two-way on one data source: plain fields, property names, table/board view subset (`package.json` capabilities) | Unit; `certify.mjs --layer js`; `live` tier runs the installer against the pinned server with Notion stubbed. Historical: live UI import and title edits via `ConnectNotion`                                                                          | Retire once a drive-app write bridge has live evidence ([#8](https://github.com/ontola/atomic-plugins/issues/8))                                                                                |
| Clockify (`timesheets`)                        | Drive app `timesheets/app/`: iframe, own Clockify client over `store.proxy.request`                           | None. The app has no connect or setup step yet                                                                                                                                                                                            | Read-only. Completed entries, past 7 or 30 days                                                                 | Unit (fake store) only. Historical: `clockify-import.spec.ts`, which drove the retired LocalThought extension flow                                                                                                                                    | [#96](https://github.com/ontola/atomic-plugins/issues/96), [#94](https://github.com/ontola/atomic-plugins/issues/94), [#97](https://github.com/ontola/atomic-plugins/issues/97)                 |
| Bank statements (`money`)                      | Sandbox `money/plugin.js`, file handed over as `ctx.upload`, no network                                       | Draft from a published release (Integrations → Community plugins → Create draft), then Set up and Import on the plugin page (atomic-server#1653's `accepts`/`destination`, in the pin). Publishing the bundle to a server is manual (#94) | Import only. MT940 ≤ 512 KB, camt.053 ≤ 5 MB, ≤ 500 transactions                                                | Unit; `certify.mjs --layer js`; host E2E `money/e2e/money.spec.ts` (synthetic MT940/camt.053: import, reload, reimport, local edit, conflict, refused files). Historical: a real 272-transaction bunq MT940 export through `ImportMT940` (2026-09-11) | [#94](https://github.com/ontola/atomic-plugins/issues/94)                                                                                                                                       |
| Google Calendar (`devonian-google-calendar`)   | Libraries only: `calendar/adapter.ts` and the lens `calendar/devonian/google-calendar/`                       | None. No host code reaches it at the pin                                                                                                                                                                                                  | Declared: single non-recurring events in, reviewed edits out                                                    | Unit. Historical: live import (2026-09-09, proxy v39) through the retired LocalThought snapshot importer                                                                                                                                              | [#101](https://github.com/ontola/atomic-plugins/issues/101)                                                                                                                                     |
| Todoist (`devonian-todoist`)                   | Library only: `issue-tracker/todoist.ts` projection                                                           | None. Its host hook was removed in `f3efedf65`                                                                                                                                                                                            | Declared: read-only, active tasks and projects                                                                  | Unit. Recorded-fixture tests skip until a recording exists                                                                                                                                                                                            | [#99](https://github.com/ontola/atomic-plugins/issues/99), [#46](https://github.com/ontola/atomic-plugins/issues/46)                                                                            |
| GitHub issues (no catalog entry)               | Libraries: Devonian lens and bridge in `issue-tracker/devonian/github-issues/`; sandbox `plugin.ts` there too | None. Its demo host was removed in #1612                                                                                                                                                                                                  | Two-way design for one repository: title, body, open/closed, `atomic:doing` label                               | Unit; opt-in `*.live.test.ts` (need `GITHUB_TOKEN` and a test server; not run in CI). Historical: live GitHub read (2026-09-09, proxy v38) via the retired server flow                                                                                | [#100](https://github.com/ontola/atomic-plugins/issues/100)                                                                                                                                     |
| Moneybird (`moneybird`)                        | None: catalog entry and `overlays/moneybird.com/` only                                                        | None                                                                                                                                                                                                                                      | Declared: read-only bookkeeping collections                                                                     | None                                                                                                                                                                                                                                                  | [#102](https://github.com/ontola/atomic-plugins/issues/102)                                                                                                                                     |

`integrations/localthought/` is shared tooling, not a user-facing plugin:
the shared mock proxy every E2E lane uses (`mock-proxy.mjs`), a generic
sandbox mapper (`plugin.ts`) and `BrowserIntegrations` (`browser.ts`).
Nothing at the pin calls the last two.

## Commands

From the repository root, after `node integrations/tooling/link-atomic-server.mjs`
(see [README.md](README.md#local-setup)):

```sh
node integrations/tooling/certify.mjs --layer js            # money, notion, pets: typecheck, bundle, unit
node integrations/tooling/run-lane.mjs calendar --tier unit # any lane id from lanes.json
node integrations/tooling/run-lane.mjs pets --tier e2e      # needs the pinned atomic-server binary
```

The `e2e` tier needs the atomic-server binary built at the pin (AGENTS.md,
"Shared pinned atomic-server build"). `certify.mjs --layer sandbox` and
`--layer all` cannot pass at this pin: the Rust tests they name were removed
from atomic-server in `4bab16ee6`, and certify fails when a named test
matches nothing. `evidence.json` (2026-09-18) predates that
removal and is historical.
