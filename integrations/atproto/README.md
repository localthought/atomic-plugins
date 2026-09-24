# AT Protocol

Status: **scaffold**. No protocol handler, listener or installable bundle is
implemented here yet. CI checks the planning contract; a green lane is not
protocol conformance or live verification. `plugin.json` is planning metadata,
not a host installation manifest.

## Scope

Serve a configured DID at `/.well-known/atproto-did` for one explicitly configured handle.

This is the handle-only sandbox route (placement C, phase 1) assessed in the
[accepted server route design](../../docs/design/server-plugin-routes.md#3-per-protocol-feasibility).
The response reads already configured identity data; it does not resolve remote
identities, write records, or make outbound requests during an inbound call.
A bounded outbound public-record reader (placement B, phase 0) could be an
independently useful future slice without public-route gates, but is not
implemented or declared by this scaffold.

A full Personal Data Server (PDS) and its persistent WebSocket firehose are
unsuitable for this QuickJS plugin. Signed repository storage, CAR export,
OAuth and relay coordination belong to the separately assessed phase 4 PDS
sidecar, with an optional client bridge. No native Rust code, Rust crate,
sidecar implementation or persistent socket is added here.

## Host requirements

Target runtime: **QuickJS**, with JavaScript/TypeScript bundled to JavaScript.
The sandbox starts fresh per invocation and cannot open sockets or load native
Rust crates. Proposed capability: `http-routes`. This names a design dependency,
not an existing plugin API or a claim that routes run at the current pin.

The handle route depends on the phase 1 host work: gates, manifest v3 and
install review, route registry and execution, and the exclusive `atproto-did`
well-known dispatcher (AS-01 through AS-06, tracked in
[atomic-server#1711](https://github.com/ontola/atomic-server/issues/1711)
through [#1716](https://github.com/ontola/atomic-server/issues/1716)).
Gated catalog and certification tooling also needs
[atomic-plugins#134](https://github.com/ontola/atomic-plugins/issues/134)
(AP-02), with the host dependencies merged and pinned. Coordinate the exclusive
claim with the design's `well-known` package (AP-03); two Installations cannot
own the same handle endpoint. A vanity handle needs the `drive-host` mount and
drive-owner approval; an API-origin claim requires operator configuration.

All three [public-route gates](../../docs/design/server-plugin-routes.md#0-gating-build-flag-runtime-switch-install-consent)
are required: a host built with the Cargo feature `plugin-routes`, an operator
runtime level of at least `read-only` via `--plugin-routes` or
`ATOMIC_PLUGIN_ROUTES`, and explicit per-Installation consent. atomic.place
builds exclude the feature. Read-only route execution must not perform writes
or outbound requests. Until the host dependencies land and are pinned, this
folder cannot expose a handle endpoint.

## First interoperability milestone

An independent AT Protocol identity resolver resolves one configured handle through its HTTPS well-known endpoint to the configured DID.

Record the resolver implementation/version, configured handle, DID, command and
result. Test that conflicting exclusive claims are refused, unconfigured
handles do not leak a DID, and closing any gate prevents public resolution.
Use a public test hostname and a test identity whose DID document confirms the
handle, so the resolver can complete identity verification. This milestone does
not establish PDS compatibility, record round trips or firehose support.

## Implementation checklist

- [ ] Pin the phase 1 host dependencies and gated certification tooling.
- [ ] Define the handle/DID configuration and exclusive-claim ownership alongside AP-03.
- [ ] Implement the bounded anonymous read-only route and host installation manifest.
- [ ] Add fixtures for configured and unconfigured handles, invalid configuration,
      claim collisions and every closed-gate refusal.
- [ ] Add executable route and sandbox tests before replacing the contract tier
      or changing the status to `implemented`.
- [ ] Record independent resolver evidence before marking a capability verified.

## CI

From the repository root:

```sh
node integrations/tooling/run-lane.mjs atproto --tier contract
```

The `Lane: atproto (contract)` lane validates `plugin.json`, this README and
checks that this scaffold stays explicitly unimplemented. It needs no provider
platform, browser installation or running host. Add executable implementation
checks in this folder when the route becomes available; this planning lane
alone is not protocol certification.
