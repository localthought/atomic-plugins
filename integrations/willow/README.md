# Willow live sync

Status: **scaffold**. No WGPS engine, peer transport or installable bundle is
implemented here. CI checks a planning contract, not protocol conformance or
live interoperability.

## Scope

Evaluate a bounded QuickJS adapter to a host-owned Willow live-sync engine.

This folder covers the live-sync assessment in the accepted
[server plugin design](../../docs/design/server-plugin-routes.md#3-per-protocol-feasibility).
The existing [Willow drop importer](../willow-drop/README.md) already provides
the supported file workflow, with its own `willow-drop` CI lane. It is a
separate sandbox job and does not establish live-sync support.

## Host requirements

The `runtime: quickjs` planning metadata applies only to a proposed bounded
JavaScript/TypeScript adapter. QuickJS cannot load native Rust crates or open
sockets. WGPS needs a reliable bidirectional stream and long-lived session
state; its full live engine cannot run in the current stateless QuickJS
invocation model. The accepted design places that engine in **D (server
extension) or E (sidecar)**, phase 4. This scaffold adds neither a native
service nor an engine.

Proposed capabilities: `peer-transport`, `persistent-state`, `background-jobs`.
These describe dependencies, not available manifest declarations. A
host-mediated WebSocket with one fresh invocation per message remains an
**unverified** alternative; implementation selection must first prove that
state, resource limits and authorization can survive that model. Host transport
ownership and bridge APIs remain design work in
[atomic-server#1722](https://github.com/ontola/atomic-server/issues/1722) and
[atomic-server#1723](https://github.com/ontola/atomic-server/issues/1723).

The host must hold credentials, bind Meadowcap authority to approved datasets,
limit sessions and transfer budgets, persist only authorized state, and own
cancellation and cleanup. Any future listener or exposed route must follow the
accepted design's build feature `plugin-routes`, operator switch
`--plugin-routes` / `ATOMIC_PLUGIN_ROUTES`, and per-plugin install consent.
These proposed gated surfaces are not available on atomic.place.

## First interoperability milestone

Prove a bounded adapter bridge to a selected Willow engine with authorized dataset access and denied unauthorized access before attempting live synchronization.

Record the implementation and version, chosen placement, required host APIs,
and evidence that the bridge can resume safely across fresh invocations. If
that cannot be demonstrated, retain D/E engine ownership and record the blocker;
do not claim WGPS support. After feasibility, a separate milestone can test one
bounded dataset between two independent peers.

## Implementation checklist

- [ ] Select an engine and document its placement, transport and bridge boundary.
- [ ] Prove invocation/state feasibility, session limits and safe cancellation.
- [ ] Define namespace, Meadowcap capability and Atomic resource mappings;
      reject unauthorized reads and writes before transferring data.
- [ ] Add fixtures for revoked access, reconnects, interrupted transfers and
      conflicting updates once the bridge exists.
- [ ] Replace the planning tier with executable adapter and authorization tests
      before changing status to `implemented`.
- [ ] Record peer/version, command, scope and results only after actual live
      interoperability has been verified.

## CI

From the repository root:

```sh
node integrations/tooling/run-lane.mjs willow
```

The `Lane: willow (contract)` lane validates `plugin.json` and this README.
It requires no provider fixture and does not test the engine, host bridge or
existing drop importer. The file workflow remains covered separately by the
`willow-drop` lane's typecheck, unit and e2e tiers.
