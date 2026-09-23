# integration-proxy

A Rust web server that lets a user log in with a configured OIDC provider or
a catalog-trusted authenticated API identity. Sign-in sets an encrypted
session cookie; there is a logout button to clear it. There is no
server-side session store — the cookie *is* the session, so any number of
instances can run behind a load balancer with no shared session state.
PostgreSQL is required, though: it stores short-lived consumed OAuth states,
replay nonces, and encrypted one-time credentials.

Built with [axum](https://github.com/tokio-rs/axum) and the
[`oauth2`](https://docs.rs/oauth2) crate, following the OAuth 2.0
Authorization Code flow with PKCE.

## How it works

- `GET /` — shows a configurable application-login button, or, if a valid session
  cookie is present, the signed-in user's name/picture and a "Log out"
  button.
- `GET /auth/login` — starts the configured OIDC OAuth flow: generates a PKCE challenge and
  CSRF token, stores them in a short-lived encrypted cookie, and redirects
  to the provider's consent screen.
- `GET /auth/callback` — the configured provider redirects here with an authorization code.
  The server validates the CSRF token, exchanges the code for an access
  token, fetches the configured provider's profile endpoint, and
  sets the session cookie.
- `GET /auth/login/{platform}` — starts a standalone login through a catalog
  platform only when its selection explicitly trusts a `tenantIdentity`
  operation. It requests that identity operation's OAuth scopes, creates no
  connection credential, and returns only to `/` or an already validated
  pending `/connect` request.
- `POST /auth/logout` — clears the session cookie.
- `GET /catalog` — lists the available integration platform names.
- `GET /catalog/{platform}.yaml` — returns the OpenAPI document for that
  platform with its configured overlays applied.
- `GET /connect?platform=github-issues&redirect_uri=<url>&user_id=<actor>&code_challenge=<S256>&code_challenge_method=S256&credentials=connection` — starts a browser connection without a tenant secret. For a catalog platform that explicitly selects `tenantIdentity`, one provider OAuth authorization establishes the tenant identity and connection credential. Other platforms retain the configured application-login flow.
- `POST /connect/authorize` — approves the selected platform with a short-lived, cookie-bound CSRF token and starts provider OAuth. The authenticated application account determines the tenant; the caller supplies its local user/agent identifier. The consent page shows the destination hub origin and uses `Referrer-Policy: same-origin`, so its form submission retains a concrete origin without sending a referrer to the external OAuth provider.
- `POST /connect/redeem` — exchanges `{ "code": "<callback connection_code>", "code_verifier": "<original verifier>" }` for `{ "connection_code": "<rotating proxy credential>", "platform": "github-issues" }`. The handoff expires after five minutes, requires S256 PKCE, and is consumed atomically. Wrong verifiers do not consume a legitimate handoff. Responses have `Cache-Control: no-store`; browser requests omit cookies.
- Clients that also need the tenant credential explicitly request `credentials=connection+tenant_secret` (URL-encode the `+` as `%2B`). The consent page discloses this extra grant; redemption additionally returns `tenant_secret`. The browser-only Atomic Data Hub requests just `connection` and never needs to paste, receive, or store a tenant secret.
- The legacy signed `/connect` and `/oauth/{platform}/start` protocol remains available for existing clients. New clients should use the bootstrap flow above; it does not require the circular prerequisite of an already provisioned tenant secret.
- `/proxy` — called by the third party with `Authorization: Bearer
  <secret>`. Returns `{"ok": true}` if the tenant secret verifies, or `401` with
  an error body otherwise. Verification is a pure function of
  `SERVER_SECRET`, so it works without looking anything up.
- `GET /session` — returns a timestamp and a challenge signed with
  `SERVER_SECRET`. A tenant signs that challenge with its tenant secret and
  supplies that response, a tenant-vouched `user_id`, and its signature when
  opening `/connect`. The proof expires after ten minutes.

The signed-in home page displays the configured or API-derived identity, without displaying credentials. Tenant secrets are deterministic HMAC credentials derived from the stable tenant identity and `SERVER_SECRET`; existing credentials remain valid. Provider access/refresh tokens are encrypted at rest and never returned to the hub. The hub receives a rotating opaque proxy credential through the protected exchange.

The new consent, provider-state binding and one-time handoff work alongside the existing OAuth and proxy routes. The database migration adds a nullable OAuth context column and a `connection_handoffs` table without invalidating existing connection codes. Schema initialization runs in a transaction under a PostgreSQL advisory lock, so simultaneous app instances can safely start against an empty database. Google/provider OAuth app registrations and callback URLs do not change.

All cookies are set with `axum-extra`'s `PrivateCookieJar`, which
encrypts and authenticates their contents, so the server never needs to
persist anything to recognize a returning user.

## Setup

### 1. Configure application-login OIDC credentials

Configure an OIDC authorization-code client and register `<BASE_URL>/auth/callback` as its redirect URI. Supply its client credentials and authorization, token, and userinfo endpoint URLs through the `APP_AUTH_*` variables below. Application login requests the standard `openid`, `email`, and `profile` scopes.

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill it in, then load it into your shell
before running the server — nothing in the process reads `.env` files on its
own, only actual process environment variables:

```sh
set -a
source .env
set +a
```

Or export the variables directly without a `.env` file.

| Variable               | Required | Description                                                                 |
| ----------------------| -------- | ---------------------------------------------------------------------------- |
| `APP_AUTH_CLIENT_ID`     | yes      | OIDC application-login client ID. |
| `APP_AUTH_CLIENT_SECRET` | yes      | OIDC application-login client secret. |
| `APP_AUTH_AUTHORIZATION_URL` | yes | OIDC authorization endpoint. |
| `APP_AUTH_TOKEN_URL` | yes | OIDC token endpoint. |
| `APP_AUTH_USERINFO_URL` | yes | OIDC userinfo endpoint. |
| `APP_AUTH_LABEL` | no | Login provider label shown in the UI. Defaults to `OIDC`. |
| `APP_AUTH_IDENTITY_NAMESPACE` | no | Fixed HTTPS namespace for an exact trusted provider-scoped identity that preserves legacy bare APP_AUTH subjects. Blank disables migration. |
| `BASE_URL`             | no       | Public URL of the server, no trailing slash. Defaults to `http://localhost:8080`. Must match the redirect URI registered with the application-login provider. |
| `PORT`                 | no       | Port to listen on. Defaults to `8080`.                                      |
| `SESSION_SECRET`       | no       | Secret used to encrypt session cookies. If unset, a random key is generated at startup and sessions are invalidated whenever the process restarts. Set this to a persistent random value in production. |
| `SERVER_SECRET`        | yes      | Secret used to deterministically derive each tenant's secret (see above). Must stay constant across restarts and instances. |
| `CATALOG_PATH`         | no       | Local path or immutable HTTPS URL for the catalog JSON. Defaults to the pinned `localthought/overlays` `catalog.json` revision. |
| `DATABASE_URL`          | yes      | PostgreSQL connection URL. Stores short-lived, consumed challenge nonces to prevent replay. |
| `ENCRYPTION_KEY`        | yes      | Base64url-encoded, random 32-byte key for versioned XChaCha20-Poly1305 credential envelopes. |
| `REVOKED_SUBJECTS`      | no       | Comma-separated tenant and user IDs denied access. |

Provider-neutral tenant identities use the reserved `tenant:v1:` prefix followed
by a versioned JSON tuple. `APP_AUTH_IDENTITY_NAMESPACE` must be a fixed HTTPS
namespace and preserves bare historic subjects only for an exact trusted,
provider-scoped match. Before enabling it, confirm the historic issuer never
assigned subjects beginning `tenant:v1:`; those values are rejected. Email is
display data only and never links provider identities.

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
`DATABASE_URL` automatically when its Postgres add-on is attached.

These two flows hand back a proxy credential differently. In the legacy
signed `/connect` and `/oauth/{platform}/start` flow, use the
`connection_code` returned directly by the OAuth redirect as the Bearer token
for `/proxy/{platform}/{path}`. In the browser bootstrap flow (`POST
/connect/authorize`), the OAuth callback instead returns a short-lived,
PKCE-bound handoff code that is **not** a proxy credential; redeem it first
at `POST /connect/redeem` (see above) to obtain the actual `connection_code`.
Either way, each successful proxy response includes a new single-use value
in `X-Connection-Code`; use that value as the Bearer token for the next
request. The proxy refreshes an expired provider access token when a refresh
token is available, and rotates the connection code after every request.
Pagination `Link` headers from the upstream are forwarded to the caller
unchanged.

## Trusted API identities

A platform can establish or log in a tenant only when its catalog selection
contains `tenantIdentity` with an `operationId` and HTTPS `namespace`. The
selected operation must declare `x-authenticated-principal` with a stable,
non-reassigned user subject and must require the selected OAuth scheme. The
initial runtime subset accepts a fixed HTTPS `GET` operation without parameters
or redirects. It supports string and integer subjects, provider- and
client-scoped identities, and optional display claims. It never uses email to
identify or link tenants.

Regression coverage includes parser and composed-catalog fixtures, PostgreSQL
mock OAuth identity/bootstrap/redemption flows, browser binding/replay checks,
and standalone API login with identity-only scopes.

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

`catalog.json` in the `localthought/overlays` repository is the source of the
integration catalog. The proxy defaults to an immutable raw GitHub URL for a
specific catalog commit; set `CATALOG_PATH` to another HTTPS revision for a
controlled rollout, or to a local fixture for development. Each platform names
one pinned OpenAPI document and zero or more pinned Overlay Specification
documents. At startup the proxy downloads those HTTPS sources, applies each
overlay's `update` actions, and keeps the resulting YAML in memory.

A catalog entry may also contain a **selection** object. Consumer
**query_overrides** remain separate from the composed OpenAPI document:
choosing to include archived records is client configuration, not an API
default. The proxy passes those choices through.
**selection.oauthSecurityScheme** is trusted server configuration: when a
document contains multiple OAuth authorization-code Security Schemes, it names
the one the proxy uses. The value must be a string naming a declared scheme.
**GET /catalog/{platform}.selection.json** returns the selection object (or an
empty object when absent).

Publish catalog changes in this order: publish and verify the immutable OAD and
overlay pins, commit the root `catalog.json`, then update the proxy's pinned
catalog URL and restart the service. Keep each OAD and overlay URL pinned to a
commit so the generated `/catalog` documents change only through an explicit
catalog revision.

### 3. Run it

```sh
cargo run
```

Then open `http://localhost:8080` (or your configured `BASE_URL`) in a
browser.

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
| `build_app(&Config) -> Result<axum::Router, Error>` | Loads the catalog, connects to PostgreSQL, returns the router (CORS and tracing layers included). |
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

## Security

The service stores encrypted provider credentials only inside short-lived,
encrypted connection envelopes and forwards requests only through catalog
allowlists. [SECURITY.md](SECURITY.md) describes the remaining deployment and
operational controls.

## Notes on statelessness

- Session data (email, name, picture, expiry) lives entirely inside the
  encrypted `session` cookie — nothing is written to disk or a database.
- The configured OIDC login keeps its CSRF token and PKCE verifier in the
  short-lived encrypted `oauth_state` cookie. Catalog API login and integration
  authorization use one-use PostgreSQL state plus encrypted browser binding
  cookies, so callbacks can reach a different instance safely.
- Cookies are marked `Secure`, so in production `BASE_URL` must use
  `https://`. `http://localhost` works during local development because
  browsers treat `localhost` as a secure context.
- The tenant secret is likewise never stored: it's an HMAC of the tenant
  identity keyed by `SERVER_SECRET`, so any instance that knows
  `SERVER_SECRET` can derive or verify it on the fly.
- The pending `/connect` redirect (used to return to `/connect` after a
  login detour) is held in a short-lived encrypted cookie
  (`connect_redirect`), the same pattern as `oauth_state`.

## Browser clients

CORS permits explicit bearer-token requests from browser frontends and answers
OPTIONS preflights. Responses expose `X-Connection-Code`, `Link`, `Retry-After`,
`ETag`, `X-Total-Count` and `X-Next-Page`. Clients must persist a rotated code
before continuing pagination and must never replay a consumed code after an
uncertain response. Cookie credentials are not enabled for CORS; provider
login and consent remain top-level browser navigations.

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

CI provides PostgreSQL and includes the database tests. Coverage includes concurrent cold-start schema initialization, selected-platform rendering and escaping, credential-free sign-in, return-address validation, PKCE, consent/session requirements, handoff expiry, wrong-verifier refusal, concurrent/replayed redemption, optional tenant-secret grants, revocation and provider-cookie/account binding. Live Google/GitHub authorization and a hub read-only import must be verified against both matching deployed revisions; local fixture checks do not establish live access.

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

When upgrading the previous deployment, copy its application-login client ID/secret to `APP_AUTH_CLIENT_ID` / `APP_AUTH_CLIENT_SECRET` and configure the same authorization, token, and userinfo endpoints before deploying. Keep the identity issuer stable: tenant identities are derived from its subject identifiers. Set the existing public PKCE client's `_CLIENT_AUTH_METHOD=none`. Existing credential envelopes, completed handoffs, provider credential variable names and browser sessions remain valid. The optional session identity label is backward compatible. In-flight connection authorizations created before this upgrade may require restarting from the hub because their sealed context lacks the new bootstrap mode.
