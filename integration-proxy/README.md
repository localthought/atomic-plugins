# integration-proxy

A Rust web server that holds OAuth grants and pasted API keys for third-party
platforms, and forwards catalog-allowlisted requests to them on behalf of
[Atomic](https://github.com/ontola/atomic-server) agents.

There are no proxy accounts, logins or tenants (issue
[#54](https://github.com/ontola/atomic-plugins/issues/54)). The account is
the caller's Atomic agent, `atomic:agent:<public key>`: every request that
matters is signed with that key, and the proxy verifies it against the key
inside the id, so it looks nothing up. A **connection** (one provider grant)
is owned by the agent that redeemed it; the owner **delegates** it to app
agents, and may register **runtimes** (a node's app agent) for them. A plugin
frame, which cannot keep a key, uses a short-lived **capability** signed by
the owner and bound to a key the frame holds in memory.

PostgreSQL stores connections (provider credentials sealed with
XChaCha20-Poly1305), delegations, runtimes, five-minute connect handoffs and
the single-use record of signed requests.

Built with [axum](https://github.com/tokio-rs/axum), following the OAuth 2.0
Authorization Code flow with PKCE towards providers.

## How it works

### Identity

Agent ids are accepted as `atomic:agent:<key>` or the legacy
`did:ad:agent:<key>`, with `<key>` in either base64 alphabet, padded or not.
They are converted to one canonical form, `atomic:agent:` plus the unpadded
base64url key, before they are stored or compared, and only that form is
ever returned. Only Ed25519 keys exist today; one function
(`agent_id::parse`) is where another algorithm would be added.

### Request signatures (Atomic v2)

Every signed request carries Atomic's own headers:

| Header | Value |
| --- | --- |
| `x-atomic-agent` | the signer's agent id |
| `x-atomic-public-key` | the signer's Ed25519 public key, base64 |
| `x-atomic-timestamp` | Unix milliseconds |
| `x-atomic-signature` | base64 Ed25519 signature over the message below |
| `x-atomic-signature-version` | `2` |

The signed message is five lines joined by `\n`, with no trailing newline:

```text
atomic-request-v2
{METHOD}
{full URL, including query}
{timestamp, exactly as in x-atomic-timestamp}
{lowercase hex SHA-256 of the body; e3b0c442…b855 when empty}
```

The proxy accepts version 2 only; a missing or different version header is
refused, never retried as v1. The agent must be `atomic:agent:` of the public
key header. The timestamp must be within ±5 minutes of the proxy's clock, and
each signed message is accepted once (a SHA-256 of it is kept for ten
minutes).

**Full URL** is `BASE_URL` followed by the request's path and query exactly as
received, e.g. `https://localthought.io/proxy/<id>/github-issues/user/repos?page=2`.
It is never rebuilt from the `Host` header: behind TLS termination (Heroku)
the process sees plain HTTP. Clients sign the URL they fetch (`new URL(u).href`).
`BASE_URL` must therefore be exactly the public origin clients use.

### Routes

- `GET /` — a static landing page. `GET /catalog` lists the platforms;
  `GET /catalog/{platform}.yaml` returns a platform's composed OpenAPI
  document.
- `GET /connect?platform=<p>&redirect_uri=<url>&code_challenge=<S256>&code_challenge_method=S256`
  — the consent page, naming the platform and the destination. No login.
  `redirect_uri` must be `https`, loopback `http`, or the Atomic app's deep
  link (`atomic://…`); it may not carry `connection_code` or `error`
  parameters, credentials or a fragment.
- `POST /connect/authorize` — the consent form (cookie-bound CSRF token,
  single use). For an OAuth platform it redirects to the provider; for an
  API-key platform (`type: apiKey` in the composed document) the consent page
  asks for the key, and this seals it.
- `GET /oauth/{platform}/callback` — the provider's callback. Only the
  browser that approved consent can complete it. It redirects to
  `redirect_uri?connection_code=<handoff>` (or `?error=access_denied`). The
  handoff is not a credential: it is single-use, valid five minutes, and
  bound to the PKCE challenge.
- `POST /connect/redeem` — **signed**; body
  `{"code": "<handoff>", "code_verifier": "<PKCE verifier>"}`; answers
  `{"connection_id", "platform", "owner"}`. The signer becomes the owner.
  A wrong verifier does not burn the handoff.
- `ANY /proxy/{connection_id}/{platform}/{path}` — **signed** by the owner, a
  delegated app agent, or a registered runtime of a delegated app; or carrying
  a frame capability (below). The proxy attaches the provider credential,
  refreshing an expiring OAuth token (one refresh in flight per connection),
  and forwards only catalog-allowlisted methods and paths. The caller's
  `Authorization` and `x-atomic-*` headers are never forwarded. `Link`,
  `Retry-After`, `ETag`, `X-Total-Count` and `X-Next-Page` come back unchanged.
- `GET /connections` — **signed**; the signer's connections with their
  delegations (`agent`, `label`, `created_at`, `last_used_at`), and the
  signer's runtimes. Never credentials. Shape:
  `{"owner", "connections": [{"connection_id", "platform", "owner", "created_at", "last_used_at", "delegations": [...]}], "runtimes": [{"agent", "app", "label", "created_at", "last_used_at"}]}`.
- `DELETE /connections/{id}` — **signed by the owner**; deletes the connection
  and its delegations. `204`.
- `POST /connections/{id}/agents` — **signed by the owner**; body
  `{"agent", "label"?}` delegates the connection to that app agent.
  `DELETE /connections/{id}/agents/{agent}` removes the delegation. `204`.
- `POST /runtimes` — **signed**; body `{"app", "agent", "label"?}` registers
  `agent` (a node's app agent) as a runtime of installation `app` for the
  signer. `DELETE /runtimes/{agent}` removes it. A runtime can use every
  connection its app is delegated.
- `GET /healthz` — `200 ok` when the database answers.

Delegations and runtimes are read on every proxied request, so removing one
takes effect on the next request. A connection is deleted after 90 days
without an authenticated request (`CONNECTION_IDLE_DAYS`).

### Frame capabilities

A plugin frame (null origin, no storage) generates a non-extractable key in
memory; its page, which holds the user's key, signs a capability for it:

```text
Authorization: Capability <payload>.<sig>
payload = base64url(JSON), unpadded:
          {"v":2,"connection_id","platform","aud","app","cnf","exp"}
sig     = the connection owner's Ed25519 signature, base64, over
          "integration-proxy-capability-v2\n" + the JSON bytes
```

`aud` is the proxy origin (`BASE_URL`'s scheme, host and port); `app` is the
installation's app agent, which must hold a delegation; `cnf` is the frame's
key as `atomic:agent:<key>`; `exp` is Unix seconds, at most 15 minutes ahead.
The request itself must also carry v2 headers signed by `cnf`'s key, so a
copied capability is useless without the frame. The proxy checks, in order:
the owner's signature, `aud`, `exp`, `connection_id` and `platform`, the
delegation for `app`, and the request signature by `cnf` (with skew and
replay). On `401 capability_expired` the frame asks its page for a new one.

### Errors

Signed endpoints answer errors as JSON, `{"error": "<code>", "message": "<text>"}`:

| Status | `error` |
| --- | --- |
| 401 | `missing_signature`, `unsupported_signature_version`, `invalid_agent`, `agent_key_mismatch`, `stale_timestamp`, `bad_signature`, `replayed`, `unsupported_authorization` (e.g. a retired `Bearer` connection code), `invalid_capability`, `capability_expired`, `capability_too_long`, `wrong_audience`, `capability_key_mismatch`, `credential_refresh_failed` (connect again) |
| 403 | `not_owner`, `not_delegated`, `capability_scope`, `platform_mismatch`, `access_denied` |
| 404 | `unknown_connection` (deleted, idle-expired, or never existed: connect again) |
| 400 | `bad_request`, `invalid_handoff` |

Catalog refusals and upstream failures from `/proxy/…` keep their plain-text
bodies (`404 method or path is not in the catalog`, `502 upstream request failed`).

### Who may use the proxy

Every signed request's connection owner (and the redeemer, at
`/connect/redeem`) is checked against an `AccessPolicy`. Delegated agents and
frames are checked as their owner, so limits count per owner. The default
policy admits every agent except those in `REVOKED_SUBJECTS`, and only those
in `ALLOWED_AGENTS` when that is set. The atomic.place deployment is meant to
plug in a lookup of the agent's SaaS account and tier
([`build_app_with_access`](#library-crate)); how an agent is linked to an
account is decided in ontola/atomic-saas#138 and is **not** implemented here.

### What was removed (flag day)

Issue #54 decision 6 switched these off with no migration: OIDC application
login (`/auth/login`, `/auth/callback`, `/auth/logout`, `APP_AUTH_*`), API
identity login (`/auth/login/{platform}`, catalog `tenantIdentity`),
`tenant:v1:` tenants, tenant secrets and `SERVER_SECRET`, `/session`, the
legacy signed `/connect` and `/oauth/{platform}/start`, the `/proxy`
tenant-secret check, the `user_id` and `credentials` parameters of
`/connect`, and rotating connection codes (`Authorization: Bearer` and
`X-Connection-Code`). Existing connection codes stop working; users connect
again. The old `connection_codes` and `oauth_states` tables are no longer
read or written but are not dropped automatically; once the new version is
deployed, an operator may drop them with
`DROP TABLE IF EXISTS connection_codes, oauth_states;`.

## Setup

### 1. Configure environment variables

Nothing in the process reads `.env` files; export the variables, or load a
`.env` into your shell first (`set -a; source .env; set +a`).

| Variable | Required | Description |
| --- | --- | --- |
| `BASE_URL` | no | Public URL of the proxy, e.g. `https://localthought.io`. Defaults to `http://localhost:8080`. Used for OAuth callback URLs, as the prefix of every signed URL, and (its origin) as a capability's `aud`. Must be exactly what clients use. |
| `PORT` | no | Port to listen on. Defaults to `8080`. |
| `SESSION_SECRET` | no | Secret for the short-lived consent and OAuth-binding cookies. If unset, a random key is generated at startup, and a consent screen open during a restart must be started again. |
| `CATALOG_PATH` | no | Local path or HTTPS URL for the catalog JSON. Defaults to `https://ontola.github.io/atomic-plugins/overlays/catalog.json`, this repository's `overlays/catalog.json` as GitHub Pages publishes it from `main`. |
| `DATABASE_URL` | yes | PostgreSQL connection URL. |
| `ENCRYPTION_KEY` | yes | Base64url-encoded, random 32-byte key for sealed provider credentials. Changing it makes every stored connection unreadable. |
| `REVOKED_SUBJECTS` | no | Comma-separated agent ids (any accepted spelling) the default access policy refuses. |
| `ALLOWED_AGENTS` | no | When set, comma-separated agent ids; the default access policy admits only these owners. |
| `OAUTH_<PLATFORM>_CLIENT_ID`, `OAUTH_<PLATFORM>_CLIENT_SECRET`, `OAUTH_<PLATFORM>_CLIENT_AUTH_METHOD` | per OAuth platform | See below. |

OAuth credentials are provider-specific. For a catalog platform named
`google-calendar`, configure `OAUTH_GOOGLE_CALENDAR_CLIENT_ID` and
`OAUTH_GOOGLE_CALENDAR_CLIENT_SECRET`; its callback URI is
`<BASE_URL>/oauth/google-calendar/callback`. Provider names use lowercase
letters, digits, and hyphens, and are converted to uppercase with hyphens
replaced by underscores for environment-variable names.

The server owns the OAuth endpoints and scopes for every platform in the
catalog, reading them from that platform's composed OpenAPI document; a
request cannot supply a provider URL, token URL, or scope.

The PostgreSQL client validates the database TLS certificate. Heroku assigns
`DATABASE_URL` automatically when its Postgres add-on is attached. Schema
setup runs in a transaction under an advisory lock, so several instances can
start against an empty database at once.

## Catalog

Discord uses `OAUTH_DISCORD_CLIENT_ID` and `OAUTH_DISCORD_CLIENT_SECRET`,
with production callback `https://localthought.io/oauth/discord/callback`.
Register an OAuth application in the Discord Developer Portal. The initial
read-only integration uses `identify` and `guilds` to read your profile and
import server memberships; it does not import messages or require a bot token.
The guild import requests `limit=200`, covering Discord's documented maximum
number of guilds for a user. The profile endpoint is available as a read
operation, not an imported collection.
Discord access tokens expire and use the existing refresh-token flow.

Spotify uses `OAUTH_SPOTIFY_CLIENT_ID` and the callback
`https://localthought.io/oauth/spotify/callback` in production. Register a
Spotify Web API app with that exact redirect URI. The integration uses
Authorization Code with PKCE, so no client secret is required or transmitted;
set `OAUTH_SPOTIFY_CLIENT_AUTH_METHOD=none` so the proxy does not require or
send one. It imports playlists with `playlist-read-private` and
`playlist-read-collaborative`; no write scopes are requested. No account ID
parameter is needed. Development-mode access is subject to Spotify's Premium
and app-user allowlist requirements. Access tokens refresh automatically;
expired or revoked refresh tokens require reconnecting through OAuth.


Moneybird uses `OAUTH_MONEYBIRD_CLIENT_ID` and
`OAUTH_MONEYBIRD_CLIENT_SECRET`, with callback
`https://localthought.io/oauth/moneybird/callback` in production. Register an
external OAuth application, rather than a personal API token. The
`sales_invoices` scope grants access to contacts (Moneybird has no contacts-only
scope). The initial integration imports contacts; supply the administration ID
from the Moneybird account when connecting. OAuth tokens without `expires_in`
remain usable until revoked; tokens with an expiry use the normal refresh flow.

[`overlays/catalog.json`](../overlays/catalog.json) in this repository
(migrated from the former `localthought/overlays` repository) is the source of
the integration catalog. GitHub Pages publishes `overlays/` from `main` at
`https://ontola.github.io/atomic-plugins/overlays/`, and the proxy defaults to
the `catalog.json` there; set `CATALOG_PATH` to another HTTPS URL or to a
local fixture for development. Each platform names one pinned OpenAPI document
(in `localthought/` or `ontola/openapi-directory`, at a commit) and zero or more Overlay
Specification documents, each served from that same Pages folder. At startup
the proxy downloads those HTTPS sources, applies each overlay's `update`
actions in the listed order, and keeps the resulting YAML in memory.

A catalog entry may also contain a **selection** object. Consumer
**query_overrides** remain separate from the composed OpenAPI document:
choosing to include archived records is client configuration, not an API
default. The proxy passes those choices through.
**selection.oauthSecurityScheme** is trusted server configuration: when a
document contains multiple OAuth authorization-code Security Schemes, it names
the one the proxy uses. The value must be a string naming a declared scheme.
**GET /catalog/{platform}.selection.json** returns the selection object (or an
empty object when absent).

Overlay URLs are no longer pinned to a commit: whatever `main` has in
`overlays/` is what the next proxy start composes. Change the catalog in one
PR: edit the overlays and `overlays/catalog.json` together; `Overlays CI` and
this crate's `default_catalog_*` tests (which compose the checked-in catalog,
reading the Pages-published overlays from `../overlays/`) validate it before
merge; after merge, `Overlays published` checks that Pages serves the merged
bytes; then restart the service. OAD URLs remain pinned to an
`openapi-directory` commit. Overlay content cannot currently be pinned: a
`CATALOG_PATH` pointing at a local file or at a commit's
`raw.githubusercontent.com` copy of `catalog.json` still lists Pages URLs, so
its overlays are whatever `main` serves when the proxy starts.

### 2. Run it

```sh
cargo run
```

Then open `http://localhost:8080` (or your configured `BASE_URL`).

## Development

```sh
cargo fmt --all       # format
cargo clippy --all-targets --all-features -- -D warnings   # lint
cargo build            # build
cargo test             # test
```

CI runs the same checks on every push and pull request that touches
`integration-proxy/` (see the repository's
`.github/workflows/integration-proxy-ci.yml`), plus `cargo package --locked`
and a build of the [Heroku wrapper template](examples/heroku-wrapper/).

## Library crate

This package is published to crates.io as
[`atomic-integration-proxy`](https://crates.io/crates/atomic-integration-proxy)
(library `atomic_integration_proxy`, binary `integration-proxy`), so a
deployment can be a thin wrapper that depends on it by semver instead of a
copy of the source. The public API is intentionally small; everything else is
private and may change in any release:

| Item | What it does |
| --- | --- |
| `Config`, `Config::from_env()` | All configuration, read from the environment variables described above. |
| `DEFAULT_CATALOG_PATH` | The pinned catalog URL used when `CATALOG_PATH` is unset. |
| `build_app(&Config) -> Result<axum::Router, Error>` | Loads the catalog, connects to PostgreSQL, returns the router (CORS and tracing layers included), with the default `EnvAccessPolicy`. |
| `build_app_with_access(&Config, Arc<dyn AccessPolicy>)` | The same, admitting connection owners through a custom policy (e.g. a SaaS account and tier lookup). |
| `AccessPolicy`, `Access`, `AllowAll`, `EnvAccessPolicy` | The admission check asked about every owner; `AllowAll` for a self-hosted proxy. |
| `AgentId`, `parse_agent_id` | A parsed agent id; `as_str()` is the canonical `atomic:agent:` form. |
| `serve(Config) -> Result<(), Error>` | `build_app`, then bind `0.0.0.0:{PORT}` and serve. |
| `run() -> ExitCode` | What the binary does: init `tracing` from `RUST_LOG` (default `info`), `Config::from_env`, `serve`, print any `Error` to stderr. |
| `Error` | Startup/serve failure; `Display` is the one-line message the binary prints. |

A complete wrapper `main.rs` is:

```rust
#[tokio::main]
async fn main() -> std::process::ExitCode {
    atomic_integration_proxy::run().await
}
```

The only runtime file access is `CATALOG_PATH` when it is set to a local
path; the default is a pinned HTTPS URL, and `static/` is compiled into the
binary, so the crate needs no files next to the executable.

### Publishing the crate

`.github/workflows/integration-proxy-publish.yml` publishes when a tag
`integration-proxy-v<version>` matching `Cargo.toml`'s `version` is pushed.
It reruns fmt, clippy and the full test suite (including the PostgreSQL tests)
first, then publishes through crates.io Trusted Publishing. crates.io only
allows Trusted Publishing to be configured on a crate that already exists, so
0.1.0 must be published once by hand by whoever will own the crate; the
workflow header lists the one-time crates.io settings. To release:

```sh
# bump `version` in integration-proxy/Cargo.toml, merge, then on main:
cd integration-proxy && cargo publish --dry-run
git tag integration-proxy-v0.1.1 && git push origin integration-proxy-v0.1.1
```

Only `src/`, `static/index.html`, `static/logo.png`, `Cargo.toml`,
`Cargo.lock`, `README.md`, `SECURITY.md` and `LICENSE` are packaged
(`cargo package --list` shows the exact list). `tests/` fixtures are not, so
`cargo test` only works from a checkout of this repository.

### Production deployment (localthought.io)

Production runs on Heroku from the separate repository
`localthought/integration-proxy`, which today still carries its own full copy
of this source. The target state is that it contains only the files in
[`examples/heroku-wrapper/`](examples/heroku-wrapper/) and picks up proxy
changes by bumping the `atomic-integration-proxy` version in its `Cargo.lock`;
that directory's README has the switch-over steps.

Until that switch-over, every change merged here must be duplicated there by
hand, or production will not get it. Copy the whole tree rather than
cherry-picking patches — this package's `src/main.rs` became `src/lib.rs`
plus a thin `src/main.rs`, so patches against one layout do not apply to the
other:

```sh
# from the root of an ontola/atomic-plugins checkout on the merged main,
# with localthought/integration-proxy checked out at ../localthought-integration-proxy
rsync -a --delete \
  --exclude .git --exclude .github --exclude target --exclude .env \
  --exclude examples \
  integration-proxy/ ../localthought-integration-proxy/
cd ../localthought-integration-proxy
cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test
git add -A && git commit -m "Sync from ontola/atomic-plugins@<sha>"
```

The synced `Procfile` runs `target/release/integration-proxy` (the binary was
`auth-proxy` before this package became a crate), and log lines are tagged
`atomic_integration_proxy` instead of `auth_proxy`, which matters only if
`RUST_LOG` names the old target.

#### Deploying 0.2 (issue #54 flag day)

0.2 changes the client protocol; deploy it together with the atomic-server
release that signs requests (Atomic v2) and uses `/proxy/{connection_id}/…`,
never before it. Heroku config vars:

| Variable | Change |
| --- | --- |
| `BASE_URL` | **Check**: must be exactly the public origin clients use (for production `https://localthought.io`, no trailing path). Every signature covers it; a mismatch makes every signed request fail with `bad_signature`. |
| `APP_AUTH_CLIENT_ID`, `APP_AUTH_CLIENT_SECRET`, `APP_AUTH_AUTHORIZATION_URL`, `APP_AUTH_TOKEN_URL`, `APP_AUTH_USERINFO_URL`, `APP_AUTH_LABEL`, `APP_AUTH_IDENTITY_NAMESPACE` | No longer read; unset them (`heroku config:unset …`). 0.1 refused to start without the first five; 0.2 ignores them. |
| `SERVER_SECRET` | No longer read; unset it. |
| `REVOKED_SUBJECTS` | Now means agent ids; tenant ids and OIDC subjects listed there no longer match anything. Rewrite or unset it. |
| `ALLOWED_AGENTS` | New, optional: restrict the proxy to these owners. |
| `SESSION_SECRET`, `DATABASE_URL`, `ENCRYPTION_KEY`, `CATALOG_PATH`, `PORT`, `OAUTH_*` | Unchanged. |

Existing connection codes stop working at deploy; users connect again. After
the deploy, `DROP TABLE IF EXISTS connection_codes, oauth_states;` removes the
old sealed credentials (optional, irreversible).

## Security

Provider credentials are sealed per connection row (the associated data
binds each envelope to its row) and never returned to a client. Requests go
only to catalog-allowlisted methods and paths. [SECURITY.md](SECURITY.md)
describes the controls and what is not yet verified.

## Notes on state

- Nothing identifies a browser session: there are no session cookies. The
  consent screen and the OAuth callback use two short-lived (10 minute)
  encrypted `Secure`/`HttpOnly`/`SameSite=Lax` cookies: `platform_consent`
  (the pending request and CSRF token) and `platform_oauth` (binding the
  callback to the approving browser). Provider state, handoffs and
  connections live in PostgreSQL, so any instance can serve any request.
- Cookies are marked `Secure`, so in production `BASE_URL` must use
  `https://`. `http://localhost` works during local development because
  browsers treat `localhost` as a secure context.

## Browser clients

CORS allows any origin, including a plugin frame's `null` origin, to send
`Authorization`, `Content-Type`, `If-Match` and the five `x-atomic-*` headers,
and exposes `Content-Type`, `Link`, `Retry-After`, `ETag`, `X-Total-Count` and
`X-Next-Page`. Cookie credentials are not enabled for CORS; consent remains a
top-level browser navigation.

## Todoist

The `todoist` platform imports projects and active tasks through Todoist API v1
with the read-only `data:read` scope. Configure `OAUTH_TODOIST_CLIENT_ID` and
`OAUTH_TODOIST_CLIENT_SECRET`, and register
`https://localthought.io/oauth/todoist/callback` as the OAuth redirect URL.
New Todoist applications issue expiring access tokens and rotating refresh
tokens; the proxy stores and refreshes these through its existing credential flow.
Legacy non-expiring access tokens are also supported. No provider writes are exposed.

Provider documentation: https://developer.todoist.com/api/v1/

## Redirect-flow regression checks

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
# Isolated local PostgreSQL, never a production database:
TEST_DATABASE_URL='postgres://postgres@localhost:15439/connect_test?sslmode=disable' \
OAUTH_GITHUB_ISSUES_CLIENT_ID=fixture-client OAUTH_GITHUB_ISSUES_CLIENT_SECRET=fixture-secret \
  cargo test -- --include-ignored
```

CI provides PostgreSQL and includes the database tests; [TESTING_COVERAGE.md](TESTING_COVERAGE.md) maps each verification step to its tests. Live Google/GitHub authorization and a hub import must be verified against matching deployed revisions of the proxy and atomic-server; local fixture checks do not establish live access.

### OAuth client registration

Integration authorization and token endpoints and required scopes are read
from the composed OpenAPI catalog. A platform with one OAuth
authorization-code Security Scheme uses it directly. A platform with multiple
such schemes must set the catalog's trusted
**selection.oauthSecurityScheme**; missing, non-string, or unknown selections
fail closed. Requests cannot select a scheme or supply endpoints. Scopes are
taken from operation security requirements (falling back to root
requirements), not every scope supported by the server. Public operations
require no scopes; unsupported authentication combinations fail closed.

`OAUTH_<PLATFORM>_CLIENT_AUTH_METHOD` optionally overrides the client authentication method: `none`, `client_secret_post`, or `client_secret_basic`. When omitted, the proxy selects the **first usable method in the declared array order** of `x-oauth-authentication-details.authorizationServerMetadata.token_endpoint_auth_methods_supported` in the selected OAuth security scheme. It skips methods the proxy does not implement and methods incompatible with the referenced token/refresh operations. If the array declares no usable method, configuration fails rather than silently falling back.

When that metadata is absent, the proxy retains `client_secret_post` for compatibility, except when a referenced token or refresh operation requires HTTP Basic authentication: it then uses `client_secret_basic`. Explicit overrides must still be supported by the metadata and token operations; an invalid override is an error, not a request to auto-select.

For example, Notion advertises only `client_secret_basic`, so its `_CLIENT_AUTH_METHOD` setting can be omitted. For `["private_key_jwt", "none", "client_secret_basic"]`, the proxy skips the unimplemented JWT method and chooses `none`. Array order is this proxy's default-selection policy, not an assertion of provider preference or the client's registered method. Set the override when your client registration requires a different advertised method. Public clients use `none` and do not load or send a secret; confidential methods require `_CLIENT_SECRET`. Missing credentials cause an error and do not trigger selection of another method. Authorization uses S256 PKCE unless trusted metadata explicitly declares PKCE unsupported.

The proxy implements a bounded subset of
**x-oauth-authentication-details**. It reads inline
**token_endpoint_auth_methods_supported**,
**code_challenge_methods_supported**, PKCE requirements, and fixed
authorization profile parameters. Parameter references must be local. Schema
validation supports **type**, **enum**, recursive **items**, **properties**,
**required**, and **additionalProperties**; other validation keywords fail
closed. Serialization supports scalar form values, form/space/pipe-delimited
scalar arrays, and form/deep-object scalar objects. Reserved OAuth fields and
query-name collisions are rejected.

The proxy does not fetch **oauth2MetadataUrl** and does not interpret
**tokenEndpointOperation** or **refreshEndpointOperation**. A selected scheme
that contains any of those fields is rejected, because discovery or a
separately described operation could require different token-request
authentication or wire behavior.

Upgrading from 0.1 is a flag day (issue #54, decision 6): see
[What was removed](#what-was-removed-flag-day). Provider callback URLs and
`OAUTH_*` variables do not change; `APP_AUTH_*` and `SERVER_SECRET` are no
longer read and can be unset. Clients must move to signed requests at the
same time.
