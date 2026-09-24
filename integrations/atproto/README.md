# AT Protocol handle endpoint

Status: **implemented handle responder; no live interoperability evidence**.
This dependency-free QuickJS module implements the HTTPS discovery half of
[AT Protocol handle resolution](https://atproto.com/specs/handle). It is not
a Personal Data Server, DID document publisher, OAuth service or firehose.

`plugin.mjs` exports a real schema-version-3 manifest and `handle(ctx, request)`.
The manifest uses `drive-host`, declares an anonymous GET/HEAD `/atproto-did`
route, and claims `/.well-known/atproto-did` exclusively. The host's well-known
registry dispatches the latter to that route. A configured GET returns HTTP 200,
`Content-Type: text/plain`, and only the DID bytes. HEAD has identical metadata
and an empty body. Requests perform no Atomic reads/writes or outbound calls.

## Configure and deploy

Installation config:

```json
{
  "handle": "user.example.com",
  "did": "did:plc:ewvi7nxzyoun6zhxrhs64oiz"
}
```

Use your actual identity and hostname; the values above are examples. Handles
are normalized to lowercase and validated as production DNS names, bounded to
253 characters. Reserved suffixes, whitespace, IP addresses and invalid labels
are rejected. DID validation accepts 24-character lowercase base32 `did:plc`
identifiers and production hostname-only `did:web` identifiers. Other methods,
paths, ports, query/fragment suffixes and injection strings are rejected. This
checks syntax, not DID existence or ownership. See the
[AT Protocol DID rules](https://atproto.com/specs/did).

Deploy only on a drive whose **sole approved hostname matches `config.handle`**,
with public HTTPS on port 443. The inspected host
`35504494261f59e922e79d536fd437954451e6a3` binds routes to drive hostnames and
requires drive-owner approval for the exclusive claim. It requires the
`plugin-routes` build feature, the operator's `--plugin-routes read-only` switch,
and installation consent. A competing claim belongs to host registry conflict
handling; this plugin cannot override it. atomic.place needs those gates too.

**Current host limitation:** `route_exec.rs` passes path/wellKnown/method but
neither URL nor authority, and filters Host headers. Consequently the plugin
cannot compare the incoming hostname against the configured handle. All approved
hostnames on the same drive receive the same DID. Do not install on a multi-host
drive expecting per-host identities. Strict per-request matching needs a trusted
host authority field in a future host change. Origin, forwarded headers and
query parameters are deliberately not treated as host identity.

Configure the DID document at its authoritative publisher to link back to
`at://<handle>` and independently verify it. This responder supplies only the
handle-to-DID direction; clients must verify the reverse direction before
trusting the identity. DID signing keys and PDS records remain outside this
plugin.

## Failures and limits

Missing or invalid config returns generic 503 without reflecting config data.
Other routes/paths/well-known names return 404. Unsupported methods return 405
(defense in depth: the host manifest restricts methods before execution).
All responses are `no-store`, so an identity change does not retain a plugin
cache lifetime. No redirects or dynamic headers contain configuration values.
`run(ctx)` validates config and returns no intents.

## Build and CI

```sh
node integrations/atproto/build.mjs
node integrations/tooling/run-lane.mjs atproto --tier node
```

The build produces `integrations/atproto/dist/plugin.js` and `manifest.json`.
It copies the self-contained module verbatim; no Node dependency reaches the
QuickJS payload. Thirteen Node tests exercise the host manifest/request shape,
GET/HEAD, exact DID bytes, dispatch mismatch, invalid configuration, method
refusal, hostile headers, production handle/DID syntax, and reproducible builds.
The build test executes the emitted ESM as well as checking its manifest.

No live QuickJS or Atomic HTTP deployment, gate/claim collision integration test,
or independent public resolver has been run. Record the resolver version, test
hostname, DID and bidirectional result before claiming live verification.

The manifest declares every consumed installation configuration field using the
host-supported string/object schema. Conditional fields are checked by the entry
point: both handle and did are required before installation use.
