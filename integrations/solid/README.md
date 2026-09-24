# Solid

Status: **scaffold**. No protocol handler, listener or installable bundle is
implemented here yet. CI checks the planning contract; a green lane is not
protocol conformance or live verification.

## Scope

Expose a bounded Atomic resource collection through a Solid-compatible server surface.

## Host requirements

Target runtime: **QuickJS**, with JavaScript/TypeScript bundled to JavaScript.
Plugins cannot load native Rust crates or open sockets. The host must expose
inbound requests through a scoped JavaScript API first.

Proposed capabilities: `http-routes`, `outbound-http`, `persistent-state`.
These are design requirements, not an existing Atomic plugin API. Route and
transport ownership are specified in the [accepted server route design](../../docs/design/server-plugin-routes.md),
but have not been implemented at this repository’s pinned host.
The host must own credentials, authorization, resource limits and lifecycle.

## First interoperability milestone

Authenticate a test client and read one authorized resource while denying another identity.

## Implementation checklist

- [ ] Choose the initial Solid protocol and authorization profile explicitly.
- [ ] Define RDF/resource mapping and credential ownership before implementing routes.
- [ ] Test identity validation, access control, content negotiation and conditional writes.

- [ ] Add protocol fixtures and executable tests here, covering the milestone
      and denied access before changing the status to `implemented`.
- [ ] Record the peer/version, command and result when live interoperability
      has actually been verified.

## CI

From the repository root:

```sh
node integrations/tooling/run-lane.mjs solid
```

The `Lane: solid (contract)` lane validates `plugin.json`, this README and
checks that this scaffold stays explicitly unimplemented. Add source, fixtures
and protocol tests in this folder, then replace the `contract` tier with
executable implementation checks in the same change.

## Placement and blocked host work

The first slice is a resource server (placement C), with a WebID profile
and a single bounded collection. It is not a Solid identity provider.
QuickJS-compatible JavaScript RDF parsing must be evaluated within the host
fuel, memory and response limits before extending that scope. The design's
possible future Rust/WASI parsing path is not available to this plugin and
is not a dependency added by this PR.

The accepted design requires host gates, routes and well-known discovery
(atomic-server#1711–#1716), scoped writes (#1717), host-held keys and token
validation (#1718), and blob bodies (#1720). DPoP validation and broader
HTTP methods such as PATCH are further phase-3 requirements in the design;
do not treat generic bearer validation as Solid-OIDC compatibility.
Notifications and a Solid IdP are outside this initial milestone.

Public routes require all three planned gates: a host built with
`plugin-routes`, the operator's `--plugin-routes read-write` switch, and
per-installation consent. A build without the feature, including
atomic.place's intended build, cannot activate this surface. The plugin
never receives private signing keys or serves an Atomic login page.

Before implementation, choose and record a protocol version, authorization
profile (WAC or ACP), supported RDF media types and exact byte/record bounds.
The milestone must test an independent Solid client and denied access, not
only a mock that repeats the implementation.
