# Open Cloud Mesh

Status: **scaffold**. No protocol handler, listener or installable bundle is
implemented here yet. CI checks the planning contract; a green lane is not
protocol conformance or live verification. `plugin.json` is repository planning
metadata, not a host manifest or installable release.

## Scope and placement

Federated sharing between Atomic and another cloud server. The first target is
an OCM share **receiver**, placement C (sandbox routes) plus B (outbound delivery
jobs), phase 2 of the [accepted route design](../../docs/design/server-plugin-routes.md).
This folder is the `ocm` package described there and tracked in
[receiver implementation #138](https://github.com/ontola/atomic-plugins/issues/138);
this scaffold does not complete that issue. Serving shared content over
WebDAV and sending shares is a separate phase 3 milestone, not part of the
initial receiver. Protocol handling remains unimplemented.

## Host requirements

Target runtime: **QuickJS**, with JavaScript/TypeScript bundled to JavaScript.
This plugin cannot link native Rust crates or open sockets. The host creates a
fresh sandbox for each run; share state must live in scoped Atomic resources,
not process memory. The current sandbox supports jobs, but inbound routes and
the federation primitives below are planned, not implemented at the pin.

Proposed capabilities: `http-routes`, `outbound-http`, `persistent-state`,
`background-jobs`. These labels describe requirements, not existing manifest
fields. The host owns authorization, credentials, signing, quotas and lifecycle.

The receiver depends on these tracked host changes:

- [Gates #1711](https://github.com/ontola/atomic-server/issues/1711),
  [manifest v3 #1712](https://github.com/ontola/atomic-server/issues/1712), and
  [install review #1713](https://github.com/ontola/atomic-server/issues/1713).
- [Route registry #1714](https://github.com/ontola/atomic-server/issues/1714),
  [HTTP execution #1715](https://github.com/ontola/atomic-server/issues/1715),
  and [well-known claims #1716](https://github.com/ontola/atomic-server/issues/1716)
  for discovery and share/notification endpoints.
- [Route writes #1717](https://github.com/ontola/atomic-server/issues/1717),
  [host signatures and tokens #1718](https://github.com/ontola/atomic-server/issues/1718),
  and [durable deliveries #1719](https://github.com/ontola/atomic-server/issues/1719)
  for persisted share decisions and outbound notifications.
- [Gated-plugin tooling #134](https://github.com/ontola/atomic-plugins/issues/134)
  and a host pin containing those changes before executable route certification.

Every public endpoint requires all three accepted gates: a server built with
Cargo feature `plugin-routes`, operator runtime level `read-write` through
`--plugin-routes` or `ATOMIC_PLUGIN_ROUTES`, and per-Installation consent.
atomic.place builds omit the feature, so this receiver cannot be hosted there.
The gates themselves still need implementation; setting metadata here enables
nothing. Discovery-only anonymous GET/HEAD routes could use `read-only`, but
that is insufficient for receiving shares.

## First interoperability milestone

Exchange one share with a test peer and persist its accepted or rejected state.
For this first receiver milestone, the peer sends the share to Atomic; Atomic
records the decision and delivers the corresponding notification. Record the
chosen peer and OCM version before implementing its wire contract.

## Implementation checklist

- [ ] Define share-to-resource mapping, ownership, durable identity and revocation.
- [ ] Implement bounded discovery and receiving a share through host-managed routes.
- [ ] Test duplicate deliveries, rejected peers, unauthorized writes, signature
  failures, quotas, retry behavior and restart recovery with synthetic fixtures.
- [ ] Verify host egress policy on peer destinations and keep all key material
  in host-held credentials.
- [ ] Add protocol fixtures and executable tests here before changing status to
  `implemented`; prove the gates refuse activation when unavailable.
- [ ] Record the independent peer/version, command and outcome after live
  interoperability has actually been verified. No such evidence exists yet.

## CI

From the repository root:

```sh
node integrations/tooling/run-lane.mjs open-cloud-mesh --tier contract
```

The `Lane: open-cloud-mesh (contract)` lane validates `plugin.json`, this README
and the explicit scaffold status. It needs no provider mock or live peer. Add
source, fixtures and protocol tests in this folder, then replace the `contract`
tier with executable implementation checks in the same change. Contract checks
cannot establish that the receiver works.

## OpenGeoMesh Rust crate assessment

Documentation checked 2026-09-24: [`opencloudmesh` 0.2.1](https://docs.rs/opencloudmesh/latest/opencloudmesh/)
describes an OCM 1.3.0 implementation with discovery, shares and notifications;
invitation flow is unfinished. It exposes HTTP-client and persistence interfaces,
uses `ocm-types`, and points to `ocm-drivers` and `ocm-server-axum` as companion
references. Persistence and resource exchange are left to the integrator.

The [OpenGeoMesh repository](https://codeberg.org/OpenGeoMesh/OpenCloudMesh-rs)
is a potential source reference, not a directly usable QuickJS dependency.
This is a documentation assessment, not a source audit or integration test;
review source and license terms before adapting implementation details. The
host's Rust implementation is separate from this JavaScript plugin.

Use its documented discovery/share flow to inform fixtures, after choosing the
peer compatibility target. The [OCM specification repository](https://github.com/cs3org/OCM-API)
lists 1.5.0 as its latest official version at this assessment date, so the
crate's 1.3.0 scope does not establish latest-spec compatibility. OCM exchanges
access information; fetching the shared resource needs another protocol such
as WebDAV. Invitation flow and content serving remain later work.
