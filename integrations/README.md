# Integration maintenance

Each provider lives in its own directory and ships a bundled ES module. The
runtime, permissions, reconciliation and recovery stay shared. Packages remain
experimental until their advertised capabilities have current live evidence.

Named actions, automation permissions, recovery and MCP setup are documented in
[ACTIONS.md](ACTIONS.md). The MCP stdio protocol test runs in the JS CI gate.

## One certification command

From the repository root:

```sh
node integrations/tooling/certify.mjs
```

Or from `browser`: `pnpm certify:integrations`.
This discovers every integration with a `package.json`, validates required
metadata/files, checks the committed bundle against a fresh build, typechecks,
runs fixture tests, and runs exact named Rust tests through QuickJS/WASM.
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

CI's JS gate discovers all providers. Rust CI mounts the complete integration
folder so compiled sandbox tests can include shipped bundles and manifest
fixtures. `dagger call integration-certification-report export --path ./report`
exports the JS-layer evidence. The full local command includes sandbox evidence;
CI's exported JS report deliberately does not claim its separate Rust gate ran.

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

A host reads a package's `version` (directly, or via `catalog.json`) at
install time to record which release an installation is pinned to, and later
compares it against this repo's current `version` to offer an update. Bump
`package.json` `version` (and the matching catalog entry) whenever an
integration's shipped `plugin.js` changes.

## Building an uploader plugin

A file-upload importer — like **Bank statements** (`integrations/money/`,
which reads MT940 and camt.053 bank statement exports) — is not a special
plugin kind with its own base class or interface. It is an ordinary
server-executed sandbox plugin (see [Two plugin runtimes](../AGENTS.md#two-plugin-runtimes))
whose `run(ctx)` reads file contents that UI code already collected, instead
of calling `ctx.http` against a provider. Everything else — config
declaration, `importRecords`, identity/reconciliation — is the same
contract every importer plugin follows.

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

This is the other plugin runtime from [Two plugin runtimes](../AGENTS.md#two-plugin-runtimes):
no server sandbox, no `plugin.js` executed by QuickJS. It runs entirely in
the browser against a remote platform's HTTP API, through **LocalThought**
(the remote OAuth/API proxy at `https://localthought.io`, or a
self-hosted `integration-proxy`) and its supporting engines. Read
[`integrations/localthought/README.md`](localthought/README.md) for the
end-to-end connect/install/refresh flow before adding a new platform; this
section explains where the terms **reflector**, **syncables** and
**Devonian** fit, and when to reach for which.

### The stack, top to bottom

- **LocalThought** — the OAuth/API proxy. It owns provider credentials
  (never the browser or AtomicServer), publishes a **catalog** of supported
  platforms, and for each platform serves the provider's OpenAPI document
  (already patched with the overlays it needs — see below) plus a default
  query selection. A plugin declares which platform it targets with a
  plain string, not a class: `Config.platform` in
  `integrations/localthought/plugin.ts`, or `catalog.json`'s per-entry
  `"platform"` field.
- **`BrowserIntegrations`** (`integrations/localthought/browser.ts`) — the
  browser-side client class; an instance of it, constructed with browser
  `Storage` and the proxy origin, **is** "a localthought instance" from a
  plugin's point of view. It runs PKCE OAuth, manages the rotating-code
  connection, and exposes `catalog()`/`request()` as a generic authenticated
  proxy call. **It does not read or sync an OpenAPI document itself** —
  that used to happen through an injected `Engine`
  (`describeIntegration`/`fetchIntegration`) backed by a WASM build of a
  vendored **syncables** Rust crate, but that bridge lived in the wrong
  repo: it depended on `atomic-server`'s WASM build
  (`wasm/src/integrations.rs`, `wasm/Cargo.toml`) and has been removed from
  here entirely. A caller that needs full OpenAPI-driven sync composes its
  own such engine on top of `BrowserIntegrations`'s `request()` — that's
  `atomic-server`'s responsibility now, not this repo's.
  **The rotating connection code never leaves `browser.ts`.** It is a
  live bearer credential: `browser.ts` keeps it in browser `Storage` and
  hands callers only an opaque connection id. Never write it into an Atomic
  resource — not an App resource, not config, not an import record. A
  resource syncs and its drive can later be shared, and the proxy has no
  per-code revocation
  ([#21](https://github.com/ontola/atomic-plugins/issues/21)). A drive plugin or App may store only a
  non-secret connection reference: `platform`, plus a `connectionId` once
  the persistent connections planned in
  [#40](https://github.com/ontola/atomic-plugins/issues/40) exist. Until
  #40 and [ontola/atomic-server#1624](https://github.com/ontola/atomic-server/issues/1624)
  land, proxy requests for a sandboxed drive-plugin frame are made by the
  parent page, never by the frame itself. `localthought/no-credentials-in-graph.test.mjs`
  (`node --test`, run by CI's "Tooling unit tests" step)
  fails the build if any shipped source under `integrations/` contains a
  `…/properties/…connection-code` URL, or mentions `x-connection-code`
  outside `browser.ts`. It is a text scan, not data-flow analysis, so it
  won't catch a code stored under an unrelated property name.
- **Syncables** — the OpenAPI-mock/sync-client engine that reads a
  platform's document plus its
  [CRUD Causality Extension](https://github.com/pondersource/openapi-extensions/tree/main/spec/crud-causality)
  (`components.crudResources`) block, discovers a resource model (identity
  bindings, collections, nested collections — e.g. a repo's issues, then
  each issue's comments), and drives a full paginated read into local
  storage, deriving a neutral Atomic-Data-shaped ontology as it goes. This
  is the mechanism that lets a connector support a new platform's _shape_
  purely from spec annotations, "nothing about issues, comments, calendars
  or events is compiled in" (`sync/resource_model.rs`).
- **Reflector** ([`localthought/reflector`](https://github.com/localthought/reflector) /
  `reflector-rs`) — the sync-engine/plugin-runtime layer one level above
  syncables; `SyncClient`'s `ClientConfig` contract is written to match
  what `reflector-rs`'s `src/syncables.rs` already expects, field-for-field,
  so the two are meant to converge. A "reflector plugin," in this repo's
  vocabulary, is a connector built on this sync-engine layer rather than on
  the plain OpenAPI-mock-and-mirror layer syncables also provides on its own.
- **Devonian** — a separate, native browser-local resource-lens/storage
  engine (vendored bundle at
  `browser/data-browser/src/chunks/DevonianDemo/devonian.js`), used only
  when a connector needs **two-way, local-first sync**: native Atomic-shaped
  resources stored in WASM/OPFS + IndexedDB, "lenses" that project a
  provider's shape onto those native resources, and checkpointed
  three-way reconciliation. No AtomicServer instance or plugin executor is
  involved at all for a Devonian connector.

### Two shapes, pick one

**(a) One-way import through the generic LocalThought flow — no lens
needed unless you're reshaping fields.** This is the default and the
smallest amount of new code. Add a `catalog.json` entry with `"platform":
"<your-platform-id>"` so LocalThought's setup dialog handles OAuth and the
generic `integrations/localthought/plugin.ts` maps fetched records onto
Atomic properties/classes via `Config.destinations`/`.properties`/`.records`.
Write a **lens** only if the platform's raw fields need reshaping before
they become a table — a pure function over `FetchedPlatform`/`FetchedRecord`
(types in `integrations/localthought/schema.ts`), run _after_ the engine has
already fetched and paginated:

```ts
import type {
  FetchedPlatform,
  FetchedRecord,
  Term,
} from '../localthought/schema.js';

export function myPlatformProjection(
  fetched: FetchedPlatform,
): FetchedPlatform {
  if (fetched.platform !== 'my-platform') return fetched;
  // add/derive fields on fetched.records, extend fetched.ontology.terms
  return {
    ...fetched,
    ontology: {
      /* ... */
    },
    records: [] /* ... */,
  };
}
```

`integrations/timesheets/localthought.ts` (`clockifyProjection`) is the
reference: it adds two derived `start`/`end` timestamp terms, drops
in-progress/break entries, and leaves every other provider field untouched.
Pair it with a query-override function if the connector needs per-run
parameters (`clockifyImportQuery()` supplies a rolling look-back window) —
merging that with the platform's default selection is done by whatever
composes `BrowserIntegrations` with a sync engine (see above), not by
anything in this repo. Use
`platformSchema()`/`termKey()` from `localthought/schema.ts` to turn
discovered `Term`s into a `SchemaSpec` generically — prefixed
`lt-<platform>-<kind>-<shortname>` to avoid collisions across platforms.

**(b) Two-way, local-first sync — a Devonian lens.** Needed when the
connector must let local edits flow back to the provider (closing an issue,
editing a title) without a server round-trip. Model this on
`integrations/issue-tracker/devonian/`:

- `bridge.mjs` — Devonian lenses and checkpointed three-way reconciliation.
- `ports.mjs` — native-Atomic and provider-side projections/transports.
- `build.mjs` — regenerates the vendored Devonian bundle:
  `DEVONIAN_PATH=/path/to/devonian node integrations/issue-tracker/devonian/build.mjs`.

Give every native resource a stable identity independent of matching text
(explicit provider IDs bind existing rows; nothing infers identity from
title/body equality), journal writes before sending them (the provider side
has no idempotent create, so an uncertain/lost response must stop rather
than retry blindly), and treat a missing record as a conflict to resolve,
never an implicit deletion. Add a `catalog.json` entry with the `(Devonian)`
naming convention (`devonian-<platform>`) and, unless it reuses the generic
LocalThought setup dialog, its own `callback-platform`.

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

**`localthought/overlays`** is the upstream collection of ready-made overlay
files for real providers (an external repo/catalog, not a directory in this
checkout) —
[`syncables/__tests__/fixtures/real-world/`](../syncables/__tests__/fixtures/real-world/)
vendors overlay and OpenAPI fixtures unmodified from it and from apis.guru,
with provenance in each file's header comment. When adding a new platform
connector, check there first for an existing overlay before writing a new
one; when you do write a new overlay, keep the same minimal-diff spirit —
patch what the provider's spec is missing, don't restate what it already
declares correctly.

Overlays are applied before an OpenAPI document ever reaches this repo's
`BrowserIntegrations`: `integration-proxy/` (LocalThought) applies them
server-side and serves the already-patched document. A native (non-browser)
caller of the `syncables` npm package can instead apply them itself via
`ClientConfig.document`/`.overlays` file paths — a convenience that only
exists off the browser/WASM path.

## Adding or changing an integration

1. Supply `plugin.ts`, reproducible `plugin.js`, `tsconfig.json`,
   `vitest.config.ts`, README and `atomicCertification` in `package.json`.
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
The two bundled store cards expose these results on demand, checking the actual
shipped source hash before showing owner, version, date and check count. Results
older than 30 days are labelled. Third-party catalog entries remain unverified.
These results contain no live-provider certification or per-capability claims.

The GitHub sandbox regression exercises a compatible code-only upgrade with
existing bindings and no duplicate writes. An unresolved approved effect blocks
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
