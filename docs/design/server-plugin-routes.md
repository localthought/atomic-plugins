# Server plugin routes: placement rules and inbound endpoints

Status: **design proposal. Nothing here is implemented.** Written for
[atomic-plugins#88](https://github.com/ontola/atomic-plugins/issues/88) as a
companion to
[ontola/atomic-server#1535](https://github.com/ontola/atomic-server/issues/1535)
(where a plugin runs when a session has no server runtime). It is based on
atomic-server at the commit pinned in `.atomic-server-ref`
(`bae5cdbe3`, 2026-09-23). Limits marked *proposed* are starting numbers for
review, not measurements. No protocol in section 3 has been prototyped against
this design, so its feasibility column is an assessment on paper.

Contents:

1. [Where does plugin code run?](#1-where-does-plugin-code-run)
2. [Inbound routes: the proposal](#2-inbound-routes-the-proposal)
3. [Per-protocol feasibility](#3-per-protocol-feasibility)
4. [Phased plan and open questions](#4-phased-plan-and-open-questions)
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
| `http.routes` non-empty (section 2) | `persistent-host`, `wasm-sandbox`, **`public-origin`** (new) |
| `http.listeners` (section 2.2, D only) | `operator-listener` (new) |

`public-origin` is a new requirement. A node can have the sandbox and still
be unreachable from the internet: a desktop node behind NAT, an Android node,
or `localhost`. Installing on such a node follows the outcomes #1535
describes:

- refuse the install;
- install in a degraded mode, where routes are off, views and jobs work, and
  the Installation says so;
- delegate to a peer that is the execution owner.

A node advertises `public-origin` only when the operator has configured a
routes origin (2.3). Ideally the host has also confirmed that origin is
reachable (open question Q7).

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
manifest that has this block, and rejection is the right outcome. This
proposal still bumps the version to `schemaVersion: 3`, so that the refusal
can say "needs a host with plugin routes" instead of "unknown field" (open
question Q9).

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
  checks every request. Whether a wildcard host is acceptable at all is open
  question Q5.
- **`http.listeners`** (not shown) is accepted **only** in
  `world: server-extension` installed by the operator. Even then it only
  requests a port; the operator must bind it in server config
  (`ATOMIC_PLUGIN_LISTENERS=willow-wgps:4455`). A user-installed `extension`
  never gets a raw port. This document does not design listener semantics
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
  created under it (issue draft AS-2).
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
| Execution owner moves (#1535) | Unregistered on the old node, registered on the new one. The URL only survives if the host name moves too | Keys are per node today. Moving them would be a new, explicit handoff (open question Q3) | Synced as usual |

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
  the user's Atomic session. Recommendation: the route redirects to a consent
  page that the host owns, on the API origin. That page shows the requested
  scopes and returns to the route with a one-time code. The plugin never
  serves a login form (open question Q6).

---

## 4. Phased plan and open questions

Each phase is useful on its own and can land independently.

**Phase 0: no runtime change.**
Document the placement rules (section 1) in `integrations/README.md` and
implement the derived `requires` from #1535. Ship packages that need no
inbound surface: a Willow drop importer (B), and read-only outbound clients
for public atproto/ActivityPub data (A/B, egress only). Exit: an author can
tell from the manifest where each part runs.

**Phase 1: read-only public routes.**
Scope:

- the `http` manifest block, with `GET`/`HEAD` only, `principal: anonymous`
  and `auth: none`;
- the route registry and collision checks;
- the `installation-origin` and `drive-prefix` mounts;
- the well-known dispatcher, with `webfinger` (shared) and
  `nodeinfo`/`atproto-did` (exclusive);
- the `http` trigger kind, the route pool and its limits;
- the install review section.

Demo package: `integrations/well-known/`, which answers WebFinger, NodeInfo
and `atproto-did` for a drive. Exit: an external WebFinger client resolves
`acct:name@<host>` from a drive's data, covered by a server test and an e2e
test against a real server.

**Phase 2: writes and federation primitives.**
Scope:

- write methods, the `writeTargets` route grant and quotas;
- blob bodies;
- `http-signature` and `bearer` auth;
- host-held `keys` and `tokens`;
- `enqueues` with the durable delivery queue;
- `readRouteStatus`;
- the `drive-host` mount, with exclusive claims approved by the drive owner.

Demo packages: single-actor ActivityPub, a remoteStorage server, an OCM share
receiver. Exit, per package: live interop evidence against one independent
implementation, recorded as certification evidence. Candidates are a
Mastodon or GoToSocial instance, the remoteStorage test suite, and a
Nextcloud OCM peer. Until that evidence exists, the package's capabilities
are "declared", not "verified".

**Phase 3: broader HTTP.**
Scope:

- `dpop` auth;
- arbitrary methods (`PROPFIND`, `PATCH`);
- host-mediated WebSockets, invoking the sandbox once per message;
- `wasip2` `run` for heavy parsing (convergence step 5).

Demos: a Solid resource server with notifications, and sending OCM shares
over WebDAV.

**Phase 4: operator territory.**
`http.listeners` for `server-extension`, plus documented sidecar recipes:
reverse-proxy config, and how a plugin talks to the sidecar as a declared
operation. Targets: an atproto PDS, a NextGraph broker, Willow WGPS, a Solid
IdP.

### Open questions for you

- **Q1. Default origin model.** Recommendation: `installation-origin` on a
  dedicated `ATOMIC_ROUTES_ORIGIN` (mirroring websites), with `drive-host`
  for vanity handles. The alternative is `/_routes/…` on the API origin only.
  That is simpler to deploy but permanently limits what plugins can serve.
  Which do you want as the default for self-hosters without wildcard DNS?
- **Q2. Who may install public-write routes?** Any drive owner, or only on
  nodes where the operator allows it (for example `host_mode: owner`, or a
  new `ATOMIC_ALLOW_PLUGIN_ROUTES`)? Recommendation: drive owners get
  read-only routes, and the operator opts in to write routes in phase 2.
- **Q3. Identity portability.** Federated identities are URLs and keys.
  Moving a drive to another node breaks them unless the host name moves too.
  Do we accept that, or should handing over keys be part of the
  execution-owner handoff in #1535?
- **Q4. Route writes without review.** Are the route grant and quotas (2.6)
  acceptable? The alternative is for inbound writes to land in a "pending"
  state that a person or an automation approves. That is safer, but a 2xx
  would no longer mean the write was stored.
- **Q5. Wildcard delivery destinations.** ActivityPub delivers to inbox URLs
  learned at run time. Should we accept a `https://*` operation, only for
  `enqueues`, with the egress guard as the only restriction?
- **Q6. Consent pages.** A consent page owned by the host on the API origin
  (my recommendation), or HTML served by the plugin on the isolated origin?
- **Q7. Reachability.** Should `public-origin` require an active
  self-check, where the node fetches its own routes origin? And do we want a
  tunnel story for desktop/Android nodes, or declare them out of scope?
- **Q8. Crypto in host vs JS.** Recommendation: verifying and creating HTTP
  signatures and DPoP/JWS live in Rust host calls. JS libraries are allowed
  in the sandbox but get no key material. Agree?
- **Q9. Manifest version.** Bump to `schemaVersion: 3` for a clearer refusal
  on older hosts, or keep v2 and rely on `deny_unknown_fields`?
- **Q10. Relation to Atomic `Endpoint`.** Host endpoints such as
  `/bind-drive` and `/did` are described as Atomic `Endpoint` resources.
  Should registered plugin routes also be published as `Endpoint` resources
  so they can be discovered, or stay internal to the host?
- **Q11. First protocol.** Which demo should prove phase 2: ActivityPub (the
  largest audience), remoteStorage (the smallest surface, and ours), or OCM
  (the pondersource/sciencemesh context)? Recommendation: remoteStorage
  first, then ActivityPub.

---

## 5. Implementation issue drafts

These are drafts and have not been filed. Each heading is the proposed issue
title. atomic-server work goes as PRs against `feat/plugin-debug`, following
the current workflow.

### atomic-server

**AS-1. Plugin manifest: `http` block and derived `requires`**
Add the `http` block (2.2) to `server/src/plugins/manifest.rs` and its
`@tomic/lib` mirror. Leave it out of the serialization when empty, so
existing release ids stay byte-identical. Validate:

- path patterns and methods;
- principal/auth combinations (`caller` requires `auth: atomic`);
- write targets, key names and token names;
- that `listeners` only appears with `world: server-extension`.

Derive the `requires` list from #1535 out of the declarations (table in
section 1). Add fixtures, including rejected cases, under
`testdata/plugin-manifest/`, shared by Rust and TS. Decide Q9. No
dependencies.

**AS-2. Route registry, mounts and reserved paths**
Build a registry keyed on `(host, method, pattern)`. Populate it when an
Installation is activated and clear it on pause/revoke, only on the execution
owner. Add `ATOMIC_ROUTES_ORIGIN`, validated like `website_origin`: separate
from API and drive hosts, with `*.localhost` for development. Add the
`drive-prefix` mount at `/_routes/<slug>/`, and reserve `_routes/` in subject
creation. Refuse overlapping patterns with a typed problem. Serve 503/410 as
described in 2.9. Tests: collision refusal, reserved paths, pause and revoke
responses, no registration on a replica that is not the owner. Depends on
AS-1.

**AS-3. `http` trigger kind and route execution**
Extend the JS runtime input with `trigger.kind: "http"` and the verdict with
`response`. The runtime shim dispatches to an exported
`handle(ctx, request)`. Also:

- a separate route worker pool and a per-installation concurrency limit;
- the limits in 2.8, including deadline enforcement;
- response validation and the header allowlist;
- stripping cookies and auth headers on shared hosts;
- a sampled run log.

Measure the instantiation cost per request and report it on the PR. Depends
on AS-2.

**AS-4. Well-known dispatcher**
A host-owned `/.well-known/webfinger` (multiplexed on `resource`), a
generated `host-meta`, and exclusive claims from the allowlist in 2.4. Claims
on drive-mapped hosts need the owner's approval; claims on the API origin
need operator config. Depends on AS-2.

**AS-5. Install and upgrade review: public endpoints**
Show routes, claims, principals, write targets, keys and "exposes to the
public internet" in the Store review and in the upgrade diff. Show endpoint
health from `readRouteStatus` on the Installation page. Reuse the shared
plugin UI language (section 2.10). Depends on AS-1 and AS-3.

**AS-6. Route writes: route grant, quotas, provenance**
Apply route intents only into `writeTargets`, signed by the installation
agent, before the response is sent. Allow updates and deletes only on
resources the installation created. Enforce per-caller and per-installation
quotas that return 429. Depends on AS-3.

**AS-7. Host crypto: installation keys, HTTP signatures, tokens**
Covers:

- per-Installation keypairs (`rsa-sha256`, `ed25519`; others on demand),
  erased with the existing revocation tombstone;
- `ctx.keys.sign` and publishing public keys;
- verifying inbound draft-cavage-12 and RFC 9421 signatures, with key
  fetches that go through the egress guard and are cached, and a replay
  window;
- a store of hashed bearer tokens with scopes, and
  `ctx.tokens.issue/verify/revoke`.

DPoP comes later. Depends on AS-3.

**AS-8. Durable delivery queue for route-enqueued operations**
Let routes and query triggers enqueue declared write operations. The
scheduler runs them through the external-intent journal, with receipts,
exponential backoff and a concurrency limit per destination. Operations that
keep failing end in a dead-letter state that `readRouteStatus` shows. Decide
Q5. Depends on AS-3.

**AS-9. Blob request and response bodies**
With `body: "blob"`, the host stores the request in the blob store (blake3)
before the sandbox runs. A handler can answer with a blob hash, which the
host streams. The host handles `ETag` and conditional requests. Needed for
remoteStorage and OCM WebDAV. Depends on AS-3.

**AS-10 (phase 3). Host-mediated WebSockets for routes**
Design this first: invoking the sandbox once per message, subscription
channels fed by resource changes, connection limits. Do not start before a
phase 2 protocol is live.

### atomic-plugins

**AP-1. Document placement rules in `integrations/README.md`**
Add a "Choosing a placement" section that summarizes section 1 of this
document and links to it, next to "Two plugin runtimes" in `AGENTS.md`. No
code.

**AP-2. `integrations/well-known/`: WebFinger, NodeInfo, atproto-did (phase 1)**
Read-only routes that answer from drive data (a handles table, a DID). Unit
tests for the handler, a sandbox test in atomic-server, and a live-tier test
that resolves the handle with an independent WebFinger client. Depends on
AS-1 to AS-4.

**AP-3. `integrations/remotestorage/`: remoteStorage server (phase 2)**
A storage root with folder listings, conditional requests, and token
issuance through the host's consent page. A drive view lists connected apps
and their scopes, with revoke. Evidence: the remoteStorage server test suite
passes, and one real app (for example a remoteStorage.js app) connects.
Depends on AS-6, AS-7 and AS-9.

**AP-4. `integrations/activitypub/`: single-actor ActivityPub (phase 2)**
Actor, inbox, outbox and followers. Supports follow/accept and publishing a
Note from a drive table, with delivery through AS-8. A view shows Inbox and
Outbox tables and delivery health. Evidence: a follow and reply round trip
with one Mastodon instance and one GoToSocial instance. Depends on AS-6 to
AS-8.

**AP-5. `integrations/ocm/`: receive OCM shares (phase 2)**
Discovery, `shares`, `notifications` and `invite-accepted`, with received
shares listed in a drive table. Evidence: a share from a Nextcloud peer.
Depends on AS-6 and AS-7.

**AP-6. `integrations/willow-drop/`: Willow sideloading importer (phase 0)**
A file-upload importer in the same shape as `money`: parse a drop, verify its
Meadowcap capabilities, and propose its entries as resources for review. No
routes. The only blocker is a usable JS or `wasip2` Willow implementation,
which needs to be evaluated first.
