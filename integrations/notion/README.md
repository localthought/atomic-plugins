# Notion ↔ Atomic

Everything Notion-specific lives in this folder. atomic-server keeps no
Notion code (branch `claude/remove-notion-code`). There are two paths, and
neither has an entry point in the atomic-server data-browser today:

- **Drive plugin on syncables and Devonian** (`app/`, read-only, new). This
  is the direction for #8 and #68: an iframe plugin that reads Notion through
  `syncables/browser` over the host's integration-proxy relay, and maps it to
  Atomic rows through a Devonian lens (`devonian/notion/`).
- **Sandbox plugin** (`plugin.ts`, two-way, the pilot). It runs in atomic-server's
  QuickJS/WASM plugin runtime. It is still the only two-way path.

API version `2026-03-11` throughout. Planning notes from the pilot moved
here from atomic-server and are under [`planning/`](planning/).

## Drive plugin on syncables (read-only, `app/`)

This plugin works the way `timesheets/app/` (#20) and `pets/app/` (#52) do.
It is one ES module whose `view({ root, store })` reads through
`syncables/browser` over `store.proxy`, the host's relay to the integration
proxy. No credential ever reaches the frame.

- `app/main.ts`, `controller.ts`: "Connect Notion" asks the host to connect
  (`store.proxy.connect`). Once a connection exists, the app shows the rows
  already in the drive at once (`rows.ts`) and syncs in the background when
  the last sync is unknown or older than 15 minutes, and on "Sync now". The
  controller's states (importing, syncing, no databases, reconnect needed,
  rate limited, failed) are classified by HTTP status (`errors.ts`). The last
  sync record (counts, per-database schema with option names and colours,
  grouped warnings) is a JSON string property, `notion-sync-record`, on the
  data table resource (`record.ts`).
- `app/view/`, `app/ui/`: the #89 design (`design/DESIGN.md`,
  `design/mockups.html`): table, board and list views, database chips, side
  peek, sync details, banners and empty states. `app/ui/` is the shared
  plugin shell (`pl-*` tokens mapped from the host's `--t-*` theme), kept
  free of Notion specifics so it can move to a shared kit.
- `app/transport.ts`: syncables' `Transport` over `store.proxy.request`. It
  sends the provider path (`/v1/search`), the method and the JSON body, and
  refuses any URL outside the document's `https://api.notion.com/v1`.
- `app/sync.ts`: host I/O only; every Notion-to-Atomic mapping is in the
  lens (see [Lens](#lens-devoniannotion) below).
  - `readPlatform` over the bundled `catalog/notion.json` lists every data
    source shared with the connection (`POST /v1/search`), then pages through
    each one's pages (`POST /v1/data_sources/{id}/query`, `start_cursor` in
    the body).
  - Pages go through `notionProjection` one data source at a time, and
    `notionColumns` derives the columns from what was read.
  - It finds or creates one Property per column under the row class's
    ontology and binds the lens to them.
  - Per page: an existing row (found by the Notion page id column) is seeded
    into the lens store, the page is `ingest`ed through the data source's
    Devonian `AtomicLens`, and the lens row's values are written back to the
    host row, removals included. New pages become new rows.
- `app/build.mjs`: `dist/ui.js`, minified (JS and CSS), about 116 KB since #89's UI,
  including the catalog document, syncables' read path and devonian's Atomic
  Data API. `@tomic/lib` is shimmed, as in timesheets (`Datatype` and
  `validateDatatype` only; `build.test.ts` pins both to the real library).
- Dependencies: `syncables@0.18.0` and `devonian@0.6.1` from npm, exact
  versions in `package.json`, locked in `pnpm-lock.yaml`, installed into this
  folder's `node_modules/` (`pnpm install --frozen-lockfile` here; CI's
  "Install plugin npm dependencies" step does it for every
  `integrations/*/pnpm-lock.yaml`). This repo's `syncables/` and `devonian/`
  sources are not used. Only devonian's `src/atomic/` is imported, by path
  (`devonian/notion/lens/devonian-atomic.ts`): the package root also exports
  `DevonianClient`/`DevonianTable`, which import `node:events` and Automerge
  and cannot go into the bundle, and 0.6.1's `exports` has no subpath for
  `src/atomic/`.
- `catalog/`: the composed catalog document, its provenance and
  `generate.py`. The overlays themselves are in
  `overlays/notion.com/2026-03-11/`; see [`catalog/README.md`](catalog/README.md).
- `fixtures/notion/`: an authored, read-only mock-proxy fixture serving
  `catalog/notion.json`. It pages the query two rows at a time, so the last
  row is only reachable by sending `next_cursor` back in the body.

What it does not do, and what is not verified:

- It is read-only: nothing is written to Notion. The lens has a reverse
  mapping (`write`), but its connector refuses create, update and delete. A
  page that disappears or is archived is left in place, never deleted.
- A value cleared in Notion (empty number, URL, select) is removed from its
  row on the next import. A value the lens cannot read losslessly (formatted
  text) leaves the row's value as it was, and is listed in the warnings.
- Select, status and multi-select columns hold Notion option ids, which stay
  stable across renames, rather than option names. The app shows names and
  colours from the sync record's schema, so a rename shows after one sync
  without rewriting rows.
- All shared data sources go into one table, with their columns merged. A
  "Data source" column says where each row came from.
- The e2e shows the pinned host lets the app add Properties under its
  ontology and add them to its class's `recommends` (it checks the column
  datatypes). Only the fake store covers later edits to them.
- It depends on `store.proxy` (`request`, `connections`, `connect`). Since
  #54 phase 2 (ontola/atomic-server#1697, pinned) the host's frame client
  calls the proxy itself with a capability and its own key.
  Without it, the app says so and fetches nothing.
- The e2e runs against the mock proxy (see below). Nothing here has run against live Notion
  or a real proxy.
- Links ("Open in Notion", URL values) open through `store.openExternal`,
  which asks the person first; "Open data table" uses `store.openResource`;
  "Disconnect Notion…" uses `store.proxy.disconnect` (rows are kept); rows
  load with `store.getMany` in batches of 100; the host's `colorScheme` sets
  the app's `color-scheme`. All since atomic-server 007869464, and each is
  feature-detected: on an older host the app falls back (copyable URL, no
  menu entry, one `getResource` per row).
- View choices (database, view, sort) are kept in memory only: the frame is
  null-origin, where `localStorage` throws.

## E2E

`e2e/notion.spec.ts` drives the drive plugin the same way the pets spec does:
a test-side install (`setAppSource` with `build().text`), then Connect, the
host's consent bar and the mock proxy's consent page, then the 3 rows in the
app's own table and their column types. It then walks the #89 states against
the fixture's scenarios (`setScenario`, `renameOption` drivers): two
databases, side peek, board, sync details, a renamed option, rate limited,
failed, nothing shared and revoked access, saving a screenshot of each as a
test artefact. It runs against the shared mock proxy's
`notion` fixture (`fixtures/notion/`), so the lane has
`platforms: ["notion"]` and `tiers: ["live", "e2e"]`. It needs an
`.atomic-server-ref` with frame capabilities (ontola/atomic-server#1697; the
pin `11264e83e` has it). The old
spec's two-way, PATCH and revoked-access checks have no read-only
counterpart and were dropped (#68).

## Lens (`devonian/notion/`)

Every Notion-to-Atomic transformation the drive plugin uses is here, in
three layers. Nothing in it touches the network or the host store.

`lens/projection.ts`, `notionProjection`, maps the data-source pages
syncables read (`resource: 'page'`) to typed values. Each value is keyed by
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
- `notionPropertyValue` is the reverse of `notionFieldValue`: text split into
  2000-character parts (more than 100 parts throws), options by id, and an
  absent value as Notion's empty for the type.

`lens/columns.ts` is the schema: `NOTION_FIXED_COLUMNS` (page id, data
source, URL, last edited), then one column per projected property, named
after the Notion property (`notionColumns`), and data-source titles.

`lens/atomic.ts`, `NotionRowLenses`, is the Devonian lens proper: one
`AtomicLens` from the npm `devonian` package per data source, over an
`AtomicStore` and `AtomicIdentityMap` scoped by the data source's Notion URL
and keyed by page id.

- `read` (page to row): sets the name, the fixed columns and every projected
  value; unsets a property Notion holds empty; leaves a property with no
  lossless plain value alone.
- `write` (row to page): the page with each bound property replaced by the
  row's value and every other property passed through. It throws rather
  than overwrite formatted text it never read, and refuses to create pages.
  Nothing calls it against Notion yet.
- The lens store uses its own subjects and property URLs under
  `https://notion-lens.invalid`. devonian accepts only HTTP(S) and DID
  identifiers, and atomic-server's are `atomic:...`, so `seed` and `toHost`
  translate to and from the host's Property subjects. The host row keeps its
  own identity (the page-id column). The identity map lives for one import
  and is not persisted.

`localthought.ts` re-exports the projection together with
`notionDataSourceQuery`.

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
The lens's `write` is the mapping half of that, and is not wired to a
connector. Retire `plugin.ts` only once that bridge has live evidence.

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

From the repository root, with the AGENTS.md layout, after installing this
folder's npm dependencies once:

```sh
(cd integrations/notion && pnpm install --frozen-lockfile)
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
