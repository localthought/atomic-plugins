# Fediverse

Status: **scaffold**. No protocol handler, listener or installable bundle is
implemented here yet. CI checks the planning contract; a green lane is not
protocol conformance or live verification. `plugin.json` is planning metadata,
not an AtomicServer runtime manifest.

## Scope

Expose one ActivityPub actor with an inbox and durable outbound delivery jobs.

This is the single-actor phase 2 package described as
`integrations/activitypub/` in [#137](https://github.com/ontola/atomic-plugins/issues/137)
and AP-05 of the accepted [server route design](../../docs/design/server-plugin-routes.md).
Its folder and CI lane are named `fediverse`; this scaffold does not complete
that implementation issue.

The intended split is sandbox routes (placement C) for actor/object reads,
inbox receipt and bounded outbox/follower collections, plus sandbox jobs
(placement B) for outbound deliveries and retries. WebFinger resolves the
actor; NodeInfo and generated host-meta use the host's discovery dispatcher.
The first profile is one actor, not a multi-user social server. Shared inbox
support and the supported ActivityStreams activity types need a separate
scope decision before implementation.

## Host requirements

Target runtime: **QuickJS**, with JavaScript/TypeScript bundled to JavaScript.
The plugin cannot load native Rust crates, open sockets or keep a delivery
queue alive in invocation memory. Route dispatch, persistent scoped writes
and durable queued jobs must come from the host.

Proposed capabilities: `http-routes`, `outbound-http`, `persistent-state`,
`background-jobs`. These are design requirements, not an existing Atomic
plugin API. The host owns HTTP signature verification on inbound requests,
HTTP signing for deliveries and authorized fetches, and the actor's private
key. The plugin gets scoped signing operations, never private key material
or a secret copied into its JavaScript bundle.

The accepted route design requires all three gates: AtomicServer compiled
with the `plugin-routes` Cargo feature, the operator setting
`--plugin-routes read-write` or `ATOMIC_PLUGIN_ROUTES=read-write`, and explicit
per-Installation consent after reviewing the public endpoints and writes.
atomic.place builds without the feature. The route grant bounds inbox writes;
host quotas and egress checks bound queued deliveries, including wildcard
peer destinations. Closing a gate must pause pending deliveries.

Implementation depends on these host issues being available at the pin:

- [atomic-server#1711](https://github.com/ontola/atomic-server/issues/1711),
  [#1712](https://github.com/ontola/atomic-server/issues/1712) and
  [#1713](https://github.com/ontola/atomic-server/issues/1713): gates,
  manifest v3 and installation review.
- [atomic-server#1714](https://github.com/ontola/atomic-server/issues/1714),
  [#1715](https://github.com/ontola/atomic-server/issues/1715) and
  [#1716](https://github.com/ontola/atomic-server/issues/1716): route mounts,
  sandbox request execution and discovery dispatch.
- [atomic-server#1717](https://github.com/ontola/atomic-server/issues/1717):
  scoped route writes, quotas and provenance.
- [atomic-server#1718](https://github.com/ontola/atomic-server/issues/1718):
  host-held keys and HTTP signature operations.
- [atomic-server#1719](https://github.com/ontola/atomic-server/issues/1719):
  durable delivery queue and guarded wildcard destinations.
- [atomic-plugins#134](https://github.com/ontola/atomic-plugins/issues/134):
  gated catalog, certification and a route-enabled test host.

## First interoperability milestone

Deliver and receive one supported activity with one independent Mastodon or GoToSocial peer, persist it once when redelivered, and resume a queued delivery after a host restart.

This is a target, not evidence. Select the activity type and record the peer
version, actor setup, exact commands and results when it is actually tested.

## Implementation checklist

- [ ] Specify the initial activity types, actor/resource mapping, discovery
  claims and content negotiation; define request byte limits, collection
  page limits and permitted write targets.
- [ ] Implement bounded inbox validation with host-verified signatures,
  authorization and persistent activity-ID deduplication.
- [ ] Use host signing and the durable queue for outbound delivery; specify
  retry/backoff, per-peer concurrency and terminal failure limits.
- [ ] Test invalid signatures, unauthorized writes, duplicate delivery,
  blocked peers, retry exhaustion, restart recovery and gate closure.
- [ ] Add protocol fixtures and executable tests here before replacing the
  scaffold contract tier; test gate refusal on an unsupported host.
- [ ] Record independent peer/version interoperability evidence before
  describing a capability as verified. Keep #137 open until its remaining
  implementation and evidence requirements are complete.

## CI

From the repository root:

```sh
node integrations/tooling/run-lane.mjs fediverse --tier contract
```

The `Lane: fediverse (contract)` lane validates `plugin.json` and this README.
It uses no provider fixture (`platforms` is empty) and does not run protocol
handlers. Add implementation checks and live evidence before promoting this
scaffold to an implemented plugin.
