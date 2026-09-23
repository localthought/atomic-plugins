# Notion ↔ Atomic

Everything Notion-specific lives in this folder. atomic-server keeps no
Notion code (branch `claude/remove-notion-code`). There are two paths, and
neither has an entry point in the atomic-server data-browser today:

- **Drive plugin on syncables** (`app/`, read-only, new). This is the
  direction for #8 and #68: an iframe plugin that reads Notion through
  `syncables/browser` over the host's integration-proxy relay.
- **Sandbox plugin** (`plugin.ts`, two-way, the pilot). It runs in atomic-server's
  QuickJS/WASM plugin runtime. It is still the only two-way path.

API version `2026-03-11` throughout. Planning notes from the pilot moved
here from atomic-server and are under [`planning/`](planning/).

## Drive plugin on syncables (read-only, `app/`)

This plugin works the way `timesheets/app/` (#20) and `pets/app/` (#52) do.
It is one ES module whose `view({ root, store })` reads through
`syncables/browser` over `store.proxy`, the host's relay to the integration
proxy. No credential ever reaches the frame.

- `app/main.ts`, `controller.ts`: plain DOM. "Connect Notion" asks the host
  to connect (`store.proxy.connect`). Once a connection exists, it imports on
  open and again on "Sync now".
- `app/transport.ts`: syncables' `Transport` over `store.proxy.request`. It
  sends the provider path (`/v1/search`), the method and the JSON body, and
  refuses any URL outside the document's `https://api.notion.com/v1`.
- `app/sync.ts`: `readPlatform` over the bundled `catalog/notion.json`.
  - It lists every data source shared with the connection
    (`POST /v1/search`), then pages through each one's pages
    (`POST /v1/data_sources/{id}/query`, `start_cursor` in the body).
  - Pages go through the read-only lens (`devonian/notion/`) one data source at
    a time.
  - It makes one Property per Notion property under the row class's ontology,
    named after the Notion property and keyed by its stable id. Page id, data
    source, URL and last-edited columns are added too.
  - Rows are reconciled into the app's data table by Notion page id.
- `app/build.mjs`: `dist/ui.js`, about 75 KB including the catalog document
  and syncables' read path. `@tomic/lib` is shimmed, as in timesheets.
  `syncables/browser` resolves to this repo's `syncables/src/browser.ts`
  (#83), and so do `tsconfig.json` and `vitest.config.ts`.
- `catalog/`: the composed catalog document, its provenance and
  `generate.py`. The overlays themselves are in
  `overlays/notion.com/2026-03-11/`; see [`catalog/README.md`](catalog/README.md).
- `fixtures/notion/`: an authored, read-only mock-proxy fixture serving
  `catalog/notion.json`. It pages the query two rows at a time, so the last
  row is only reachable by sending `next_cursor` back in the body.

What it does not do, and what is not verified:

- It is read-only: nothing is written to Notion. A page that disappears or
  is archived is left in place, never deleted. Select, status and
  multi-select columns hold Notion option ids, which stay stable across
  renames, rather than option names.
- All shared data sources go into one table, with their columns merged. A
  "Data source" column says where each row came from.
- It is not verified that the host lets an app add Properties under its
  ontology and edit its class's `recommends`. The fake store assumes so.
- It depends on `store.proxy` (`request`, `connections`, `connect`), which
  atomic-server does not have yet (#52's relay). Without it, the app says so
  and fetches nothing.
- There is no e2e yet (see below). Nothing here has run against live Notion
  or a real proxy.

## E2E (quarantined, #68)

`e2e/notion.spec.ts` still drives the removed `[data-integration=notion]`
card (`ConnectNotion.tsx`, removed in atomic-server `4bab16ee6`), so the e2e
tier stays out of `lanes.json`. The spec gets replaced by the drive-plugin
flow once atomic-server has #52's relay and connect entry point. That flow
works like the pets spec: a test-side install (`setAppSource` with
`build().text`), then Connect, then the mock proxy's consent page, then
"Last synced" with 3 rows. The lane then gets `platforms: ["notion"]` and
`tiers: ["live", "e2e"]`. The old spec's two-way, PATCH and revoked-access
checks have no read-only counterpart, so they go with it.

## Lens (`devonian/notion/`)

`notionProjection` maps the data-source pages syncables read
(`resource: 'page'`) to typed values. Each value is keyed by
`notionFieldShortname(propertyId)`, a hex encoding of the case-sensitive
Notion property id.

- Covered: plain title/rich text, number, checkbox, url, email, phone,
  select/status option id, and sorted multi-select option ids.
- Notion `null` leaves the key absent; `0`, `false` and `[]` are kept.
- Formatted text, mentions and links are left unprojected and listed in
  `errors`. So are archived or trashed pages (`in_trash` or `in-trash`).
- The raw `properties` object passes through.
- It throws on a page outside the given data source, or on a property whose
  type changes during one fetch.

`localthought.ts` re-exports it together with `notionDataSourceQuery`.

## Sandbox plugin (`plugin.ts`, two-way pilot)

`plugin.ts`/`model.ts` are unchanged. They run in atomic-server's generic
QuickJS/WASM plugin runtime. They have had no UI entry point there since
atomic-server `4bab16ee6` removed `ConnectNotion`, and a catalog install runs
neither the installer (`atomic.ts`) nor a sync (#68). The live tier still
runs. `host/` (`async-plugin.ts`, `browser-sync.ts`) is its browser host,
moved here from `localthought/` because Notion was its only user.

Two-way through the drive plugin needs a Devonian bridge that ports
`model.ts`'s writes (#8 item 2): journalled `PATCH /v1/pages/{id}` through
the same relay, page-id identity, and a missing page treated as a conflict.
Retire `plugin.ts` only once that bridge has live evidence.

### Supported subset

- Row creation and editing in both directions: plain title/text, number,
  checkbox, URL, email/phone and existing select/multi-select/status options.
- Stable Notion page, property and option IDs. Property renames sync
  separately from row values and do not rename shared canonical Atomic
  properties.
- Atomic's display name and the mapped title column reconcile against a
  shared baseline. Conflicting local edits to both are reported, not
  silently resolved.
- Existing compatible table/board views: name, visible columns and their
  order, and mapped option grouping. View renames and column edits have
  independent baselines.

A patch contains only the mapped properties that changed. Null removes an
optional Atomic value; false, zero and empty arrays keep their distinct
meanings. Long plain text is chunked without truncation. Sync pauses before
any unsafe write on: rich text formatting or mentions, changed field types,
option identity/name drift, unknown option values, and missing pages.
Uncertain remote creates use host journals and cannot be blindly retried.

### Explicit limits

- A restricted, disposable personal Notion database passed a live UI import
  and title edits in both directions through the sandbox. Broader field and
  view fidelity is uncertified.
- One selected data source. New fields, views and options need a reviewed
  mapping refresh, which is not implemented.
- Filtered/sorted views, status-group boards, subtasks and subgroups are
  skipped at setup. Formula, rollup, relation, date, file and person fields
  are preserved in Notion and not synced.
- Full scans, a 100-page cap, and no incremental checkpoints or webhook
  intake. Rate limits pause the run.

## Tests

From the repository root, with the AGENTS.md layout:

```sh
./browser/node_modules/.bin/vitest run --config integrations/notion/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/notion/tsconfig.json
node --test integrations/localthought/mock-proxy.test.mjs
node integrations/notion/app/build.mjs
./browser/node_modules/.bin/esbuild integrations/notion/plugin.ts --preserve-symlinks --bundle --format=esm --platform=neutral --target=es2022 --outfile=integrations/notion/plugin.js
```

Optional sandbox installer test against a disposable local AtomicServer, with
simulated Notion metadata and no external Notion calls:

```sh
ATOMIC_NOTION_TEST_SERVER=http://localhost:9898 ./browser/node_modules/.bin/vitest run --config integrations/notion/vitest.config.ts
```

Sources: [page values](https://developers.notion.com/reference/page-property-values),
[data source queries](https://developers.notion.com/reference/query-a-data-source),
[search](https://developers.notion.com/reference/post-search),
[view configuration](https://developers.notion.com/guides/data-apis/working-with-views).
