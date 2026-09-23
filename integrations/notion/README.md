# Notion data source ↔ Atomic (pilot)

Connect from **Integrations → Notion** through the configured integration-proxy.
Authorization uses the shared browser PKCE handoff and rotating connection-code
transport. Database discovery, schema installation, preview and two-way sync run
in the browser, including when AtomicServer is unavailable. Credentials stay in
browser storage; no Notion-specific OAuth or discovery endpoint remains in
AtomicServer.

Each sync requires review. The shipped provider produces the same field/view
reconciliation and effects as before. A generic browser host supplies asynchronous
reads, applies reviewed effects, and checkpoints converged records. It persists
an in-flight effect before dispatch and refuses to replay an uncertain response.
Saved runs are bound to the bundle and mapping hash. Keep the browser open; this
path does not run server schedules or emit server-side discovery automations.

Existing token installations remain supported under **Advanced setup with a
token** through the generic server runtime. Reconnect through the proxy to create
a browser installation; existing tables/baselines are not automatically migrated.
Browser connections, installation lookup and sync journals are local to this
browser/profile. Clearing site data requires reconnecting and does not restore
old sync baselines. Do not reinstall onto existing imported data as a recovery
shortcut.

The proxy deployment must include the Notion catalog and generic JSON OAuth
operation/header support before real connections work. See
[the migration plan](../../planning/notion-integration-proxy.md).

## Supported subset

- Row creation and editing in both directions: plain title/text, number,
  checkbox, URL, email/phone and existing select/multi-select/status options.
- Stable Notion page/property/option IDs. Property renames sync separately from
  row values, without renaming shared canonical Atomic properties.
- Atomic's display name and the mapped title column reconcile against a shared
  baseline. Conflicting local edits to both are reported, not silently chosen.
- Existing compatible table/board views: name, visible columns/order and mapped
  option grouping. View renames and column edits have independent baselines.
- Legacy server-token installations: discovery event after the first checkpoint for independent JS automations;
  initial backfill and locally-created pages are excluded.

Patch requests contain only changed mapped properties. Null removes an optional
Atomic value; false/zero/empty arrays retain their distinct meanings. Long plain
text is chunked without truncation. Rich text formatting/mentions, changed field
types, option identity/name drift, unknown option values and missing pages pause
sync before unsafe writes. Uncertain remote creates use host journals and cannot
be blindly retried.

## Explicit limits

- A restricted disposable personal Notion database has passed live UI import and
  title edits in both directions through the sandbox. Broader field/view fidelity
  and background event delivery remain uncertified.
- One selected data source; database containers and linked views are not copied
  as separate row stores. New fields/views/options need reviewed mapping refresh,
  which is not implemented yet. Reinstallation is not a safe reset/recovery tool.
- Filtered/sorted views, status-group boards, subtasks and subgroups are skipped
  at setup with a reason. A supported connected view changing into an unsupported
  shape pauses sync. Calendars, list/gallery/timeline and other renderers remain
  future work. Provider-only widths/covers/wrapping are preserved when patching a
  configuration, but are not equivalent Atomic presentation.
- Formula/rollup/relation/date/file/person fields are preserved in Notion and not
  synced. Page blocks/content, archive/delete propagation and schema creation or
  deletion are outside this slice. Missing data never implies permission to delete.
- Full scans, 100-page cap, host session-size limits, and frequent verification
  reads. No incremental checkpoints, webhook intake or provider-paced read retry
  yet; rate limits pause the run. Concurrent writes between a re-read and remote
  mutation remain a cross-system race, not an exactly-once guarantee.
- Setup failures can leave a partial local draft; no resumable setup flow yet.
  The manual token path requires a data-source UUID; proxy setup discovers names.

## Tests

From the repository root:

```sh
./browser/node_modules/.bin/esbuild integrations/notion/plugin.ts --preserve-symlinks --bundle --format=esm --platform=neutral --target=es2022 --outfile=integrations/notion/plugin.js
./browser/node_modules/.bin/vitest run --config integrations/notion/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/notion/tsconfig.json
ATOMICSERVER_SKIP_JS_BUILD=true cargo test -p atomic-server --lib notion_bundle --no-default-features --features light,wasm-plugins
```

Optional installer test with a disposable local AtomicServer, simulated Notion
metadata and no external Notion calls:

```sh
ATOMIC_NOTION_TEST_SERVER=http://localhost:9898 ./browser/node_modules/.bin/vitest run --config integrations/notion/vitest.config.ts
```

The Rust fixture executes the shipped bundle with real Atomic persistence and
host effect journals. Node tests cover mappings, pagination refusal, conflicts,
view preservation, manifest classification and reproducible packaging. Browser
coverage checks setup validation and the existing shared sync/automation flow;
it does not certify live Notion setup.

API version pinned to `2026-03-11`.
Sources: [page values](https://developers.notion.com/reference/page-property-values),
[data source queries](https://developers.notion.com/reference/query-a-data-source),
[view configuration](https://developers.notion.com/guides/data-apis/working-with-views).

## Proxy configuration

Choose the proxy under **Settings → Integration**. The proxy owns the Notion
OAuth application and callback, API version headers and token refresh. Its
catalog selects Notion's OpenAPI document and OAuth overlay. AtomicServer no
longer reads `ATOMIC_NOTION_*` or runs the former shared authorization service.
The API version remains `2026-03-11`.

Automated proxy tests use authored responses. Successful local tests do not
certify live Notion authorization or production deployment.

## E2E entry point (quarantined, #68)

`e2e/notion.spec.ts` began at the `[data-integration=notion]` card. The
`ConnectNotion.tsx` that rendered it was removed in atomic-server
`4bab16ee6`. At the pinned `50cf5151c`, catalog install does not replace it:

- `catalog.json` entries only produce the visibility toggles and
  `LocalThoughtCatalog`'s `proxy:${platform}` cards. No data-browser code
  loads a `plugin.js` bundle from the catalog URL.
- The server marketplace (`/plugin-catalog`, then Open, review and
  `installRelease`) installs an `Installation` of a release that is already
  published on that server. The shipped `plugin.js` exports no manifest.
  The manifest is per data source (`model.ts` `manifest(dataSource)`), and
  `atomic.ts` appends it when it installs. The Installation page runs neither
  that installer nor a sync.
- Sandbox sync in the data-browser is server-side only (`/plugin-sync-preview`
  and `/plugin-sync-apply`, which need a `/plugin-secret`). `page.route`
  cannot stub server-side requests, and the spec asserts that neither
  endpoint is called. The browser-side runner, `browserPluginSync.ts`, has
  no importers at the pin.

The planned entry point is a `proxy:notion` card, which is blocked on #52.
Until then the lane runs the live tier only (`integrations/lanes.json`).

## LocalThought/Devonian lens (read-only, first slice)

Issue #8 moves Notion onto the standard reflector/syncables/Devonian stack.
This is the read-only first slice. It is not wired into any UI, and nothing
in it has been verified against live Notion.

- `devonian/platform-lenses/notion` (`notionProjection`) maps data-source
  pages that syncables fetched (`resource: 'page'`) to typed values. They are
  keyed by `notionFieldShortname(propertyId)`, a hex encoding of the
  case-sensitive Notion property id. Covered: plain title/rich text, number,
  checkbox, url, email, phone, select/status option id, and sorted
  multi-select option ids. Notion `null` leaves the key absent. `0`, `false`
  and `[]` are kept. Formatted text, mentions and links are left unprojected
  and listed in `errors`, and so are archived or trashed pages. The raw
  `properties` object passes through. A page outside the given data source,
  or a property whose type changes during one fetch, throws.
- `localthought.ts` re-exports the lens, together with
  `notionDataSourceQuery(dataSource, cursor?)`. That helper builds a single
  proxy-relative `POST /v1/data_sources/{id}/query` (`page_size` 100, with
  `start_cursor` in the body) for `BrowserIntegrations.request()`.

Not done yet:

- A CRUD Causality and pagination overlay for Notion's body-cursor
  queries. The proxy's composed document has neither.
- A two-way Devonian bridge: journalled writes, identity by page id, and a
  missing page treated as a conflict.
- View and property-rename reconciliation, and a `devonian-notion` catalog
  entry.

Until those land, `plugin.ts` stays the only path with two-way sync.

```sh
./browser/node_modules/.bin/vitest run --config integrations/notion/vitest.config.ts localthought
(cd devonian && pnpm exec vitest run --config __tests__/vitest.config.ts platform-lenses/notion)
```
