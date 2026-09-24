# NextGraph

Status: **scaffold**. No adapter, broker, listener or installable bundle is
implemented here. CI checks planning metadata; a green lane is not protocol
conformance or live verification. `plugin.json` is not a runtime manifest.

## Scope

Evaluate a bounded QuickJS data adapter to an operator-managed NextGraph broker.

The [accepted server plugin design](../../docs/design/server-plugin-routes.md#3-per-protocol-feasibility)
places the NextGraph broker (`ngd`) in **E** (sidecar, phase 4). Its long-lived
WebSocket connection, session state and NextGraph encryption/key lifecycle do
not fit a stateless QuickJS invocation. This folder tracks adapter feasibility,
not a broker implementation. It adds no native Rust crate, executable or sidecar.

The browser client is a separate **A** placement: the browser store backend in
atomic-server's `planning/nextgraph-interop.md`, referenced by the accepted
design. That client does not run in the server QuickJS sandbox and is outside
this scaffold's scope.

## Host requirements

Target runtime: **QuickJS**, with JavaScript/TypeScript bundled to JavaScript
for bounded adapter jobs only. Plugins cannot directly load Rust crates or
keep a broker WebSocket/session alive across invocations.

Proposed capabilities: `peer-transport`, `persistent-state`, `background-jobs`.
These are planning requirements, not existing callable plugin APIs. A scoped
host/sidecar operation must expose bounded document access, keep broker
sessions and credentials outside the sandbox, enforce authorization and byte
limits, and define retries/checkpoints before adapter implementation can start.

The accepted design's phase 4 **AS-13** listener/sidecar access depends on
**AS-01** gates and **AS-02** manifests; it still requires a design and a host
implementation merged and pinned here. Operator exposure requires all three
[public-surface gates](../../docs/design/server-plugin-routes.md): the
`plugin-routes` Cargo build feature, `--plugin-routes`/`ATOMIC_PLUGIN_ROUTES`
runtime level, and per-installation consent. Sidecars additionally require
operator `ATOMIC_PLUGIN_SIDECARS` configuration. These are pending host
requirements, not settings this metadata activates. atomic.place excludes the
build feature. A per-message WebSocket hook alone does not establish that
NextGraph sessions fit the sandbox.

## First interoperability milestone

After scoped host broker access exists, transfer one explicitly mapped document of at most 64 KiB from Atomic to an authorized NextGraph test broker and read it back with field-for-field equality.

Pin the broker/client versions and document encoding, and keep any encryption
keys in the approved host/broker boundary. Use two explicitly authorized test
identities plus one denied identity. Verify denied read/write leaves both
stores unchanged; disconnect before acknowledgement, retry, and verify one
logical document with no duplicated write. This is an adapter milestone, not
broker conformance or general graph/CRDT synchronization. No evidence exists yet.

## Implementation checklist

- [ ] Resolve AS-13's scoped operation, host gates and supported broker interface.
- [ ] Select a compatible client and document encoding; assess licensing,
  encryption/key custody, identity mapping and any merge semantics.
- [ ] Specify the 64 KiB limit, job timeout, cancellation, checkpoint and retry
  behavior before implementing bounded JavaScript jobs.
- [ ] Add fixtures and executable tests for round-trip fidelity, denied access,
  oversize rejection, disconnect and retry inside this folder.
- [ ] Replace the contract tier before marking the adapter implemented.
- [ ] Record the peer versions, command and results of independent live interop;
  capabilities remain declared until that evidence exists.

## CI

From the repository root, with Node only:

```sh
node integrations/tooling/run-lane.mjs nextgraph
```

`Lane: nextgraph (contract)` validates the planning metadata, README and scaffold
status. It does not execute QuickJS, start `ngd`, or test a NextGraph peer. The
lane has no provider fixture or host setup requirement. Add implementation
checks to this lane when the scoped host interface is available.
