# Solid resource bridge

Status: **partial implementation**, targeting the resource model in
[Solid Protocol 0.11.0](https://solidproject.org/TR/2024/protocol-20240512).
This is not a conforming Solid server: Solid-OIDC/DPoP, WAC/ACP, containers,
full Turtle syntax, N3 PATCH, notifications and binary storage are not implemented.

## Runnable behavior

`plugin.mjs` is dependency-free QuickJS JavaScript exporting the host's actual
schema-version-3 `manifest`, `run(ctx)` and `handle(ctx, request)` entry points.
No browser globals, Node imports, native libraries or sockets enter the bundle.

- A reviewed sandbox job validates one text/plain, supported text/turtle, or expanded application/ld+json
  document and emits the existing host `create` intent, storing it as an actual
  Atomic `PlainText` resource. Name, MIME type, local identity and the original body
  in description are real Atomic properties. The
  host reviews and applies the intent to its atom store; this function does not
  claim a commit has already happened. RDF bytes are preserved, not falsely
  flattened into unrelated Atomic predicates. The body is stored as a plain-text
  atom; this does not populate a rich-text
  DocumentV2 editor, whose content uses Loro and cannot be seeded through these
  simple intents.
- An explicitly configured public export is served from **actual `ctx.read`**
  on GET/HEAD `/_routes/<installation-slug>/resources/<id>`. The anonymous host
  principal enforces Atomic read ACLs. A private resource and unknown export both
  return 404. The export mapping grants no access by itself.
- Reads validate the stored representation and negotiate Turtle/JSON-LD from the
  same RDF graph using Accept quality weights (including exact q=0 exclusions),
  include the appropriate LDP RDFSource/NonRDFSource Link, support If-None-Match,
  and omit HEAD bodies. Returning the original media type preserves its stored
  bytes; conversion generates a bounded representation and a distinct ETag. Plain
  text is not promoted to RDF. Weak content validators are only cache validators;
  they cannot satisfy strong If-Match except the existence wildcard `*`.
- Every mutation fails closed, with no write intents from HTTP handling. An
  existing import identity blocks subsequent jobs to prevent blind overwrites.
  Simultaneous reviewed jobs still need host-side identity/concurrency handling;
  the preflight query is not a transaction.

The parser accepts expanded JSON-LD arrays of at most 128 named nodes and 512
statements: absolute IRIs, @type, named-node references, and string literals
with optional language or datatype. Compact JSON-LD, contexts, blank nodes,
lists, graphs and numeric values are rejected. Exact numeric lexical strings
can carry an RDF datatype. Bodies are capped at 32,768 UTF-8 bytes; names at
256 characters; export/import IDs at 64 ASCII letters, digits, `_` or `-`.

The Turtle parser implements an explicit subset of [RDF 1.1 Turtle](https://www.w3.org/TR/turtle/):
absolute IRIs with Unicode escapes, `@prefix`/`PREFIX` with ASCII prefix/local
names (no dotted or escaped names), `a`, predicate/object lists, comments, short
single/double quoted strings, escapes, language/datatype suffixes, and bare
integer/decimal/double/boolean forms. Numeric lexical forms remain strings.
Base declarations, relative IRIs, blank nodes, collections, long strings and
other Turtle syntax are rejected. This is not a full Turtle processor.

Turtle parsing caps expanded statement accounting at 32,768 UTF-8 bytes (subject,
predicate and JSON value bytes plus 32 bytes per statement), in addition to the
128-node/512-statement limits. This conservative budget prevents large prefix
expansion. Generated response bodies are also capped at 32,768 bytes while being
built. A requested converted representation that exceeds the cap returns 406;
the native representation remains available. A malformed stored body returns
415, and an import fails before proposing any write.

## Configuration

For a reviewed job, set the installation's config to:

```json
{
  "parent": "https://your-server.example/folder",
  "document": {
    "id": "hello",
    "name": "Hello",
    "mediaType": "text/plain",
    "body": "Hello from Solid"
  }
}
```

After reviewing/applying the create intent, take its actual assigned Atomic
subject and configure `exports: {"hello": "<actual subject>"}`. Routes serve
only the exports map, never the pending import config. Grant public read on the
resource in Atomic only if public access is intended. The route's principal
is permanently anonymous; request headers cannot upgrade it to an owner.

## Host gaps and storage boundary

Inspected host source: `35504494261f59e922e79d536fd437954451e6a3`.
`plugin-runtime/src/lib.rs` exposes read/query/http/integration; it exposes no
blob read/write API. `server/src/plugins/route_exec.rs` explicitly refuses
route write intents (AS-07/#1717) and auth modes other than none (AS-08/#1718).
Binary request/response bodies require AS-10/#1720. Its response-header allowlist
also lacks Allow/Accept-Put/WAC-Allow, so this handler does not emit headers that
would cause host rejection or claim permissions it cannot verify.

Consequently inbound Solid PUT/DELETE cannot yet persist atom or blob data.
The working storage path is an operator-authorized, reviewed sandbox import
job followed by host-permission-checked public reads. It does not masquerade as
an authenticated upload. Completing that path needs host-scoped atomic writes,
conditional commit tokens, authenticated identities, and blob APIs. Public
routes also require the Cargo plugin-routes feature, operator read-only switch,
and per-install consent; atomic.place cannot expose them without those gates.

## Build and verification

```sh
node integrations/solid/build.mjs
node --test integrations/solid/plugin.test.mjs integrations/solid/turtle.test.mjs
node integrations/tooling/run-lane.mjs solid --tier node
```

The build creates `integrations/solid/dist/plugin.js` and `manifest.json`.
Thirty-nine executable Node tests cover RDF/text intent and read round-trips,
permission denial, path isolation, mutation refusal, lexical preservation,
parser rejection, bounds, RDF negotiation, conditional reads and reproducible bundles.
Seven selected official W3C Turtle cases run unchanged with upstream expected
results, alongside hand-authored grammar and security cases. The fixture
[provenance and license](fixtures/w3c/README.md) identify the pinned source; this
is not the complete conformance suite. Tests use the
real documented ctx/intent shape with host doubles. **No running Atomic Server,
actual commit, QuickJS execution, external Solid client or blob round-trip has
been live verified.** A green lane establishes this bounded implementation's
unit behavior, not complete protocol interoperability.

The manifest declares every consumed installation configuration field using the
host-supported string/object schema. Conditional fields are checked by the entry
point: parent/document for import jobs, exports for public reads. No field is globally
required because import-only and route-only configurations are both valid.
