# remoteStorage

Status: **experimental partial implementation**, targeting QuickJS JavaScript.
This package now contains executable source, a generated standalone `plugin.js`,
a runtime `plugin.json`, an Atomic resource adapter and a Node CI lane. It does
not implement a complete remoteStorage server. No independent client, actual
QuickJS invocation or real host persistence round trip has been verified.

## Implemented

- `run(ctx)` imports a JSON text export through the host's existing
  `ctx.upload.text` contract. It returns ordinary `create`/`set` intents for the
  host to validate, preview, approve and commit to its actual atom store. Returning
  an intent is not a durable HTTP write acknowledgment.
- Each text document is an Atomic resource under `config.table`, with `name`,
  `description`, `localId` and `importBaseline` atoms. The baseline supplies
  the host-required `values` and `previous` snapshots for signed commit conflict
  checks, covering both the title and text. It also retains the
  exact source text, path and media type, including CRLF and Unicode. These are
  ordinary resources, **not DocumentV2 rich-text documents**: the current editor
  reads a Loro `doc` map which sandbox intents cannot construct. No Tiptap JSON
  is written into `documentContent`.
- Repeat imports resolve persisted identities through `ctx.query(parent, table)`
  and `ctx.read(subject)`. Unchanged documents produce no intents, source changes
  propose updates, and local description edits block replacement. A rejected
  batch produces no partial intents. Existing path/file collisions are refused.
- `handle(ctx, request)` serves explicitly exported **public** categories through
  the actual scoped `ctx.query` and `ctx.read` APIs. The anonymous route principal
  means host permissions must permit both anonymous and installation reads.
  Configuring a private parent does not grant it public access.
- Public `GET`/`HEAD`, text media types, SHA-256 ETags, `If-Match`,
  `If-None-Match`, and recursive JSON-LD folder listings are implemented.
  Folder entries use the same version as fetching that subfolder, and nested
  changes invalidate ancestors. Missing folders return empty listings.
- The manifest declares host-owned wildcard CORS without credentials; responses
  expose ETag and list conditional headers. **Preflight OPTIONS dispatch still
  needs host work**: the pinned manifest only accepts six methods, excluding
  OPTIONS. Browser interoperability is therefore not claimed.

The source uses no Node/browser runtime APIs, Rust crates or remote network
libraries. Its synchronous host calls match
`plugin-runtime/src/lib.rs` and `server/src/plugins/js_runtime.rs` at pinned
atomic-server `35504494261f59e922e79d536fd437954451e6a3`.

## Import and public export

Install the generated sandbox bundle using the host's plugin install/import
flow, then configure a parent resource to which the installing actor and
installation both have write access. For example:

```json
{
  "table": "https://atomic.example/remote-documents",
  "publicCategories": {
    "notes": "https://atomic.example/remote-documents"
  }
}
```

Upload a JSON file through the host's importer:

```json
{
  "documents": [
    {
      "path": "/public/notes/hello.txt",
      "contentType": "text/plain; charset=utf-8",
      "text": "Hello from remoteStorage.\n"
    },
    {
      "path": "/notes/private.json",
      "contentType": "application/json",
      "text": "{\"draft\":true}"
    }
  ]
}
```

Review/apply the returned changes. The first resource is eligible for export at
`/_routes/<installation-slug>/storage/public/notes/hello.txt` only when host
permissions also allow anonymous reads. The second is never exported by these
routes. `publicCategories` is an explicit mapping, not a token scope or a request
supplied parent. A source category need not be public to import its text.

The host needs all three endpoint gates: the `plugin-routes` build feature,
`--plugin-routes read-only` (or a higher operator level), and per-installation
endpoint consent. This plugin does not alter those gates. atomic.place does not
provide the build feature.

Limits are 256 KiB per JSON upload/text document, 128 resources per queried
parent, and 32 path segments. HTML, binary files, traversal, encoded separators,
ambiguous paths, duplicate identities and incomplete/denied host queries fail
closed. There is no pagination. A category read consists of separately scoped
resource reads; it is not an atomic multi-resource snapshot. Edited description
atoms cause a visible import conflict and public reads return 503 rather than
silently exporting an obsolete source baseline; reconciliation is manual.

## Required host work for writable remoteStorage

No bearer token is accepted by this plugin and **no PUT or DELETE route is
registered**. The current host drops authorization headers, sets `caller: null`,
and returns `route-auth-unavailable` for bearer/caller routes
(`server/src/plugins/route_exec.rs`). It also rejects `body: blob`; the QuickJS
prelude has no durable write, blob read/write or transaction API. A plugin-local
map or a successful preview cannot substitute for those facilities.

The next host adapter needs these semantics; these are requirements, not
invented callable `ctx` methods:

1. A host-verified principal bound to installation, user, category and `r`/`rw`,
   with expiry and revocation enforced at effect time. OAuth consent, WebFinger
   and token issuance must stay host-owned (AS-08/AS-06).
2. An installation-scoped request-body blob handle, length and media type,
   plus scoped reads/response handles backed by the real Atomic blob store.
   Binary content must not be stuffed into description atoms (AS-10).
3. A durable transaction keyed by installation/user/path that checks the
   current version and scope, promotes the blob reference, creates/updates or
   removes the real Atomic resource, and updates every ancestor version
   together. Stale `If-Match`/`If-None-Match` must leave all state unchanged.
   A durable commit receipt must precede any successful PUT/DELETE response;
   crash recovery must reclaim staged orphan blobs and retries must be safe
   (AS-07). Reviewed importer intents are not this transaction mechanism.
4. OPTIONS preflight routing, bounded complete folder snapshots, quotas and
   live interoperability tests with an independent remoteStorage client.

Full implementation remains tracked in
[#136](https://github.com/ontola/atomic-plugins/issues/136). The protocol sources
are the [remoteStorage specification](https://github.com/remotestorage/spec)
and [protocol overview](https://remotestorage.io/protocol).

## Validation

```sh
node integrations/remotestorage/build.mjs
node integrations/tooling/run-lane.mjs remotestorage --tier node
node integrations/tooling/run-lane.mjs remotestorage --tier e2e
node --experimental-strip-types integrations/remotestorage/verify-host.mjs /path/to/pinned/atomic-server
```

The node lane executes 14 tests covering import identity/update conflicts,
Unicode byte counts and hashing, folder versions, read preconditions, category
and parent confinement, host denials, malformed paths, unavailable writes and
bundle reproducibility. Its fixture applies intent-shaped objects in memory to
exercise the adapter; this is **unit evidence only**, not real host persistence.

`verify-host.mjs` separately invokes the pinned host's real `validateManifest`
and `parseVerdict` source functions on this implementation's manifest and import
output. It passed at the pin above. This verifies source contracts, not a
QuickJS run, host transaction or browser client exchange. `build.mjs --check`
checks both generated artifacts without rewriting them.

The E2E tier uses the normal host file-import UI and the unchanged production
bundle. It publishes a release, configures its original source draft, uploads text,
captures the actual `/plugin-run` response, confirms preview alone writes
nothing, approves the change and reloads the resulting atom values. It then
checks duplicate import, source update and preservation of a real local edit.
There is no mock host or simulated persistence in this test. A passing run
would verify the importer path; it would not establish remoteStorage bearer
HTTP interoperability, blob support or independent client compatibility.

Test discovery, lint and lane configuration checks pass. Runtime execution is
being verified separately; a locally built binary of unknown commit provenance
is only a development probe, not certification against `.atomic-server-ref`.

The standard E2E server lacks the optional `plugin-routes` feature, so the
production HTTP release is correctly hidden from installable catalog cards.
The importer test runs its unchanged source draft through `/plugin-run`; it
does not certify route installation or bypass the catalog feature gate.
