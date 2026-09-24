# Integration maintenance

Each provider lives in its own directory and ships a bundled ES module. The
runtime, permissions, reconciliation and recovery stay shared. Packages remain
experimental until their advertised capabilities have current live evidence.
[READINESS.md](READINESS.md) records, per plugin, which runtime its current
code uses, how it is installed on the pinned atomic-server, and which of its
evidence is unit, host E2E, live or historical.

Named actions, automation permissions, recovery and MCP setup are documented in
[ACTIONS.md](ACTIONS.md). Those are atomic-server features; the MCP stdio
protocol test (`browser/data-browser/scripts/integration-mcp.test.mjs`) lives
in atomic-server and is not run by this repo's CI.

## Local setup

Every package imports atomic-server's `browser/` tree by relative path
(`../../browser/lib/src/...`, `../../browser/tsconfig.build.json`,
`../../browser/node_modules/...`), which does not exist in this repo. From the
repository root, once per clone or worktree and again after
`.atomic-server-ref` changes:

```sh
node integrations/tooling/link-atomic-server.mjs
```

What it does, each step idempotent:

1. Makes `$ATOMIC_SERVER_CHECKOUT` (default `/tmp/atomic-server`) an
   atomic-server checkout at the commit in `.atomic-server-ref`. If the
   directory is missing it fetches just that commit (`--depth=1`). If the
   checkout is on another commit it fetches and detaches to the pinned one.
   It refuses if the checkout has uncommitted changes to tracked files.
2. Symlinks `browser` -> `$ATOMIC_SERVER_CHECKOUT/browser` and
   `integrations/node_modules` -> `../browser/e2e/node_modules`. Both are
   gitignored. It replaces a stale symlink but never a real directory.
3. Runs `pnpm install --frozen-lockfile` in `$ATOMIC_SERVER_CHECKOUT/browser`.
   atomic-server pins `pnpm@10.15.1` in `packageManager`.
4. Verifies the result: `browser/` must resolve into a git checkout at the
   pinned commit, and `browser/node_modules/.bin/tsc` must exist.

Flags: `--check` only runs step 4 and exits 1 on any problem. `--no-fetch`
skips step 1 and still verifies the commit. `--no-install` skips step 3.
CI's `shared-checks`, `lane` and `e2e-plugin-system` jobs run it with
`--no-fetch --no-install` after their own `actions/checkout` and
`pnpm install`, so the local layout is CI's layout. `run-lane.mjs` prints the
step-4 problems as warnings before it runs any tier.

With that in place, no server is needed for:

```sh
node integrations/tooling/run-lane.mjs <lane> --tier typecheck   # tsc -p integrations/<lane>/tsconfig.json
node integrations/tooling/run-lane.mjs <lane> --tier unit        # vitest run --config integrations/<lane>/vitest.config.ts
node integrations/tooling/certify.mjs --layer js                 # every package (see below)
```

Not covered by the script:

- the atomic-server binary. The `live` and `e2e` tiers need it; build it
  once in the checkout with the `cargo build` line `serve.mjs` prints, or
  set `ATOMIC_SERVER_IMAGE` to run the published
  `ghcr.io/ontola/atomic-server-e2e:<pin>` image in Docker instead (AGENTS.md,
  "Shared pinned atomic-server build").
- certify's `--layer sandbox` and `--layer all` (the default). Both run
  `cargo test -p atomic-server` from this repo's root for the Rust tests
  named in each `package.json`'s `atomicCertification.sandboxTests`. That
  has not been verified to work in this symlinked layout, and it cannot pass
  at the current pin: atomic-server `4bab16ee6` removed those tests. CI runs
  `--layer js` only.

## One certification command

From the repository root:

```sh
node integrations/tooling/certify.mjs --layer js
```

This discovers every integration with a `package.json` (today `money`,
`notion` and `pets`), validates required metadata/files, checks the committed
bundle against a fresh build, typechecks and runs fixture tests. Without
`--layer js` it also runs exact named Rust tests through QuickJS/WASM, which
the current pin no longer has (see [Local setup](#local-setup)).
It fails if a requested test matches nothing. It never rebuilds the shipped file
in place to make a reproducibility failure disappear.

Options: `--integration notion`, `--layer js|sandbox|all`, and `--output /path`.
Default output: `artifacts/integration-certification/report.json` plus logs and
Vitest JSON. Use separate output directories for concurrent runs. A report is
marked running until finished; failed validation replaces old successful evidence.

A passing report certifies only its selected offline layer. Capabilities are
labelled **declaredCapabilities**, not individually verified promises. `live` is
always `not-run`: existing live-test environment switches are stripped. Missing
credentials and skipped tests never count as successful live verification.
The report binds evidence to the shipped bundle hash and package version.
Do not infer compatibility of a later release from an older report.

CI's "Lint, tooling tests, certification" job runs `--layer js` for all
providers and uploads the report as the `integration-certification-report`
artifact. That report deliberately does not claim any sandbox layer ran.
Drive apps (`<name>/app/`) and packages without a `package.json` are not
certified by this command; their evidence is their lane's unit and e2e tiers
(`lanes.json`).

## Declaring config

A plugin that reads `ctx.config` declares the shape it needs in its `manifest`,
beside the code that destructures it:

```js
export const manifest = {
  schemaVersion: 1,
  operations: [],
  secrets: [],
  config: {
    // Key this plugin's config sits under in the installation's stored config.
    // Omit it when the config is stored flat.
    key: 'pets',
    properties: {
      table: { type: 'string', description: 'Table the pets are written to' },
      properties: { type: 'object' },
    },
    required: ['table'],
  },
};
```

The host builds `ctx.config` once for preview, manual runs and scheduled runs
alike, and checks it against this declaration before starting the sandbox. An
installation that never stored its config then pauses on a problem naming the
field to set, instead of on whatever `run()` throws when it destructures
`undefined`. The declaration is optional: a plugin that omits it is run exactly
as before, so guard `ctx.config` in `run()` too.

## Version and catalog entry

Each bundled package's `package.json` `version` is this repo's record of which
published version of that integration is currently shipped. When a
`catalog.json` card's `shortname` matches the package directory name (as it
does today for `money`, `notion` and `pets`), that card also carries a
`version` field and it must equal the package's. `certify.mjs` enforces this
alongside the existing bundle/owner/apiVersion checks, so the catalog can
never advertise a version other than the one actually shipped. A card whose
`shortname` differs from any package directory — reached through `pluginUrl`
or the generic LocalThought/Devonian bridge — carries no `version` here,
since this repo is not the source of its published releases.

A host is meant to read a package's `version` (directly, or via
`catalog.json`) at install time to record which release an installation is
pinned to, and later compare it against this repo's current `version` to
offer an update. No host does this at the current pin
([#94](https://github.com/ontola/atomic-plugins/issues/94)). Bump
`package.json` `version` (and the matching catalog entry) whenever an
integration's shipped `plugin.js` changes.

## Building an uploader plugin

A file-upload importer — like **Bank statements** (`integrations/money/`,
which reads MT940 and camt.053 bank statement exports) — is not a special
plugin kind with its own base class or interface. It is an ordinary
server-executed sandbox plugin (see [Plugin runtimes](../AGENTS.md#plugin-runtimes))
whose `run(ctx)` reads file contents that UI code already collected, instead
of calling `ctx.http` against a provider. Everything else — config
declaration, `importRecords`, identity/reconciliation — is the same
contract every importer plugin follows.

At the current pin no host UI supplies the file text: atomic-server
`4bab16ee6` removed the upload dialog (`ImportMT940`) that did, and a
replacement is [#95](https://github.com/ontola/atomic-plugins/issues/95).
The contract below is what `money/plugin.ts` implements and its unit tests
exercise.

1. **Declare no network access.** `operations: []` and `secrets: []` in the
   manifest is what marks a plugin as needing neither: contrast with
   `issue-tracker`/`notion`, which declare secrets and call `ctx.http`.
   File acquisition (choosing/reading the file) is UI code, not plugin code;
   parsing can run first in an isolated browser Worker, but the sandboxed
   `run()` itself never touches the network.

2. **Read the uploaded text from `ctx`.** The host hands file contents in as
   plain text on the trigger payload:

   ```ts
   const text = ctx.text ?? ctx.trigger?.payload?.text;
   if (!text)
     throw new Error('Open <Your importer> in Integrations and choose a file');
   ```

   Support a **dry validate** call before installation completes:
   `ctx.trigger?.payload?.validate` — when set, parse/validate and return
   `{ intents: [], problems: [] }` without writing anything.

3. **Declare and re-guard config.** Follow [Declaring config](#declaring-config):
   list the destination `table`/`rowClass`/ontology `properties` your
   importer needs under `manifest.config`, and mark them `required`. The
   host checks this before starting the sandbox, but the declaration is
   advisory — `run()` must still guard `ctx.config` and throw a
   configuration-shaped error (naming the missing fields), never let a
   destructure of `undefined` throw a raw `TypeError`:

   ```ts
   const { table, rowClass, properties: p } = ctx.config ?? ({} as Config);
   const missing = [
     ['table', table],
     ['rowClass', rowClass],
     ['properties', p],
   ]
     .filter(([, value]) => !value)
     .map(([name]) => name);
   if (missing.length)
     throw new Error(
       `Configure this importer before running it: missing ${missing.join(', ')}`,
     );
   ```

4. **Give every row a stable identity, keyed by what makes reimport safe.**
   File-based sources have no server-assigned ID to key off, so build one
   from content that uniquely identifies a row within your source scope
   (account/currency/format plus a bank reference, or statement position as
   a fallback), and a separate content fingerprint to detect a genuinely
   conflicting reimport versus a harmless repeat. `money/plugin.ts` is the
   reference: it keys `identity` by `[format, account, currency, reference-or-statement-position]`
   and a parallel `fingerprint` by the row's actual field values, throwing
   when the same identity carries two different fingerprints within one
   file (a real conflict), and rejecting overlapping imports that lack
   unique references at all. Feed the result to the shared reconciliation
   helper:

   ```ts
   import {
     importRecords,
     type ImportRecord,
   } from '../../browser/lib/src/import-records.js';
   const records: ImportRecord[] = rows.map(row => ({
     sourceId: identity,
     mode: 'append',
     legacy: { property: p['source-id'], value: identity },
     localId: `row-${records.length}`,
     parent: table,
     isA: [rowClass],
     values: {
       /* ... */
     },
   }));
   const result = importRecords(ctx, records);
   return { intents: result.intents, problems: result.problems };
   ```

   `importRecords` (`browser/lib/src/import-records.js`) is the shared
   import/reconciliation contract point every importer calls, whether the
   source is a file (`money`, `pets`) or a fetched provider (`issue-tracker`,
   `notion`, the generic `localthought` plugin).

5. **Keep parsing pure and separate from the manifest.** `money/parser.ts`
   (MT940), `money/camt053.ts` (camt.053 XML — the sandbox has no
   `DOMParser`, so this carries its own namespace-agnostic reader) and
   `money/statement.ts` (format detection + dispatch) contain no manifest or
   `ctx` references at all; `plugin.ts` only wires their output into
   `ImportRecord`s. This keeps the parser unit-testable without a sandbox
   host and reusable if a second file format needs the same importer later.
   Represent amounts, dates and other precision-sensitive fields as exact
   strings (`money/parser.ts` reconciles balances with `BigInt`, never
   floating point).

6. **Declare the destination ontology in a `schema.ts`.** A code-first
   `SchemaSpec` (`money/schema.ts`'s `bankingSchema()`): an array of
   `[shortname, displayName, description]` triples turned into `properties`,
   plus one or more `classes` entries with `requires`/`recommends`. This is
   what a fresh installation provisions before the importer's first run.

7. **Follow package layout and commands.** `plugin.ts` (manifest + `run`),
   `<domain>.ts` parser/adapter modules, `schema.ts`, `tsconfig.json`
   extending `../../browser/tsconfig.build.json`, `vitest.config.ts`,
   `package.json` with `atomicCertification`, and a `README.md` with an
   `## Architecture` and `## Supported scope and gaps` section (state exact
   limits — record counts, byte sizes — and what is out of scope, don't
   just describe what works). Bundle and test exactly as `money` does:
   ```sh
   ./browser/node_modules/.bin/vitest run --config integrations/<name>/vitest.config.ts
   ./browser/node_modules/.bin/esbuild integrations/<name>/plugin.ts --preserve-symlinks --bundle --format=esm --platform=neutral --target=es2022 > integrations/<name>/plugin.js
   ```
   Then run the full certification command from [above](#one-certification-command)
   and add a `catalog.json` entry (see [Adding or changing an integration](#adding-or-changing-an-integration)).

## Building a LocalThought (reflector/syncables/Devonian) connector

A provider integration today is a **drive app**: shape 1 in
[Plugin runtimes](../AGENTS.md#plugin-runtimes). It runs in the browser, in
the App's iframe, against the provider's HTTP API through **LocalThought**
(the OAuth/API proxy at `https://localthought.io`, or a self-hosted
[`integration-proxy`](../integration-proxy/)). `pets/app/` is the smallest
working example and `notion/app/` the fullest; both pass a host E2E against
the pinned atomic-server and the shared mock proxy. This section explains
where **syncables**, **Devonian** and **reflector** fit.

Earlier versions of this section described a different runtime: a
LocalThought connect dialog and sync panel inside atomic-server's
data-browser, built on `BrowserIntegrations` (`localthought/browser.ts`),
with catalog `platform` entries, lens hooks and the generic sandbox mapper
`localthought/plugin.ts`. atomic-server removed that flow (`f3efedf65`,
`c707ca4ed`), and the data-browser no longer imports anything from this
repo. [`localthought/README.md`](localthought/README.md) still documents
it, as history.

### The stack, top to bottom

- **LocalThought / integration-proxy** — the OAuth/API proxy. It owns
  provider credentials (never the frame, the drive or AtomicServer),
  publishes a **catalog** of supported platforms, and serves each platform's
  OpenAPI document, already patched with the overlays it needs (see below).
- **The host relay** — atomic-server's top page holds the proxy connection
  (a rotating connection code in its own `localStorage`, bound to the proxy
  origin, drive, agent and app) and answers the frame's
  `store.proxy.request({ platform, connectionId, path, method, query, body, ifMatch })`
  with `{ status, headers, body }` only. `store.proxy.connections` lists the
  app's connections, and `store.proxy.connect` asks the host to draw a
  consent bar and start the PKCE handoff. This is
  ontola/atomic-server#1657 (`helpers/proxyConnections.ts`, a port of
  `localthought/browser.ts`), in the pin. It is an interim shape: #40/#54
  and atomic-server#1624 are meant to replace the rotating code with a
  scoped capability without changing the apps.
  **The connection code never reaches the frame or the graph.** Never
  write it into an Atomic resource, not an App resource, config or row: a
  resource syncs, its drive can be shared, and the proxy has no per-code
  revocation ([#21](https://github.com/ontola/atomic-plugins/issues/21)).
  `localthought/no-credentials-in-graph.test.mjs` (`node --test`, run by
  CI's "Tooling unit tests" step) fails the build if any shipped source
  under `integrations/` contains a `…/properties/…connection-code` URL, or
  mentions `x-connection-code` outside `browser.ts`. It is a text scan, not
  data-flow analysis.
- **Syncables** — the npm `syncables` package, used in the frame as
  `syncables/browser` (`readPlatform`, `describePlatform`, a `Transport`
  over the relay). It reads an OpenAPI document plus its
  [CRUD Causality Extension](https://github.com/pondersource/openapi-extensions/tree/main/spec/crud-causality)
  (`components.crudResources`) block, discovers the resource model and
  pages through it, so the app carries no provider-specific paging code.
  Each app bundles the document it reads (`pets/app/openapi.json`,
  `notion/catalog/notion.json`) and pins an exact `syncables` version in its
  own `package.json`/`pnpm-lock.yaml`; this repo's `syncables/` source is
  not bundled.
- **Devonian** — the npm `devonian` package's lenses, for the mapping from
  provider records to Atomic rows (and back, for two-way). `notion/app/`
  uses its `AtomicLens` (`notion/devonian/notion/`). A plugin's own lens
  lives in its plugin folder at `integrations/<plugin>/devonian/<platform>/`.
  Two-way Devonian sync with journalled writes exists only as the unhosted
  GitHub issues bridge (`issue-tracker/devonian/github-issues/`).
- **Reflector** ([`reflector/`](../reflector/)) — the sync-engine/plugin-runtime
  layer one level above syncables. No drive app uses it yet.

### Two shapes, pick one

**(a) Read-only import.** Model it on `pets/app/`: a `transport.ts` that
turns syncables' requests into relay calls and refuses any URL outside the
document's `servers[0].url`; a `sync.ts` that creates one Property per field
under the app's ontology, adds them to the row class's `recommends`, and
upserts rows under the app's table keyed by a provider id; a `controller.ts`
and `main.ts` for a plain-DOM view; a `build.mjs` producing `dist/ui.js`
with a `build.test.ts` that checks the bundle has no `fetch`, storage or
`Authorization` handling. Add a mock-proxy fixture in
`integrations/<plugin>/fixtures/<platform>/` and an e2e spec, and give the
lane an `e2e` tier in `lanes.json`. What happens to local edits of imported
fields on refresh is not settled yet
([#97](https://github.com/ontola/atomic-plugins/issues/97)).

**(b) Two-way sync.** Needed when local edits must flow back to the
provider. No drive app does this yet. The design to port is
`issue-tracker/devonian/github-issues/`:

- `bridge.mjs` — Devonian lenses and checkpointed three-way reconciliation.
- `ports.mjs` — native-Atomic and provider-side projections/transports.
- `proxy.mjs` — the integration-proxy transport and a labelled sample
  fixture.
- `target.mjs` — which Atomic drive the sync writes into and when that
  drive can be enumerated or written.

Give every native resource a stable identity independent of matching text
(explicit provider IDs bind existing rows; nothing infers identity from
title/body equality), journal writes before sending them (the provider side
has no idempotent create, so an uncertain/lost response must stop rather
than retry blindly), and treat a missing record as a conflict to resolve,
never an implicit deletion. The relay passes `method` and `ifMatch`, so
conditional `PATCH` requests are possible from a frame.

### OpenAPI overlays and the pondersource extensions

A provider's own OpenAPI document rarely declares the two things syncables
needs to drive it generically: which operations are CRUD on which resource,
and how its list endpoints paginate. Rather than fork the provider's spec,
LocalThought layers **overlays** on top of it — small YAML/JSON documents
following the [OpenAPI Overlay Specification](https://spec.openapis.org/overlay/v1.0.0.html):
a list of `{target: <JSONPath-ish string>, update: {...}}` or `{target,
remove: true}` actions, applied in order onto the resolved document (a later
overlay may refine what an earlier one added). `integration-proxy/` (this
repo's LocalThought proxy) is what actually applies overlays server-side;
[`syncables/src/openapi/overlay.ts`](../syncables/src/openapi/overlay.ts)
is a reference implementation of the same deliberately minimal subset —
`$`, dot-paths (`$.components`), and quoted-bracket segments
(`$.paths['/pets/{petId}'].get`); no wildcards or array indexing.

Two overlay-carried spec extensions from the
[`pondersource/openapi-extensions`](https://github.com/pondersource/openapi-extensions)
project do the actual work:

- **[CRUD Causality Extension](https://github.com/pondersource/openapi-extensions/tree/main/spec/crud-causality)**
  — adds `components.crudResources` (named resources with an `identity`
  URL template + path-variable bindings, and `collections` with their own
  list-query fixed params) and an `x-crud` block on individual operations
  (`action: list|read|create|update|delete`, `resource`, `collection`,
  `mode`, `patchFormat`, `addedFields`, `memberOf`, `removesFrom`). This is
  what a syncables engine reads to discover a platform's resource graph,
  including nested collections; see
  [`syncables/src/resources/discover.ts`](../syncables/src/resources/discover.ts)
  for the reference implementation.
- **[OpenAPI Pagination Schemes Extension](https://github.com/pondersource/openapi-pagination-schemes-extension)**
  — adds `components.paginationSchemes`, describing how the API paginates
  (cursor, offset, page, link-header, ...). Providers essentially never
  declare this natively either, so it is applied the same way, via an
  overlay. [`syncables/src/pagination/`](../syncables/src/pagination/)
  implements it, deliberately keeping scheme/role strings open-ended rather
  than closed enums, since the spec allows `x-` extension roles.

**[`overlays/`](../overlays/)** (migrated from `localthought/overlays`) is
the collection of ready-made overlay files for real providers, and its
`catalog.json` is what `integration-proxy` composes; GitHub Pages serves it
at `https://ontola.github.io/atomic-plugins/overlays/`. Note that this is a
top-level folder of this repo, so like `devonian/` it is not part of the
`integrations/` tree copied into an `atomic-server` checkout —
[`syncables/__tests__/fixtures/real-world/`](../syncables/__tests__/fixtures/real-world/)
vendors overlay and OpenAPI fixtures unmodified from it and from apis.guru,
with provenance in each file's header comment. When adding a new platform
connector, check there first for an existing overlay before writing a new
one; when you do write a new overlay, keep the same minimal-diff spirit —
patch what the provider's spec is missing, don't restate what it already
declares correctly.

Overlays are applied before an OpenAPI document reaches a drive app:
`integration-proxy/` (LocalThought) applies them server-side, and a drive
app bundles an already-composed document (`notion/catalog/generate.py`
composes Notion's from `overlays/notion.com/`). A native (non-browser)
caller of the `syncables` npm package can instead apply them itself via
`ClientConfig.document`/`.overlays` file paths — a convenience that only
exists off the browser/WASM path.

## Adding or changing an integration

1. For a sandbox plugin, supply `plugin.ts`, reproducible `plugin.js`,
   `tsconfig.json`, `vitest.config.ts`, README and `atomicCertification` in
   `package.json`. For a drive app, see
   [the drive-app shapes](#two-shapes-pick-one) and add its lane tiers to
   `lanes.json`. Update [READINESS.md](READINESS.md) in the same PR.
2. Metadata identifies owner, support tier, pinned API version, supported scope
   and fully qualified Rust sandbox test names. A new package without metadata
   fails CI rather than silently escaping it.
3. Reproduce provider bugs with synthetic or scrubbed fixtures. Mock network
   replies, not the permission checks or execution engine. Include independent
   edits, conflicts, pagination, missing data and uncertain-write behavior.
4. Run the full certification command. Test installation and actual UI behavior
   when changing browser packaging; mapping tests alone cannot establish that.
5. Review changes to permissions, mappings and checkpoint formats. Existing
   connections stay pinned; an upgrade must preserve their bindings and pending
   effects. Code rollback is not reversal of remote writes.
6. Run bounded live checks in a dedicated vendor test account before promoting
   supported capabilities. Never use customer data as published fixtures.

LLM-generated contributions use exactly this path. An agent may propose a repair
and tests; passing tests do not authorize production permissions or publication.

## Store evidence and upgrades

After the full offline run, generate the repository evidence asset:

```sh
node integrations/tooling/publish-evidence.mjs artifacts/integration-certification/report.json
```

This writes `integrations/evidence.json` locally; it does not publish a release.
The command rejects partial, failed, stale or mismatched reports and requires
every current provider sandbox test. Review and commit the asset with the bundle.
These results contain no live-provider certification or per-capability claims.

The committed `evidence.json` (generated 2026-09-18) is historical: its
sandbox checks ran against an atomic-server from before `4bab16ee6`, which
removed those tests, so it cannot be regenerated at the current pin. The
store cards that used to display it (`IntegrationEvidence`) were removed in
the same commit, and nothing at the pin reads it.

atomic-server's own `sync_session_tests.rs`, against its `testdata/plugin-sync`
bundle rather than one from this repo, exercises a compatible code-only
upgrade with existing bindings and no duplicate writes. An unresolved approved effect blocks
replacement by an upgrade or rollback and resumes against its original release.
Changed mapping/checkpoint formats still need explicit migration tests.

## Remaining maintenance work

- Dedicated vendor sandbox accounts and a separately authorized live-test runner
  with fixture ownership, budgets, cleanup and secret isolation. Current manual
  live checks are recorded in planning, not fabricated as CI certificates.
  [The bounded run contract](./LIVE_TESTING.md) defines scope and cleanup; it is
  not yet an automated runner.
- Capability-to-test evidence mapping and verified third-party evidence delivery.
- Mapping/checkpoint migration tests and staged release rollout.
- Health monitoring, provider-change alerts and ownership escalation.
- Reusable provider fixture builders and UI installation coverage for both pilots.
- An app's signing key is node-local (upstream `atomic-server`, checked at
  `.atomic-server-ref`). Its public agent resource syncs; the secret half in
  `Tree::AppAgent` does not, and nothing carries it to another node
  (activating a JS Installation there mints a _different_ agent instead). A
  node that received the drive by sync reads the missing key as legacy. There,
  `POST /app-write` refuses with "no key of its own", and a scheduled or
  plugin run signs as that node's own agent rather than the app. Treat
  app writes and unattended runs as single-node until upstream decides the
  "second node" question in its `planning/plugins.md`
  ([#41](https://github.com/ontola/atomic-plugins/issues/41)).

No recurring live jobs or automatic releases are enabled by this command.

Shared provider sign-in supports direct and managed deployments; see
[authorization service setup](AUTHORIZATION.md) for the common FOSS transport,
per-server provisioning, credential handling and current limits.

## Portable package resources (initial library API)

`@tomic/lib` can import an app definition from a standalone JSON document. See
[`app-package.json`](../browser/lib/src/fixtures/app-package.json) for the format:
metadata, a revision URI, the existing `PluginRelease` payload, and optional
validated setup metadata. No provider module needs to be imported by the host.

```ts
import {
  appPackageSchema,
  ensureSchema,
  prepareAppPackageImport,
  planVerdict,
  planHostFromStore,
} from '@tomic/lib';

const schema = await ensureSchema(store, drive, appPackageSchema());
const verdict = prepareAppPackageImport(
  importHost,
  json,
  packageFolder,
  schema,
);
const plan = await planVerdict(verdict, planHostFromStore(store));
// Show this plan for review, then use the existing applyPlan path.
```

`importHost` must read authoritative destination resources, as with other shared
imports; an incomplete UI collection is not sufficient for duplicate detection.
`readAppPackage(resource.getPropVals(), schema)` reads back the portable document.
The content uses canonical JSON text so generic graph-reference rewriting cannot
alter code or literal setup text. Top-level display labels reserve the `local:`
prefix, matching the importer. The document limit is 4 MiB.

Import produces an inert `app-package` resource under the host-chosen parent.
Repeated imports reuse its native localId. Use a new revision URI for changed
content; reusing one causes a conflict. That URI is an import identity, not a
verified signature or server release hash. Metadata is untrusted, and importing
never executes source. Package authors must not embed secrets in source/data.

The package-supplied manifest must still be compared with the sandbox-extracted
manifest during activation. Fresh installation identity, host-held credentials,
consent and schedule activation belong to installation, never the distributed
document. Imported packages are not yet exposed in the store UI or installable
through a generic sandbox setup. Schema bindings currently refer to external
resources; bundled schema/template graphs remain future work.
