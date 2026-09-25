# Plugin readiness

What each plugin in this repo can do today, where a user would install it,
and what evidence backs that. Checked against atomic-plugins `main` and the
pinned atomic-server commit in [`.atomic-server-ref`](../.atomic-server-ref)
(`bae5cdbe3`, `feat/plugin-debug`, 2026-09-23). The drive app rows (Pets,
Notion, Clockify, Google Calendar, GitHub issues) and "Drive apps" below were
rechecked at pin `bc39dac4b` on 2026-09-25. When the pin or a plugin
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
  `requires-api-plugins` does not count. It draws a card only for a drive
  app entry (below); no other entry's name or copy is rendered
  (`pluginCatalog.ts`, `IntegrationStore.tsx`).
- **Drive apps.** The Integrations page's **Drive apps** section
  (atomic-server#1689, in the pin) shows each catalog entry with an
  `app-module`, behind the same `enabled`/`experimental`/`requires-api-plugins`
  gates. **Install** downloads the module from GitHub Pages, refuses it unless
  it matches `app-module-integrity`, and creates the app, ontology, table and
  entry point; a newer catalog version is offered as **Update**
  ([README.md, "Publishing a drive app"](README.md#publishing-a-drive-app)).
  Of this repo's drive apps only Pets is enabled in the published catalog;
  Notion, Clockify, Google Calendar and GitHub issues are published there
  (module and integrity) with `enabled: false` until their launch. The
  lanes' dev-server serves every drive app entry enabled
  (`DEV_SERVER_ENABLE_APPS`, set by `serve.mjs`), and CI's hosting-surface
  check allows exactly that change.
  `New app` still creates an App whose entry point's source can be
  replaced. The app's view runs in a null-origin iframe. It reaches the
  integration proxy only through `store.proxy.request`, `.connections`
  and `.connect`. Since #54 phase 2 (ontola/atomic-server#1697, in the pin)
  the connection lives at the proxy, owned by the user's agent and
  delegated to the app's; the top page draws the consent bar (with "Use
  existing connection" when there is one), and the frame calls the proxy
  itself with a capability from the page and its own key. The drive app E2Es
  below install through Drive apps, from the committed `apps/<id>/<version>/ui.js`
  that the lane's dev-server serves in place of GitHub Pages.
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

| Plugin (catalog id)                                        | Runtime of the current code                                                                                                                                                                                           | Install entry point at the pin                                                                                                                                                                                                            | Import / write scope (declared)                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                       | Open blockers                                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pets, drive app (`pets`)                                   | Drive app `pets/app/`: iframe, `syncables/browser` over `store.proxy`                                                                                                                                                 | Integrations → Show experimental plugins → Drive apps → Install (`pets` 0.1.1, from GitHub Pages, integrity-checked). The host E2E installs this way, then updates from an older recorded version                                         | Read-only. Pets from the mock `pets` platform into the app's own table                                                                                                                                                                          | Unit; **Host E2E** (`pets` lane: catalog install and update, connect, 5 rows, datatypes)                                                                                                                                                                                                                                                                                                       | None filed                                                                                                                                                 |
| Pets, static demo (`pets`)                                 | Sandbox `pets/plugin.js`, no network                                                                                                                                                                                  | None. Its setup dialog was removed in `4bab16ee6`                                                                                                                                                                                         | Five static pets into a Pets table                                                                                                                                                                                                              | Unit; `certify.mjs --layer js`. Historical: Rust sandbox test (removed from atomic-server in `4bab16ee6`)                                                                                                                                                                                                                                                                                      | None filed; the catalog card still describes this demo, not the drive app                                                                                  |
| Notion, drive app (`notion`)                               | Drive app `notion/app/`: iframe, `syncables/browser` + Devonian `AtomicLens` over `store.proxy`; the #89 UI (table, board and list views, side peek, sync details, Disconnect)                                        | Published (`notion` 0.1.0 on GitHub Pages) but `enabled: false` pending launch, so Drive apps does not offer it. The host E2E installs it through Drive apps, with the lanes' dev-server serving the entry enabled                        | Read-only. Every shared data source into one table; plain fields and select/status/multi-select options only                                                                                                                                    | Unit; **Host E2E** (`notion` lane: catalog install, connect, 3 rows, column datatypes, formatted-text warning, the #89 states against the fixture's scenarios). No live run                                                                                                                                                                                                                    | [#97](https://github.com/ontola/atomic-plugins/issues/97) local edits, [#8](https://github.com/ontola/atomic-plugins/issues/8) write                       |
| Notion, two-way pilot (no card; shares `notion`'s version) | Sandbox `notion/plugin.js`                                                                                                                                                                                            | None. `ConnectNotion` was removed in `4bab16ee6`. The `notion` catalog card now describes the drive app                                                                                                                                   | Two-way on one data source: plain fields, property names, table/board view subset (`package.json` capabilities)                                                                                                                                 | Unit; `certify.mjs --layer js`; `live` tier runs the installer against the pinned server with Notion stubbed. Historical: live UI import and title edits via `ConnectNotion`                                                                                                                                                                                                                   | Retire once a drive-app write bridge has live evidence ([#8](https://github.com/ontola/atomic-plugins/issues/8))                                           |
| Clockify (`timesheets`)                                    | Drive app `timesheets/app/`: iframe, own Clockify client over `store.proxy.request`. The #89 UI (week grid, entries, projects, read-only drawer, settings) over the #123 M1 observation log and M2 timeline           | Published (`timesheets` 0.1.0 on GitHub Pages) but `enabled: false` pending launch, so Drive apps does not offer it. The host E2E installs it through Drive apps, with the lanes' dev-server serving the entry enabled                    | Read-only. The user's own entries in one workspace, rolling 7- or 30-day look-back; completed entries as rows. Conflicts and not-loaded time shown read-only. No writes to Clockify yet                                                         | Unit (fake store; #123 M1 scenarios and fold property tests, M2 timeline incl. DST days); **Host E2E** (`timesheets` lane: catalog install, connect, setup, import, reload, changed entry, 7 → 30 days, 503 recovery, an M2 conflict and unknown time). The mock's Clockify endpoints follow API behaviour checked against a live account on 2026-09-24 (#123); the app itself has no live run | [#123](https://github.com/ontola/atomic-plugins/issues/123) M3/M4 (writes, resolving conflicts), [#97](https://github.com/ontola/atomic-plugins/issues/97) |
| Bank statements (`money`)                                  | Sandbox `money/plugin.js`, file handed over as `ctx.upload`, no network                                                                                                                                               | Draft from a published release (Integrations → Community plugins → Create draft), then Set up and Import on the plugin page (atomic-server#1653's `accepts`/`destination`, in the pin). Publishing the bundle to a server is manual (#94) | Import only. MT940 ≤ 512 KB, camt.053 ≤ 5 MB, ≤ 500 transactions                                                                                                                                                                                | Unit; `certify.mjs --layer js`; host E2E `money/e2e/money.spec.ts` (synthetic MT940/camt.053: import, reload, reimport, local edit, conflict, refused files). Historical: a real 272-transaction bunq MT940 export through `ImportMT940` (2026-09-11)                                                                                                                                          | [#94](https://github.com/ontola/atomic-plugins/issues/94)                                                                                                  |
| Willow drop (no catalog entry)                             | Sandbox `willow-drop/plugin.js`, drop file handed over as `ctx.upload` text and turned back into bytes, no network                                                                                                    | As for Bank statements: draft from a published release, then Set up and Import on the plugin page. Publishing is manual (#94)                                                                                                             | Import only. Willow'25 drops up to 5,000,000 bytes and 1,000 entries (declared); no delegated capabilities, no partial payloads                                                                                                                 | Unit (fixtures written by willow25 0.7.9); host E2E `willow-drop/e2e/willow-drop.spec.ts` (raw and base64 upload, reimport, refused drops)                                                                                                                                                                                                                                                     | [#139](https://github.com/ontola/atomic-plugins/issues/139) follow-ups: delegations, partial payloads                                                      |
| Google Calendar (`calendar`)                               | Drive app `calendar/app/`: iframe, `calendar/adapter.ts` through `app/relay.ts` over `store.proxy`. The #89 UI (agenda, week, drawer, review sheet; Month hands off to the table's calendar view)                     | Published (`calendar` 0.1.0 on GitHub Pages) but `enabled: false` pending launch, so Drive apps does not offer it. The host E2E installs it through Drive apps, with the lanes' dev-server serving the entry enabled                      | One calendar's single non-recurring events in (≤ 25,000 per scan); reviewed edits of five fields out with If-Match and `sendUpdates=none`; no creates or deletes in Google                                                                      | Unit; **Host E2E** (`calendar` lane: catalog install, connect, import, refresh after a Google-side edit, review and send, 412 conflict, lost response, links/Month/Disconnect through the host, responsive and theme). Historical: live import (2026-09-09, proxy v39) through the retired LocalThought snapshot importer. No live run of the drive app                                        | [#101](https://github.com/ontola/atomic-plugins/issues/101) live verification                                                                              |
| Todoist (`devonian-todoist`)                               | Library only: `issue-tracker/todoist.ts` projection                                                                                                                                                                   | None. Its host hook was removed in `f3efedf65`                                                                                                                                                                                            | Declared: read-only, active tasks and projects                                                                                                                                                                                                  | Unit. Recorded-fixture tests skip until a recording exists                                                                                                                                                                                                                                                                                                                                     | [#99](https://github.com/ontola/atomic-plugins/issues/99), [#46](https://github.com/ontola/atomic-plugins/issues/46)                                       |
| GitHub issues (`issue-tracker`)                            | Drive app `issue-tracker/app/`: iframe, the Devonian bridge from `issue-tracker/devonian/github-issues/` (npm `devonian` 0.8.0) over `store.proxy`. The #89 board/list UI. The lens's sandbox `plugin.ts` has no host | Published (`issue-tracker` 0.1.0 on GitHub Pages) but `enabled: false` pending launch, so Drive apps does not offer it. The host E2E installs it through Drive apps, with the lanes' dev-server serving the entry enabled                 | Two-way for one repository: title, body, Todo/Doing/Done status, comments. Every GitHub write is held for review before send. An issue gone from GitHub: "Keep here only" or "Remove from board". An uncertain create has no in-app way out yet | Unit (incl. state 13); **Host E2E** (`issue-tracker` lane: catalog install, connect, repository picker, import, reload, reviewed status update, conflict review, keyboard move, comment). Opt-in lens `*.live.test.ts` (need `GITHUB_TOKEN`; not run in CI). Historical: live GitHub read (2026-09-09, proxy v38) via the retired server flow. No live run of the drive app                    | [#156](https://github.com/ontola/atomic-plugins/issues/156) "It landed", [#100](https://github.com/ontola/atomic-plugins/issues/100)                       |
| Moneybird (`moneybird`)                                    | None: catalog entry and `overlays/moneybird.com/` only                                                                                                                                                                | None                                                                                                                                                                                                                                      | Declared: read-only bookkeeping collections                                                                                                                                                                                                     | None                                                                                                                                                                                                                                                                                                                                                                                           | [#102](https://github.com/ontola/atomic-plugins/issues/102)                                                                                                |

`integrations/localthought/` is shared tooling, not a user-facing plugin:
the shared mock proxy every E2E lane uses (`mock-proxy.mjs`, which speaks
the integration proxy's 0.2 protocol and checks its signatures and
capabilities) and a generic sandbox mapper (`plugin.ts`) that nothing at the
pin calls. `BrowserIntegrations` (`browser.ts`) was deleted in #54 phase 2.

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
