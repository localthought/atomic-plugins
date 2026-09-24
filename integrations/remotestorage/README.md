# remoteStorage

Status: **scaffold**. No protocol handler, listener or installable bundle is
implemented here yet. CI checks the planning contract; a green lane is not
protocol conformance or live verification. `plugin.json` is planning metadata,
not an executable plugin manifest or a declaration of available host APIs.

## Scope and placement

Expose an authorized subset of Atomic data to remoteStorage clients. The
accepted [server route design](../../docs/design/server-plugin-routes.md)
places the storage endpoints in **C: sandbox routes**, planned for phase 2.
Implementation is tracked in [#136](https://github.com/ontola/atomic-plugins/issues/136);
this scaffold does not complete that work.
Target runtime: **QuickJS**, with JavaScript/TypeScript bundled to JavaScript.
The plugin cannot load native Rust crates or open sockets; inbound HTTP must
arrive through the host's scoped route API.

Reflector's `src/remotestorage/` is an existing remoteStorage **client**, not
this proposed server implementation. It remains in Reflector.

## Host requirements and gates

`plugin.json` retains the proposed capability labels `http-routes`,
`outbound-http` and `persistent-state`. These are planning categories, not
existing Atomic plugin API names. This first server milestone requires no
background delivery queue or arbitrary outbound HTTP. Per-request QuickJS
memory cannot serve as persistent storage: documents need host-managed blob
storage, folders need Atomic resources, and conditional writes need atomic
host-side version checks.

The host dependencies in the accepted design are:

- Route registration, HTTP invocation and WebFinger discovery of the storage
  root and authorization URL (AS-04–AS-06).
- Scoped write targets, quotas, provenance and durable document/folder state
  (AS-07), with blob request and response bodies (AS-10).
- Host-owned bearer tokens scoped to categories (`category:r` or
  `category:rw`), revocation, expiry and a host-owned consent page (AS-08).
  The authorization route redirects to that page on the API origin, where
  the user's Atomic session approves the requested scopes. The host returns
  a one-time code to the route. The plugin never serves a login or consent
  form and never receives host key material.
- Manifest, catalog, installation review and certification support for gated
  routes (AS-01–AS-03 and AP-02). Dependencies must be merged and pinned before
  this folder can become an installable server plugin.

Every public endpoint needs all three gates: an AtomicServer build with the
Cargo feature `plugin-routes`, the operator's
`--plugin-routes read-write` or `ATOMIC_PLUGIN_ROUTES=read-write` runtime
setting, and explicit consent for this Installation's endpoints and grants.
These are host prerequisites, not plugin configuration that bypasses a gate.
atomic.place builds without that feature. See
[Public endpoints need a gated server](../README.md#public-endpoints-need-a-gated-server).

## First interoperability milestone

Connect a test client, write and read one document, and reject access outside
its granted scope. Record the independent client's name and version, exact
commands and results before describing that milestone as verified.

The storage surface must support `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS`,
folder listings, correct CORS responses, and `ETag`, `If-Match` and
`If-None-Match` semantics. A successful write response must mean the document
was durably stored. Failed preconditions must leave the existing blob and
folder state unchanged. CORS does not grant access: every protected operation
must enforce the token's user, category and read/write scope.

## Implementation checklist

- [ ] Define document/blob and folder/resource mapping and atomic version checks.
- [ ] Implement WebFinger discovery and authorization through host-owned consent.
- [ ] Implement bounded document access, folder listings and CORS responses.
- [ ] Test conditional writes, concurrent stale updates, revoked/expired tokens,
      category boundaries, read-only grants and cross-user isolation.
- [ ] Add protocol fixtures and executable tests here, covering the milestone
      and denied access before changing the status to `implemented`.
- [ ] Record live interoperability evidence against an independent client or
      remoteStorage test suite; passing metadata checks is not that evidence.

## CI

From the repository root:

```sh
node integrations/tooling/run-lane.mjs remotestorage --tier contract
```

The `Lane: remotestorage (contract)` lane validates `plugin.json` and this
README, including the explicit scaffold status. It has no provider platforms
and does not require the browser dependency tree or a running server. Add
source, fixtures and protocol tests in this folder, then replace the
`contract` tier with executable implementation checks in the same change.
