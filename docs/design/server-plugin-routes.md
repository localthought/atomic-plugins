# Server plugin routes: placement rules and inbound endpoints

Status: **design accepted, with the gating amendment in section 0. Nothing
here is implemented.** Written for
[atomic-plugins#88](https://github.com/ontola/atomic-plugins/issues/88) as a
companion to
[ontola/atomic-server#1535](https://github.com/ontola/atomic-server/issues/1535)
(where a plugin runs when a session has no server runtime). Michiel reviewed
it on PR #108: every public-surface feature must be gated at build time
**and** at run time, on top of per-plugin install consent; the rest was
accepted as proposed ("sounds good"), so section 4 now records decisions
instead of open questions.

Sections 1–3 are based on atomic-server at `bae5cdbe3` (2026-09-23).
Section 0 was checked against `2f403624e`, the commit pinned in
`.atomic-server-ref` when the gating was added (2026-09-24). Limits marked
*proposed* are starting numbers for review, not measurements. No protocol in
section 3 has been prototyped against this design, so its feasibility column
is an assessment on paper.

Contents:

0. [Gating: build flag, runtime switch, install consent](#0-gating-build-flag-runtime-switch-install-consent)
1. [Where does plugin code run?](#1-where-does-plugin-code-run)
2. [Inbound routes: the proposal](#2-inbound-routes-the-proposal)
3. [Per-protocol feasibility](#3-per-protocol-feasibility)
4. [Phased plan and decisions](#4-phased-plan-and-decisions)
5. [Implementation issue drafts](#5-implementation-issue-drafts)

---

## What exists today

This design builds on the following facts, all true at the pinned atomic-server commit:

- **The server sandbox is QuickJS inside wasmtime.** `plugin-runtime/` embeds
  QuickJS (rquickjs) as a WASI component that exports
  `run(source, input) -> verdict`. `server/src/plugins/js_runtime.rs`
  compiles that component once and creates a new store and instance for every
  run. The other guest kind is the WASM class extender
  (`server/src/plugins/wasm.rs`). Both kinds use `host_core.rs` for egress,
  secrets and grants.
- **Host imports are small**: `fetch`, `invoke-action`, `get-resource` and
  `query` (`plugin-runtime/wit`). A plugin has no sockets.
- **Triggers are `manual`, `cron` and `query`** (`scheduler.rs`,
  `triggers.rs`). No trigger fires on an HTTP request, so nothing a plugin
  ships can be reached from outside the server.
- **Limits** (`host_core.rs::limits`). A JS run gets 20G fuel and 256 MiB, or
  200G fuel and 2000 MiB with `extended-fuel`/`extended-memory`. A class
  extender gets 100M fuel and 50 MiB. Egress (`egress.rs`) refuses loopback,
  private, CGNAT and metadata addresses. It pins the resolved address,
  disables redirects, caps responses at 8 MiB and times out after 30 s.
- **Manifest v2** (`manifest.rs`, `deny_unknown_fields`) has these fields:
  `runtime` (`atomic-js/1` | `wasip2/1`), `world` (`extension` |
  `server-extension`), `entrypoints`, `capabilities`, `secrets`,
  `operations`, `actions`, `network`, and the config fields. A release is
  content-addressed over its serialized manifest, so a new field must be
  left out of the serialization when it holds its default value.
- **Runs propose and the host applies.** A `run` returns
  `{ intents, problems, cursor? }`. The host plans the change, then either
  sends it to review or auto-applies it when the source was already reviewed.
  It then applies the change and records receipts.
- **HTTP routing** (`server/src/routes.rs`) is a fixed list of host routes,
  followed by a catch-all `GET`/`POST` that resolves the path as a resource
  subject. `/.well-known/` is served only for ACME challenges (`https.rs`).
  The API origin also accepts **session cookies**
  (`helpers.rs::get_auth_from_cookie`).
- **There is precedent for serving other people's content.** Published
  websites are served only on a separate `ATOMIC_WEBSITE_ORIGIN`
  (`handlers/website.rs`: "customer content is never served on the API
  origin"). `ATOMIC_SERVED_DOMAIN_SUFFIX` plus `Tree::DriveMapping` map
  vanity hostnames to drives.
- **Iframe views** run in a null-origin iframe that only allows scripts, and
  talk to the host through one `FrameBridge`. This repo's drive apps
  (`integrations/pets/app/`, `integrations/notion/app/`) are plain-DOM
  `view({ root, store })` modules. They reach providers through the host's
  integration-proxy relay.

---

## 0. Gating: build flag, runtime switch, install consent

A plugin that opens a public endpoint on the server changes what the server
*is*: it answers strangers, stores what they send, and can make the server
talk to other servers on their behalf. So none of that is reachable through
installing a plugin alone. Each such surface needs **all three** of:

1. **Build gate.** The server was compiled with the Cargo feature
   `plugin-routes`.
2. **Runtime gate.** The operator switched it on for this process with
   `--plugin-routes <level>` or `ATOMIC_PLUGIN_ROUTES=<level>`.
3. **Install consent.** A person who may install plugins on this node
   approved the specific Installation after a review that lists every public
   endpoint (section 2.9).

atomic.place builds leave the feature out, so on atomic.place gates 2 and 3
can never open anything. A self-hoster who wants it builds with the feature,
starts the server with the switch, and then installs the plugin that asks
for it.

### 0.1 Which surfaces are gated

These are the "similarly powerful" features. All of them share the same two
gates. The table gives the minimum runtime level each needs.

| Surface | Where designed | Minimum `--plugin-routes` level | Extra operator config |
| --- | --- | --- | --- |
| Sandbox routes (`http.routes`), `GET`/`HEAD`, `principal: anonymous`, `auth: none` | 2.2, 2.3 | `read-only` | none (`ATOMIC_ROUTES_ORIGIN` for the `installation-origin` mount) |
| Well-known claims, shared and exclusive (`http.wellKnown`) | 2.4 | `read-only` | exclusive names on the API origin: operator config, as in 2.4 |
| Routes with any other method, principal or auth; inbound writes (`writeTargets`); blob request bodies | 2.5, 2.6 | `read-write` | none |
| Host-held keys and tokens (`http.keys`, `http.tokens`) | 2.2, AS-08 | `read-write` | none |
| Route-enqueued deliveries and wildcard-host operations (`enqueues`, `https://*`) | 2.6, D5 | `read-write` | none |
| Host-mediated WebSockets (phase 3) | AS-12 | `read-write` | none |
| Listeners and raw ports (`http.listeners`, `world: server-extension` only) | 2.2, phase 4 | `read-write` | the operator binds each one: `ATOMIC_PLUGIN_LISTENERS=willow-wgps:4455` |
| Sidecar access: declared operations to a loopback daemon, which the egress guard otherwise refuses | 1 (placement E), phase 4 | `read-write` | the operator names each one: `ATOMIC_PLUGIN_SIDECARS=pds=http://127.0.0.1:2583` |

Nothing else is gated by this design. Views (A), jobs (B), class extenders
(D hooks), secrets and outbound operations to fixed hosts work exactly as
today, on every build.

### 0.2 Build gate: the `plugin-routes` Cargo feature

`server/Cargo.toml` gets `plugin-routes = ["wasm-plugins", …]`, **not** in
`default` and not in `light`. It follows the precedent of `vector-search`,
which is also off by default and paired with a runtime opt-in
(`--enable-vector-index`, `serve.rs` `#[cfg(feature = "vector-search")]`).
Crypto dependencies that only these surfaces use (RSA and Ed25519 signing,
HTTP-signature and DPoP verification) are optional dependencies enabled by
this feature, so a build without it does not link them.

Behind `#[cfg(feature = "plugin-routes")]`:

- the route registry, the `installation-origin` host matching and the
  `drive-prefix` handler at `/_routes/…` (AS-04);
- the `http` trigger kind on the host side, the route worker pool, response
  validation and `readRouteStatus` (AS-05);
- the well-known dispatcher, except the existing ACME challenge handler
  (AS-06);
- applying route intents into `writeTargets`, and route quotas (AS-07);
- installation keys, signature verification, the token store and their host
  calls (AS-08);
- the durable delivery queue for route-enqueued operations and the
  wildcard-host egress path (AS-09);
- blob request and response bodies for routes (AS-10);
- WebSockets, listeners and sidecar egress exceptions (AS-12, AS-13).

Compiled into **every** build, so that a refusal can be precise instead of
"unknown field":

- parsing and validating the manifest's `http` block (AS-02), and computing
  which gate level a release needs;
- the `--plugin-routes`, `ATOMIC_ROUTES_ORIGIN`, `ATOMIC_PLUGIN_LISTENERS`
  and `ATOMIC_PLUGIN_SIDECARS` options themselves (see 0.3);
- reporting gate status to clients (0.5);
- reserving `_routes/` in subject creation, so that turning the feature on
  later never collides with existing resources.

The browser (data-browser) has no build gate. It renders what the server
reports.

Build pipelines must name their features explicitly. `.dagger/src/index.ts`
already does (`default`, `light,wasm-plugins`, `https,wasm-plugins`), and
none of those include `plugin-routes`. A `--all-features` build would
include it; AS-01 adds a CI check that the release and atomic.place feature
sets do not. Gated code still needs compiling and testing in CI, so AS-01
also adds a `cargo clippy`/`cargo test --features plugin-routes` job and an
e2e build variant with the feature.

### 0.3 Runtime gate: `--plugin-routes` / `ATOMIC_PLUGIN_ROUTES`

A `clap` value enum in `server/src/config.rs`, in the same style as
`--host-mode`/`ATOMIC_HOST_MODE`:

```rust
/// Lets installed plugins open public endpoints on this server: routes,
/// `/.well-known/` claims, and (with `read-write`) inbound writes, host-held
/// keys and tokens, deliveries, listeners and sidecars. Needs a build with
/// the `plugin-routes` feature. Each plugin still needs its own install review.
#[clap(value_enum, long, default_value = "off", env = "ATOMIC_PLUGIN_ROUTES")]
pub plugin_routes: PluginRoutesLevel, // off | read-only | read-write
```

- **`off`** (default): no gated surface is active, even in a build that has
  the feature.
- **`read-only`**: anonymous `GET`/`HEAD` routes and well-known claims. No
  inbound request can cause a write or an outbound request.
- **`read-write`**: everything in 0.1. This is the operator's opt-in for
  write routes that D2 asked for.

Startup rules:

- The option exists in every build. If it is set to anything other than
  `off`, or `ATOMIC_PLUGIN_LISTENERS`/`ATOMIC_PLUGIN_SIDECARS` is set, in a
  build without the feature, the server **refuses to start** with: "This
  AtomicServer was built without the `plugin-routes` feature, so
  `--plugin-routes read-write` has no effect. Rebuild with
  `--features plugin-routes`, or remove the option." Silently ignoring it
  would leave the operator believing endpoints are live. (`vector-search`
  only warns in the same situation; this is stricter on purpose.)
- `ATOMIC_PLUGIN_LISTENERS` and `ATOMIC_PLUGIN_SIDECARS` are refused at
  startup unless the level is `read-write`.
- With the gate on and no `ATOMIC_ROUTES_ORIGIN`, only the `drive-prefix`
  mount exists, and the server logs that once at startup.

### 0.4 Install consent, and what happens when a gate is off

The host is authoritative; the UI mirrors it. The server checks the gates at
four points:

1. **Install, upgrade and release pin.** From the manifest the host
   computes the level a release needs (`read-only` or `read-write`) and the
   listener and sidecar names it asks for. If the node falls short, the
   install is refused with a typed problem, `host-feature-unavailable`,
   carrying `{ feature: "plugin-routes", needed, compiled, level,
   surfaces }`, where `surfaces` lists what asked for it ("route `POST
   /users/{name}/inbox`", "well-known `nodeinfo`"). The message is one of:
   - not compiled: "This plugin opens public endpoints on the server
     (…surfaces…). This AtomicServer was built without plugin routes, so the
     plugin can't be installed here."
   - compiled, level too low: "This plugin opens public endpoints on the
     server (…surfaces…). The server operator hasn't enabled them. To allow
     it, start AtomicServer with `--plugin-routes read-write` (or
     `ATOMIC_PLUGIN_ROUTES=read-write`)."
   - listener or sidecar not configured: names the missing
     `ATOMIC_PLUGIN_LISTENERS`/`ATOMIC_PLUGIN_SIDECARS` entry.

   An upgrade that raises the needed level is refused the same way, and the
   old release keeps running.
2. **Consent.** With the gates open, the install review lists every public
   endpoint (2.9). An Installation with a gated surface is never created
   without that review: bundled templates, auto-install and drive imports do
   not carry it, and under `host_mode: owner` only the owner can approve it.
3. **Activation.** The gates are re-checked, because the operator may have
   changed them since the review.
4. **Startup.** An active Installation whose release needs more than the
   current gates allow becomes **degraded** (the #1535 outcome): its routes
   and claims are not registered and their URLs answer 404, its queued
   deliveries are paused (not dropped), and its keys, tokens and data are
   kept. Its views and ungated jobs keep working. The Installation page
   says "Public endpoints are turned off on this server" and names the
   switch. Turning the gate back on restores the Installation without a new
   review, as long as the release is unchanged.

### 0.5 Catalog and UI

`GET /plugin-catalog` (and the refusal above) carry the node's gate status:

```jsonc
"hostFeatures": {
  "pluginRoutes": {
    "compiled": true,
    "level": "read-only",           // off | read-only | read-write
    "routesOrigin": "https://routes.example.net", // or null: drive-prefix only
    "listeners": ["willow-wgps"],   // names only, never ports
    "sidecars": []
  }
}
```

Catalog entries (this repo's `catalog.json`, and the host's catalog) carry
the derived requirement, for example `requires: ["plugin-routes:read-only"]`,
so a client can filter without parsing manifests. Then:

- **Not compiled** (atomic.place): gated plugins are **hidden** from the
  catalog list. One line at the end says how many are hidden and why ("3
  plugins need server features this server doesn't have"). A direct link to
  such a plugin shows its page with the refusal text and no Install button.
- **Compiled, level too low**: shown, **marked** with a "Needs public
  endpoints" chip in the status-pill style (`needs-attention`). The Install
  button is disabled, and the text names the switch and the level needed.
- **Gates open**: listed normally. Installing opens the review with its
  "Public endpoints" section (2.10), which is the third gate.

---

## 1. Where does plugin code run?

"QuickJS vs iframe" is really a choice between five placements. Two exist
today, one is what this document proposes, and two are escape hatches for
operators.

| # | Placement | Runs where | Triggered by | Exists? |
| --- | --- | --- | --- | --- |
| A | **Iframe view** | User's browser, null-origin iframe | A person opening the view | Yes |
| B | **Sandbox job** | AtomicServer, QuickJS in wasmtime (or a `wasip2` component, once components can export `run`) | manual, cron, query trigger | Yes |
| C | **Sandbox route** | Same sandbox as B | An inbound HTTP request from anyone | **Proposed here** |
| D | **Server extension** | AtomicServer, installed by the operator, `world: server-extension` | Reads/commits (class extenders); proposed: raw listeners | Hooks yes, listeners no |
| E | **Sidecar** | A separate daemon the operator runs next to AtomicServer, often behind the same reverse proxy | Its own protocol | Outside AtomicServer; only documented here |

### Decision rules

Answer these in order. The first "yes" sets the minimum placement. A package
can use several placements (a view **and** a job **and** routes), and each
part is decided separately.

1. **Does it answer requests from another server or a remote client while no
   user of this drive is present?** Then it needs **C**, or D/E if rule 4
   also applies. A browser tab cannot be a federation endpoint, because it
   has no address and is not always on. Nodeless sessions have no URL at all.
2. **Must it run when no browser tab is open** (a schedule, a trigger on data
   changes, retries of outbound deliveries)? Then **B**. This is the
   `persistent-host` requirement from #1535.
3. **Does it hold a credential that must not reach a browser** (a provider
   API key, a server signing key, an OAuth client secret)? Then **B/C**, with
   the credential in host secrets. The exception is a LocalThought
   connection: its rotating code lives only in the top page's `browser.ts`,
   so **A** may use it through the proxy relay.
4. **Does it need a long-lived connection that it terminates itself** (a
   WebSocket firehose, a raw TCP/UDP/QUIC listener), memory that persists
   across requests, a non-HTTP port, or more sustained CPU than section 2.8
   allows? Then **D** (native Rust, installed by the operator) or **E**. The
   sandbox starts fresh for every invocation, by design, and must stay that
   way.
5. **Must it take part in reading or committing Atomic resources**
   (validation, derived properties)? Then **D**, a class extender. Never C:
   routes answer outsiders, while hooks shape the database.
6. **Otherwise**, use **A**. That covers interactive UI, reading the user's
   own connected accounts, and local-first two-way sync through Devonian. A
   works on nodeless sessions, which B and C never will.

### Examples

| Package / feature | Placement | Why |
| --- | --- | --- |
| Pets drive app (`integrations/pets/app/`) | A | Reads through the proxy relay; no unattended work |
| Notion one-way import, on demand | A | User present; the top page holds the LocalThought connection |
| Notion scheduled sync | B | Rule 2; needs host-held credentials (rule 3) |
| Bank statement upload (`integrations/money/`) | B | Parsing in the sandbox; the product is proposal and review |
| GitHub two-way (`issue-tracker/devonian/`) | A | Local-first, with the journal in the browser; needs no server |
| WebFinger responder for `acct:alice@drive-host` | C | Rule 1; tiny, read-only |
| ActivityPub inbox and outbox for one actor | C + B | The inbox is rule 1; delivery retries are rule 2 |
| remoteStorage server for a drive | C | Rule 1; remote apps call it while the user is away |
| atproto PDS with `subscribeRepos` firehose | E (or D) | Rule 4: WebSocket firehose, MST repo state, relay crawling |
| Willow live sync (WGPS over QUIC/TCP) | D or E | Rule 4: non-HTTP, long-lived transport |
| Willow sideloading "drop" file import | B | A file importer, like `money`; no port at all |
| Folder validation hook | D | Rule 5 |

### How this answers #1535

#1535 asks for a `requires` list in the manifest. This document proposes that
the host **derives** that list from the placement declarations rather than
the author writing it by hand, so the two can never disagree:

| Declared in manifest | Implies `requires` |
| --- | --- |
| `entrypoints.run` + a cron/query trigger | `persistent-host` |
| `secrets` non-empty | `host-credentials` |
| `runtime: wasip2/1` or any B/C code | `wasm-sandbox` |
| `http.routes` or `http.wellKnown` non-empty, read-only surfaces only (section 0.1) | `persistent-host`, `wasm-sandbox`, **`public-origin`** (new), **`plugin-routes:read-only`** (new) |
| any `read-write` surface in section 0.1 | the above, with **`plugin-routes:read-write`** instead |
| `http.listeners` (section 2.2, D only) | `plugin-routes:read-write`, `operator-listener:<name>` (new) |
| sidecar operations (phase 4) | `plugin-routes:read-write`, `operator-sidecar:<name>` (new) |

`public-origin` is a new requirement. A node can have the sandbox and still
be unreachable from the internet: a desktop node behind NAT, an Android node,
or `localhost`. Installing on such a node follows the outcomes #1535
describes:

- refuse the install;
- install in a degraded mode, where routes are off, views and jobs work, and
  the Installation says so;
- delegate to a peer that is the execution owner.

The `plugin-routes:*`, `operator-listener:*` and `operator-sidecar:*`
requirements are the build and runtime gates of section 0. A node that
lacks them **refuses** the install (0.4); degraded mode only happens when a
gate is closed after install.

A node advertises `public-origin` only when the operator has configured a
routes origin (2.3) and the gates are open. The host also runs a
reachability self-check, whose result is shown but does not block (D7).

---

## 2. Inbound routes: the proposal

### 2.1 Principles

1. **The host terminates everything.** TCP, TLS, HTTP parsing, body limits,
   signature checks and rate limiting all happen in Rust. The sandbox
   receives a small, validated JSON request and returns a JSON response. It
   still has no sockets.
2. **One invocation per request.** A route handler is a sandbox run with a
   new trigger kind, `http`. Nothing survives between requests except what is
   stored in Atomic resources, connection state and host-held stores.
3. **Routes are declared, reviewed and registered at activation.** A plugin
   cannot add a route at run time. The install review lists every public
   path.
4. **Other people's traffic never reaches the API origin's cookies.** By
   default, routes are served on a separate origin (2.3).
5. **Routes follow the same authority model as jobs.** A route acts as an
   explicit principal. Its effective rights are that principal's rights ∩ the
   installation's grants ∩ the declared capabilities (the rule in
   `host_core.rs`).

### 2.2 Manifest additions

The manifest gets a new, optional `http` block. It is left out of the
serialized manifest when empty, so existing release ids do not change.
Because `Manifest` uses `deny_unknown_fields`, older hosts already reject a
manifest that has this block, and rejection is the right outcome. The
version is still bumped to `schemaVersion: 3`, so that an older host's
refusal can say "needs a newer host" instead of "unknown field" (D9). A host
that understands v3 but has the gates closed refuses with the specific
message from section 0.4. A v3 manifest without an `http` block is accepted
everywhere v3 is understood.

```jsonc
{
  "schemaVersion": 3,
  "runtime": "atomic-js/1",
  "world": "extension",
  "entrypoints": { "run": true, "view": "ui.js" },
  "http": {
    // Where the routes live. See 2.3.
    "mount": "installation-origin",          // | "drive-host" | "drive-prefix"
    "routes": [
      {
        "id": "actor",
        "path": "/users/{name}",             // literal segments, {param}, trailing {*rest}; no regex
        "methods": ["GET", "HEAD"],
        "principal": "anonymous",            // | "installation" | "caller"
        "auth": "none",                      // | "atomic" | "http-signature" | "bearer" | "dpop"
        "accept": ["application/activity+json", "application/ld+json"],
        "cors": "none"                       // | "any-origin-no-credentials"
      },
      {
        "id": "inbox",
        "path": "/users/{name}/inbox",
        "methods": ["POST"],
        "principal": "installation",
        "auth": "http-signature",
        "maxBodyBytes": 262144,              // proposed default 256 KiB, host max 1 MiB
        "body": "json",                      // | "text" | "blob" (host stores it; handler gets a hash)
        "writes": ["inbox-items"],           // ids from http.writeTargets; see 2.6
        "enqueues": ["deliver"],             // declared operations it may schedule; see 2.6
        "timeoutMs": 3000
      }
    ],
    "wellKnown": [
      { "name": "webfinger", "kind": "shared", "match": { "resourcePrefix": "acct:" }, "route": "webfinger" },
      { "name": "nodeinfo",  "kind": "exclusive", "route": "nodeinfo-links" }
    ],
    "writeTargets": [
      { "id": "inbox-items", "parent": "config:inboxTable", "classes": ["https://…/classes/Activity"] }
    ],
    "keys": [
      { "name": "actor-key", "alg": "rsa-sha256", "reason": "Signs deliveries to other fediverse servers" }
    ],
    "tokens": [
      { "name": "storage", "reason": "Bearer tokens this plugin issues to remoteStorage apps" }
    ],
    "reason": "Lets other fediverse servers follow and message this drive's actor."
  },
  "operations": [
    { "id": "deliver", "method": "POST", "url": "https://*/inbox", "effect": "write" }
  ]
}
```

What each part does:

- **`mount`** selects one of the namespaces in 2.3. The operator decides
  which origins exist. The manifest only states which ones the package can
  work with.
- **`path`** patterns are matched by the host router, not by plugin code.
  Patterns cannot use regex or overlap within one installation. An
  installation can declare at most 32 routes (*proposed*).
- **`principal`** and **`auth`**: see 2.5.
- **`wellKnown`** claims: see 2.4.
- **`writeTargets`** and **`enqueues`** are the only writes a route can
  cause without a person present (2.6).
- **`keys`** are host-held keypairs. They belong to the Installation, not
  the release, so they survive upgrades. The plugin can ask the host to sign
  with a key or to publish its public half, but never reads the private
  half. This follows the existing `secret:<name>` handle model.
- **`tokens`** is a host-held store of hashed bearer tokens that the plugin
  issues and revokes (remoteStorage, Solid, the OCM `token` endpoint).
  Tokens never go into Atomic resources, for the same reason the rotating
  LocalThought code does not: resources sync, and drives get shared.
- **`operations`** gets a wildcard-host form. It is allowed only for
  operations listed in `enqueues`, whose destination comes from data (for
  example an inbox URL learned from a remote actor). The egress guard still
  checks every request. Wildcard hosts are accepted on these terms, and
  only on nodes at `read-write` (D5).
- **`http.listeners`** (not shown) is accepted **only** in
  `world: server-extension` installed by the operator. Even then it only
  requests a port; the operator must bind it in server config
  (`ATOMIC_PLUGIN_LISTENERS=willow-wgps:4455`), which needs the build and
  runtime gates of section 0. A user-installed `extension` never gets a raw
  port. This document does not design listener semantics
  further (see phase 4).

### 2.3 Path namespaces and origins

Atomic uses its path space for resource subjects, and the API origin carries
session cookies. So plugin routes do not go on the API origin by default.

| Mount | URL shape | Who configures | Good for | Cost |
| --- | --- | --- | --- | --- |
| `installation-origin` (**default**) | `https://<installation-slug>.<ATOMIC_ROUTES_ORIGIN>/…` | The operator sets `ATOMIC_ROUTES_ORIGIN`, wildcard DNS and TLS, exactly as for `ATOMIC_WEBSITE_ORIGIN` | Anything; the full path space and its own `/.well-known/` | Needs a wildcard cert; identity URLs contain an installation slug |
| `drive-host` | `https://<drive vanity host>/…` via `Tree::DriveMapping` | The drive owner, on a host mapped to their drive | Handles like `@alice@alice.example` | Shares the host with the drive's own resources, so only non-colliding paths (below) |
| `drive-prefix` | `https://<api origin>/_routes/<installation-slug>/…` | Nobody; always available | Development, and protocols that accept any base URL (remoteStorage storage root, Solid storage, OCM endpoint URL) | Same origin as the API, so the **host strips cookies and Atomic auth headers** and refuses `text/html` responses and `Set-Cookie` |

Rules:

- `installation-slug` is derived from the Installation subject. It is never
  reused after uninstall; otherwise a new package could inherit the old one's
  federation identity.
- **Reserved paths** on any shared host:
  - everything registered in `routes.rs` (`/commit`, `/ws`, `/upload`,
    `/plugin-*`, `/integration-*`, `/search`, …);
  - `/.well-known/acme-challenge/`;
  - on API and drive hosts, any path that resolves to an existing resource.

  Subject creation must also reserve `_routes/`, so that no resource can be
  created under it (issue draft AS-04; the reservation itself is compiled into every build,
  section 0.2).
- **Collisions are refused at activation**, not resolved at request time.
  The registry is keyed on `(host, method, normalized pattern)`. Overlapping
  patterns from different installations on the same host (`/users/{a}` vs
  `/users/me`) count as a collision. The refusal is a typed problem that
  names the other installation, and the install review renders it.
- Routes are served **only on the connection's execution owner** (the "one
  owner per job" rule from `extension-architecture.md`). A node that received
  the drive by sync does not register them. Otherwise two nodes would answer
  as the same federated identity, each with different state.

### 2.4 Well-known claims

Each host has only one `/.well-known/<name>`, so claims come in two kinds:

- **Shared** names are multiplexed by the host. `webfinger` is dispatched on
  its `resource` query parameter. `host-meta` is generated by the host from
  the WebFinger registrations. A claim registers a match: `resourcePrefix`,
  for example `acct:` plus the handles on this host that the installation
  owns. The host answers 404 for resources nobody matched. No installation
  sees another installation's queries.
- **Exclusive** names: `nodeinfo`, `ocm`, `atproto-did`, `solid`,
  `oauth-authorization-server`, `oauth-protected-resource`,
  `openid-configuration`, `did.json`. Only one installation per host can
  claim each. Who approves the claim depends on the host:
  - On an `installation-origin` host, the installation owns them
    automatically.
  - On a `drive-host`, the drive owner approves the claim in the install
    review.
  - On the API origin, only the operator can grant one (in server config),
    because that origin's identity belongs to the operator.

The host keeps a fixed allowlist of names that can be claimed and refuses
anything else. This stops plugins from creating `/.well-known/` entries that
other software on the host would interpret (for example `change-password` or
`security.txt`).

### 2.5 Auth and identity: which agent a request acts as

There are two separate questions. **Who sent the request** is authentication,
done by the host. **As whom the handler reads and writes** is set by the
route's `principal`.

Authentication (`auth`) is verified in Rust before the sandbox starts:

| `auth` | Host verifies | Handler receives |
| --- | --- | --- |
| `none` | nothing | `request.caller = null` |
| `atomic` | Atomic signed headers (`x-atomic-*`), never cookies | `caller = { agent }` |
| `http-signature` | draft-cavage-12 **and** RFC 9421 signatures. Fetches the `keyId` document through the egress guard (5 s timeout, 64 KiB cap) and caches keys per installation | `caller = { keyId, owner }`; the plugin decides what that remote actor may do |
| `bearer` | a token issued through this installation's `tokens` store, with its scopes | `caller = { token: { id, scopes } }` |
| `dpop` | DPoP proof + access token (Solid-OIDC, atproto OAuth). Fetches the issuer's JWKS through the egress guard | `caller = { webid or did, clientId }` |

A request that fails verification gets a 401 from the host. The sandbox never
runs, so floods of failed-auth requests cost no fuel.

The principal (`principal`) decides who `ctx.read`, `ctx.query` and intents
act as:

- **`anonymous`**: reads as the public agent, so only publicly readable
  resources are visible. This is the default for `GET` routes. It is the only
  option for routes on the `drive-prefix` mount unless they use
  `auth: atomic`.
- **`installation`**: reads as the installation's agent within its grants,
  and writes only to `writeTargets`. Federation endpoints normally use this,
  because the plugin answers from its own data.
- **`caller`**: only allowed with `auth: atomic`. Effective rights are the
  caller's rights ∩ the installation's grants ∩ the declared capabilities,
  the same intersection interactive views use.

Remote identities (an ActivityPub actor, a Solid WebID, a remoteStorage app)
are **not** Atomic agents, and are never silently mapped onto one. The plugin
stores what it knows about them (followers, share recipients, the scopes of
issued tokens) as data, and decides for each request. The install review says
so plainly: "Anyone on the internet can call these endpoints; this plugin
decides what they may see."

### 2.6 Request and response lifecycle

```text
remote peer
   │ HTTPS
   ▼
AtomicServer router ──(no match / paused)──▶ 404 / 503 Retry-After / 410
   │ route registry: (host, method, pattern) → installation, route id, pinned release
   ▼
admission: status active? method & content-type allowed? body ≤ maxBodyBytes
           (streamed, refused early)? rate limit per installation and per
           remote address/keyId? route pool has a free slot? else 413/415/429/503
   ▼
authenticate (2.5) ──fail──▶ 401, sandbox not started
   ▼
body: json/text → inline string;  blob → stored in blob store, handler gets { hash, size, type }
   ▼
sandbox run, trigger = { kind: "http", route, request: { method, path, params, query,
       headers (allowlisted), body | blob, caller, receivedAt } }
       fuel/memory/deadline from 2.8; ctx.read/query as principal; ctx.http only for
       declared read operations; ctx.keys.sign, ctx.tokens.*, ctx.verify.* host calls
   ▼
verdict = { response: { status, headers, body | blob }, intents, enqueue, problems }
   ▼
validate response: header allowlist, no Set-Cookie/HTML on shared hosts, CORS only as
       declared, X-Content-Type-Options: nosniff, size ≤ cap
   ▼
apply intents (only into writeTargets, signed by the installation agent, via the
       shared apply/importer path) — before the response is sent, so a 2xx means stored
   ▼
enqueue: durable jobs for declared write operations, executed by the scheduler with
       receipts and backoff (never inline)
   ▼
send response; record a sampled run-log entry (all non-2xx, a sample of 2xx)
```

**Why intents apply without a review per request.** Jobs are reviewed because
they change existing data on a schedule. Route writes are the whole point of
a federation endpoint (a delivered message gets stored), and no person can
approve each one. The compromise follows the existing rule in
`plugin-runtime-v1.md` that auto-apply requires a reviewed source:

- The install review approves a **route grant**: this release may create and
  update resources of these classes under these parents, and nothing else.
  It may only update or delete resources the installation created itself
  (the commit signer records that provenance).
- An upgrade that widens `writeTargets` needs a new review. The old release
  keeps serving until that review is done.
- Quotas: at most N resources created per remote caller per hour, and M per
  installation per day (*proposed*: 100 and 10,000). Past that, the host
  returns 429. This contains spam but does not moderate it; moderation stays
  in plugin logic.

**Why outbound effects never run inline.** If an inbound request could
synchronously trigger outbound requests, the server would become an
amplifier (one POST fanning out to thousands of inboxes), and its response
time would depend on third parties. So a route can only **enqueue** declared
write operations. The scheduler runs them through the existing
external-intent journal (`approveExternalIntent`, receipts, an "uncertain"
state for lost responses) with exponential backoff. ActivityPub delivery and
OCM notifications both fit this model. A route can call `ctx.http` inline
only for declared **read** operations, at most 2 per request (*proposed*),
and within the route's deadline.

### 2.7 Security model

| Threat | Mitigation |
| --- | --- |
| Theft of sessions or credentials through content a plugin serves | The default mount is a separate origin. On `drive-prefix`, the host strips cookies and Atomic auth headers before the sandbox runs, refuses `text/html` and `Set-Cookie`, and forces `nosniff`. Routes that serve HTML (OAuth consent screens) are only allowed on `installation-origin`. |
| SSRF via attacker-supplied URLs (`keyId`, actor, inbox, OIDC issuer) | Every fetch goes through `egress.rs`, including the host's own key and JWKS fetches: public addresses only, pinned resolution, no redirects, size caps. Key and JWKS fetches are cached per installation, with a short negative cache. |
| Amplification | Inline egress is limited to declared reads, at most 2 per request. Deliveries only go through the durable queue, with a concurrency limit per destination. |
| Route collisions and hijacking | A static registry that refuses collisions at activation; reserved host paths; slugs never reused; exclusive well-known names need approval from the drive owner or operator. |
| DoS / fuel exhaustion | Routes get their own worker pool, separate from jobs, so inbound floods cannot starve schedules. Per-installation limits on concurrency and queue depth, per-remote rate limits, and early refusal of oversized bodies. Failed auth costs no sandbox time. A saturated installation returns 503 + `Retry-After`. |
| Data exposure | `anonymous` routes only see public resources. `installation` routes see what the installation's grants allow, and the install review lists what each route "exposes to the public internet". |
| Response smuggling | The host builds the HTTP response from a validated structure. Headers are allowlisted: `Content-Type`, `Cache-Control`, `ETag`, `Last-Modified`, `Link`, `Location` (same host only), `WWW-Authenticate`, `Retry-After`, `Vary`, plus declared CORS headers. No hop-by-hop headers. |
| Replay | `http-signature` requires a `Date`/`created` within ±5 minutes (*proposed*) and a digest over the body. `dpop` requires a unique `jti`, checked against a cache the host keeps. |
| Key misuse | Private keys never enter the sandbox. `ctx.keys.sign` only signs with declared key names, and every signature is logged with its operation id. |
| Duplicate identity across replicas | Routes are only registered on the execution owner (2.3). |

### 2.8 Resource limits (all *proposed*)

| Limit | Route default | Route max (with `extended-*` grant) | Job today |
| --- | --- | --- | --- |
| Fuel | 1G | 10G | 20G / 200G |
| Memory | 64 MiB | 256 MiB | 256 MiB / 2000 MiB |
| Wall-clock deadline | 3 s | 30 s | none per run (fetch 30 s) |
| Request body inline | 256 KiB | 1 MiB | n/a |
| Request body as blob | 16 MiB | operator-configured | n/a |
| Response body inline | 1 MiB | 8 MiB | n/a |
| Inline reads (`ctx.http`) | 2 | 4 | unlimited |
| Concurrent requests per installation | 8 | 32 | 1 run per job |

The cost of creating a new component instance per request has **not been
measured**. If it dominates small `GET`s, the first optimization should be a
pool of pre-instantiated components (`InstancePre`, the standard wasmtime
approach). Persistent instances per installation are not an option, because
they would break principle 2.

### 2.9 Lifecycle

| Event | Routes | Keys and tokens | Data |
| --- | --- | --- | --- |
| Install (review) | The review lists each route's path, methods, principal, auth, write targets and claims. Nothing is registered until the installation is active | Keys generated on activation | Write-target tables created as in any install |
| Activate | Registered atomically; any collision refuses the whole activation | — | — |
| Upgrade | The upgrade review includes the diff of routes, claims, writeTargets and keys. The old release keeps serving until approval. Removed routes answer `410 Gone` | Carried over (they belong to the Installation) | Unchanged |
| Pause | `503` + `Retry-After: 3600`, so peers retry instead of forgetting the actor | Kept | Kept |
| Revoke / uninstall | `410 Gone` for 30 days (*proposed*), then 404; slug retired | Private keys erased with the existing revocation tombstone; issued tokens stop working | Kept, like every uninstall today |
| Execution owner moves (#1535) | Unregistered on the old node, registered on the new one. The URL only survives if the host name moves too | Keys are per node today. Moving them would be a new, explicit handoff (D3: not in phases 1–2) | Synced as usual |

Federated identities are URLs. Changing the routes origin, the drive's vanity
host or the slug breaks every follower and every share. The install review
must say which URL becomes the public identity.

### 2.10 How the iframe UI and the server part share data

The server part and the view never talk to each other directly. They share
**Atomic resources**, the Installation's config, and a small read-only
status API:

- The route handler writes into `writeTargets`, for example an Inbox table.
  The view reads that table through the `FrameBridge` subscription with the
  user's rights, the same way the Pets and Notion apps read their tables.
- The view writes the user's intent (a post to publish, a share to send) as
  resources in a declared outbox table. A **query trigger** (placement B)
  picks those up and enqueues deliveries. The view never calls a route. Its
  frame has a null origin and no network, and nothing would be gained by
  going through the public surface.
- The host manages keys and tokens. The view can list and revoke issued
  tokens through a host call, but can never read them.
- A new `readRouteStatus` host call returns, per route: the registered URL,
  request and error counts for the last 24 h, the last error, the depth of
  the outbound queue and its oldest failure. The Installation page and the
  plugin's own view render this.

This design needs only these UI touch points: a "Public endpoints" section in
the install/upgrade review, and endpoint health on the Installation page and
in plugin views. They reuse the shared plugin visual language from the
parallel plugin UI designs (money, notion, calendar, issue-tracker,
timesheets):

- `--pl-*` tokens mapped from the host's `--t-*` variables;
- the header row [icon + name | source chips | status pill | primary action],
  where each public endpoint is a source chip and the status pill uses the
  same idle / synced / error / needs-attention states;
- the empty state: a centred icon, one sentence and one button ("No public
  endpoints yet — Activate");
- errors as an inline banner with the cause and one recovery action ("Route
  /inbox collides with Installation X — Open X").

No new components are needed.

---

## 3. Per-protocol feasibility

Legend: **C** sandbox route (this proposal), **B** sandbox job, **A** iframe,
**D** server extension, **E** sidecar. "Phase" refers to section 4. These are
assessments on paper; none has been prototyped.

| Protocol | Inbound surface | Well-known | Auth | Long-lived / background | Non-HTTP | Placement | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **WebFinger** (building block) | `GET /.well-known/webfinger?resource=` | `webfinger` (shared) | none | none | no | C | 1 |
| **Open Cloud Mesh** (receive shares) | `POST /shares`, `/notifications`, `/invite-accepted`; `POST /token` (code exchange, OCM 1.2) | `ocm` (+ legacy `/ocm-provider`) exclusive | HTTP signatures (draft-cavage in deployed Nextcloud-family servers, RFC 9421 in the newer spec); bearer via `token` | outbound notifications (B queue) | no | C + B | 2 |
| **Open Cloud Mesh** (send shares) | Serving the shared resource over WebDAV (`PROPFIND`, `GET`, maybe `PUT`) | same | shared secret / exchanged bearer token | — | no | C with non-standard methods and blob bodies | 3 |
| **remoteStorage** | Storage root: `GET`/`HEAD`/`PUT`/`DELETE`/`OPTIONS` with `ETag`, `If-Match`, `If-None-Match`, folder listings; CORS for any origin | `webfinger` link to storage root and auth URL | OAuth 2 implicit-grant dialog (an HTML consent page, needs the user's Atomic login) + bearer tokens scoped `category:r`/`rw` | none | no | C (`installation-origin` for the dialog; storage on any mount); documents as blobs, folders as resources | 2 |
| **Solid** (resource server) | LDP `GET`/`HEAD`/`PUT`/`POST`/`PATCH` (N3 Patch)/`DELETE`/`OPTIONS`; content negotiation Turtle/JSON-LD; `Link` headers (`type`, `acl`, `describedby`); WAC or ACP | `solid` storage description | Solid-OIDC: DPoP-bound tokens from any issuer; WebID profile document | Notifications (WebSocketChannel2023, webhooks) | no | C for resources and WebID; RDF parsing better as `wasip2` Rust than in QuickJS; notifications phase 3 | 2–3 |
| **Solid** (identity provider) | OIDC `authorize` (interactive), `token`, `jwks`, dynamic `registration` | `openid-configuration` | OIDC + DPoP | sessions | no | E (use an existing IdP) or D; not in the sandbox | 4 |
| **atproto** (handle only) | `GET /.well-known/atproto-did` returning a DID | `atproto-did` exclusive | none | none | no | C | 1 |
| **atproto** (PDS) | XRPC `/xrpc/<nsid>` (`com.atproto.server.*`, `repo.*`, `sync.*`); blobs; `com.atproto.sync.subscribeRepos` WebSocket firehose; `did.json` for `did:web` | `atproto-did`, `oauth-authorization-server`, `oauth-protected-resource` | atproto OAuth (PAR + DPoP), service JWTs | signed Merkle Search Tree repo, CAR export, relay `requestCrawl`, `did:plc` operations | WebSocket | E (run the reference PDS), with the plugin bridging data as a client (B/A); a PDS in the sandbox is not realistic | 4 |
| **atproto** (read / AppView-like) | none | none | none | polling | no | A or B, outbound only | 0 |
| **ActivityPub / fediverse** | actor (content-negotiated `GET`), `POST` inbox (+ shared inbox), outbox, followers/following collections, objects | `webfinger` (shared), `nodeinfo` exclusive, `host-meta` (generated) | HTTP signatures on inbound POST; signed GETs for "authorized fetch" servers; outbound signing with the actor key | delivery fan-out with retries over hours to days (B queue) | no | C + B | 2 |
| **Willow** (sideloading drops) | none | none | Meadowcap capabilities inside the drop | none | no (files) | B as a file importer | 0 |
| **Willow** (live sync, WGPS) | none standardized over HTTP; WGPS needs a reliable bidirectional stream (TCP, QUIC, or WebSocket) | none | Meadowcap | long-lived sessions with resource control | yes, or WebSocket | D or E. A host-mediated WebSocket (phase 3) could work only if an implementation tolerates one invocation per message, which is unverified | 4 |
| **NextGraph** (client interop) | none | none | NextGraph wallet/keys | broker connection | WebSocket to a broker (outbound) | A: the browser store backend in atomic-server `planning/nextgraph-interop.md` | separate plan |
| **NextGraph** (broker / server-to-server) | broker protocol over WebSocket (`ngd`) | none | E2EE, NextGraph keys | long-lived | WebSocket / own port | E (run `ngd`) | 4 |

What the table shows:

- **Phases 1–2 share a common core:** WebFinger, exclusive well-known claims,
  `GET`/`POST`/`PUT`/`DELETE` routes, verifying and creating HTTP signatures,
  host-held keys, bearer tokens issued by the plugin, blob bodies, and the
  durable delivery queue. That covers ActivityPub, remoteStorage and
  receiving OCM shares.
- **WebSockets** are needed by Solid notifications, the atproto firehose,
  Willow and NextGraph. Only Solid notifications plausibly fit a model where
  each message invokes the sandbox. The others belong in sidecars.
- **Interactive HTML** (the remoteStorage and Solid consent dialogs) needs
  the user's Atomic session. Decided (D6): the route redirects to a consent
  page that the host owns, on the API origin. That page shows the requested
  scopes and returns to the route with a one-time code. The plugin never
  serves a login form.

---

## 4. Phased plan and decisions

Each phase is useful on its own and can land independently. Every phase
from 1 on is behind the gates of section 0, which land first (AS-01).

**Phase 0: no runtime change.**
Document the placement rules (section 1) and the gates (section 0) in
`integrations/README.md` and implement the derived `requires` from #1535.
Ship packages that need no inbound surface: a Willow drop importer (B), and
read-only outbound clients for public atproto/ActivityPub data (A/B, egress
only). Exit: an author can tell from the manifest where each part runs.

**Phase 1: read-only public routes.**
Scope:

- the build gate, the runtime gate and gate reporting (section 0);
- the `http` manifest block, with `GET`/`HEAD` only, `principal: anonymous`
  and `auth: none`;
- the route registry and collision checks;
- the `installation-origin` and `drive-prefix` mounts;
- the well-known dispatcher, with `webfinger` (shared) and
  `nodeinfo`/`atproto-did` (exclusive);
- the `http` trigger kind, the route pool and its limits;
- the catalog marking and the install review section.

Demo package: `integrations/well-known/`, which answers WebFinger, NodeInfo
and `atproto-did` for a drive. Exit: an external WebFinger client resolves
`acct:name@<host>` from a drive's data, covered by a server test and an e2e
test against a real server built with `--features plugin-routes` and started
with `--plugin-routes read-only`. The same e2e also checks that a build
without the feature refuses the install with the section 0.4 message.

**Phase 2: writes and federation primitives** (runtime level
`read-write`).
Scope:

- write methods, the `writeTargets` route grant and quotas;
- blob bodies;
- `http-signature` and `bearer` auth;
- host-held `keys` and `tokens`, and the host-owned consent page (D6);
- `enqueues` with the durable delivery queue;
- `readRouteStatus` in the UI;
- the `drive-host` mount, with exclusive claims approved by the drive owner.

Demo packages, in this order (D11): a remoteStorage server, single-actor
ActivityPub, an OCM share receiver. Exit, per package: live interop evidence
against one independent implementation, recorded as certification evidence.
Candidates are the remoteStorage test suite, a Mastodon or GoToSocial
instance, and a Nextcloud OCM peer. Until that evidence exists, the
package's capabilities are "declared", not "verified".

**Phase 3: broader HTTP.**
Scope:

- `dpop` auth;
- arbitrary methods (`PROPFIND`, `PATCH`);
- host-mediated WebSockets, invoking the sandbox once per message;
- `wasip2` `run` for heavy parsing (convergence step 5).

Demos: a Solid resource server with notifications, and sending OCM shares
over WebDAV.

**Phase 4: operator territory.**
`http.listeners` for `server-extension` and sidecar access, both behind the
gates and the operator's own `ATOMIC_PLUGIN_LISTENERS`/`ATOMIC_PLUGIN_SIDECARS`
config, plus documented sidecar recipes: reverse-proxy config, and how a
plugin talks to the sidecar as a declared operation. Targets: an atproto
PDS, a NextGraph broker, Willow WGPS, a Solid IdP.

### Decisions

Michiel accepted the proposal on PR #108 (2026-09-24), adding the gating in
section 0. Where this document had a recommendation, it is now the decision.
Where it had none, the decision below is marked **decided by default;
revisit if needed**.

- **D1. Default origin model.** `installation-origin` on a dedicated
  `ATOMIC_ROUTES_ORIGIN` (mirroring websites) is the default, with
  `drive-host` for vanity handles. `drive-prefix` is always available once
  the gates are open, so self-hosters without wildcard DNS get
  `drive-prefix` only. A package whose manifest needs `installation-origin`
  is refused there with a message that names `ATOMIC_ROUTES_ORIGIN`.
- **D2. Who may install public-write routes.** Nobody, unless the build and
  runtime gates are open (section 0). At `read-only`, anyone who may install
  plugins on the node (as `host_mode` decides) may install read-only routes.
  Write routes need the operator to choose `read-write`. This is the
  recommendation, expressed as the runtime level.
- **D3. Identity portability.** Federated identities stay bound to their
  host name, and keys stay per node in phases 1–2. Handing keys over is not
  part of the #1535 execution-owner handoff for now. *Decided by default;
  revisit if needed*, at the latest when that handoff is implemented.
- **D4. Route writes without review.** The route grant and quotas of 2.6, as
  proposed. There is no "pending" state for inbound writes, so a 2xx means
  the write was stored.
- **D5. Wildcard delivery destinations.** `https://*` operations are
  accepted only for operations listed in `enqueues`, only on nodes at
  `read-write`, with the egress guard, the per-destination concurrency limit
  and a per-installation daily delivery cap (*proposed*: 10,000) as
  restrictions. *Decided by default; revisit if needed.*
- **D6. Consent pages.** A host-owned consent page on the API origin. The
  plugin never serves a login or consent form.
- **D7. Reachability.** The host runs a reachability self-check (fetching
  its own routes origin) at startup and at activation. The result is shown
  in `hostFeatures` and on the Installation page, but does not block
  installs. Tunnels for desktop and Android nodes are out of scope. *Decided
  by default; revisit if needed.*
- **D8. Crypto in host vs JS.** Verifying and creating HTTP signatures and
  DPoP/JWS are Rust host calls. JS libraries are allowed in the sandbox but
  get no key material.
- **D9. Manifest version.** Bump to `schemaVersion: 3`, as 2.2 proposes.
  Hosts that understand v3 accept v3 manifests without an `http` block.
- **D10. Relation to Atomic `Endpoint`.** Registered plugin routes stay
  internal to the host. The install review and `readRouteStatus` are how
  people find them. *Decided by default; revisit if needed*, for example if
  a client needs to discover routes.
- **D11. First protocol.** remoteStorage first, then ActivityPub, then OCM.
- **D12. Gating.** Three layers, all required: the `plugin-routes` Cargo
  feature (off by default, never in atomic.place builds), the
  `--plugin-routes`/`ATOMIC_PLUGIN_ROUTES` runtime level (default `off`),
  and per-Installation consent. Section 0 gives the details.

These points were chosen while writing section 0 and are worth a quick
confirmation: a three-value runtime level instead of a plain on/off flag
(0.3); refusing to start, rather than warning, when the switch is set on a
build without the feature (0.3); and hiding gated plugins from the catalog
on builds without the feature, while only marking them on builds that have
it (0.5).

---

## 5. Implementation issue drafts

These are drafts and have not been filed. Each heading is the proposed issue
title. atomic-server work goes as PRs against `feat/plugin-debug`, following
the current workflow; each issue below can be built and merged on its own
once the issues it depends on have merged. Everything from AS-04 on is
compiled only with `--features plugin-routes`.

### atomic-server

**AS-01. Build and runtime gates for plugin public surfaces.** Depends on:
nothing.
Add the `plugin-routes` Cargo feature (not in `default` or `light`) with no
gated code yet, the `--plugin-routes off|read-only|read-write` /
`ATOMIC_PLUGIN_ROUTES` option plus `ATOMIC_ROUTES_ORIGIN`,
`ATOMIC_PLUGIN_LISTENERS` and `ATOMIC_PLUGIN_SIDECARS`, the startup refusals
of 0.3, and `hostFeatures.pluginRoutes` in `/plugin-catalog`. CI: a
`--features plugin-routes` clippy and test job, and a check that the release
and atomic.place feature sets exclude the feature.

**AS-02. Manifest v3: `http` block, derived `requires`, gate-aware
refusal.** Depends on: AS-01.
The `http` block (2.2) in `server/src/plugins/manifest.rs` and its
`@tomic/lib` mirror, left out of the serialization when empty. Validation as
before. The derived `requires`, including `plugin-routes:<level>`. The
`host-feature-unavailable` refusal at install, upgrade and release pin
(0.4). Shared fixtures under `testdata/plugin-manifest/`. Compiled into
every build.

**AS-03. Catalog and install review: gated plugins and public endpoints.**
Depends on: AS-01, AS-02.
Browser only. Hide or mark gated plugins from `hostFeatures` (0.5), show the
refusal text, and add the "Public endpoints" section to the install and
upgrade review (2.9, 2.10).

**AS-04. Route registry, mounts and reserved paths.** Depends on: AS-02.
The registry keyed on `(host, method, pattern)`, the `installation-origin`
and `drive-prefix` mounts, collision refusal, 503/410/404 responses
(2.9, 0.4), and registration only on the execution owner. The `_routes/`
subject reservation is compiled into every build.

**AS-05. `http` trigger kind, route execution and `readRouteStatus`.**
Depends on: AS-04.
The trigger, `handle(ctx, request)`, the route worker pool and 2.8 limits,
response validation, stripping cookies and auth headers on shared hosts, a
sampled run log, and the `readRouteStatus` host call. Report the measured
instantiation cost per request on the PR.

**AS-06. Well-known dispatcher and the `drive-host` mount.** Depends on:
AS-05.
The multiplexed `webfinger`, generated `host-meta`, exclusive claims from
the allowlist (2.4), and the `drive-host` mount with drive-owner approval of
exclusive claims.

**AS-07. Route writes: route grant, quotas, provenance.** Depends on: AS-05.
Needs level `read-write`. As 2.6.

**AS-08. Host crypto: installation keys, HTTP signatures, tokens, consent
page.** Depends on: AS-05.
Needs level `read-write`. Keys, signature verification, the token store,
and the host-owned consent page (D6).

**AS-09. Durable delivery queue and wildcard destinations.** Depends on:
AS-05.
Needs level `read-write`. As 2.6 and D5, including pausing (not dropping)
deliveries of degraded Installations.

**AS-10. Blob request and response bodies for routes.** Depends on: AS-05.

**AS-11. Endpoint health on the Installation page and in plugin views.**
Depends on: AS-03, AS-05. Queue fields appear once AS-09 has merged.

**AS-12 (phase 3). Host-mediated WebSockets for routes.** Design first. Do
not start before a phase 2 protocol is live.

**AS-13 (phase 4). Listeners and sidecar access.** Depends on: AS-01,
AS-02. Design first.

### atomic-plugins

**AP-01. Document placement rules and gates in `integrations/README.md`.**
Depends on: nothing. No code.

**AP-02. Tooling for gated plugins: catalog `requires`, certification and a
`plugin-routes` e2e build.** Depends on: AS-01 and AS-02 merged and pinned.

**AP-03. `integrations/well-known/`: WebFinger, NodeInfo, atproto-did
(phase 1).** Depends on: AS-02, AS-04, AS-05, AS-06, AP-02.

**AP-04. `integrations/remotestorage/`: remoteStorage server (phase 2).**
Depends on: AS-06, AS-07, AS-08, AS-10, AP-02.

**AP-05. `integrations/activitypub/`: single-actor ActivityPub (phase 2).**
Depends on: AS-06, AS-07, AS-08, AS-09, AP-02.

**AP-06. `integrations/ocm/`: receive OCM shares (phase 2).** Depends on:
AS-06, AS-07, AS-08, AP-02.

**AP-07. `integrations/willow-drop/`: Willow sideloading importer
(phase 0).** Depends on: nothing in this list; not gated. Blocked on
evaluating a usable JS or `wasip2` Willow implementation.
