# Running your own integration proxy

When you connect a third-party service (GitHub, Google Calendar, Notion, …)
from Atomic Server or the Atomic data browser, the OAuth grant or API key for
that service is held by an **integration proxy**, and requests to the service
go through it. By default that proxy is the one atomic.place runs. This page
is for anyone who would rather run their own: it covers what the proxy does,
how to run and configure it, how to register your own OAuth apps, and how to
point Atomic Server and the data browser at it.

It describes `atomic-integration-proxy`
[0.2.0 on crates.io](https://crates.io/crates/atomic-integration-proxy).
Everything here was checked against that version's source in this directory;
[What is not verified](#what-is-not-verified) lists what was not tried.

- [What the proxy does, and what it doesn't](#what-the-proxy-does-and-what-it-doesnt)
- [Security model](#security-model)
- [Requirements](#requirements)
- [Installing](#installing)
- [Configuration](#configuration)
- [TLS and a reverse proxy](#tls-and-a-reverse-proxy)
- [Running it as a service](#running-it-as-a-service)
- [Registering OAuth apps](#registering-oauth-apps)
- [Pointing Atomic at your proxy](#pointing-atomic-at-your-proxy)
- [Upgrading](#upgrading)
- [Backups](#backups)
- [Health checks and monitoring](#health-checks-and-monitoring)
- [Limits](#limits)
- [What is not verified](#what-is-not-verified)

## What the proxy does, and what it doesn't

The proxy:

- runs the OAuth 2.0 authorization-code flow (with PKCE where the provider
  supports it) against a provider, or shows a form where the user pastes an
  API key for API-key providers such as Clockify, or, for a platform whose
  document requires no security (the Pets demo), asks only for consent;
- stores the resulting token or key encrypted in PostgreSQL, as a
  **connection** owned by the user's Atomic agent;
- forwards requests from that agent, and from app agents the owner has
  **delegated** the connection to, to the provider, attaching the credential
  and refreshing an expiring OAuth token;
- forwards only the HTTP methods and paths that the provider's entry in the
  **catalog** allows.

The proxy does not:

- have accounts, logins or passwords. The caller's Atomic agent
  (`atomic:agent:<Ed25519 public key>`) is the account, and every request is
  signed with that agent's key;
- return a provider token or API key to any client, ever;
- store any provider data. It passes responses through without keeping them;
  syncing and storing records is the job of Atomic Server and its plugins;
- let a caller choose the provider's host, token endpoint or scopes. These
  come from the catalog, which you control.

## Security model

In short (the full list is in [SECURITY.md](SECURITY.md)):

- **Sealed credentials.** Each provider credential is encrypted with
  XChaCha20-Poly1305 under `ENCRYPTION_KEY`, with the connection id as
  associated data, so a sealed value copied into another row does not
  decrypt. Anyone with the database but not the key cannot read credentials.
  Anyone with both can.
- **Catalog allowlist.** The upstream host is the `servers` URL of the
  platform's composed OpenAPI document. A request is forwarded only if its
  method and path match an operation in that document. Paths with `.` or
  `..` segments are refused before matching. A bounded subset of each
  request is validated: required query parameters, enum values of query
  parameters, and the presence and content type of the body. Full JSON Schema
  validation of bodies is **not** done.
- **No redirect-following.** Upstream redirects are never followed, so a
  provider cannot redirect a credentialed request somewhere the catalog did
  not allow. The caller's `Authorization` and `x-atomic-*` headers are never
  forwarded.
- **Signed requests.** Every request that uses or manages a connection
  carries an Atomic v2 signature: Ed25519 over the method, the full URL
  (`BASE_URL` plus path and query), a timestamp, and a SHA-256 of the body.
  Timestamps must be within ±5 minutes of the proxy's clock, and each signed
  message is accepted once. The proxy stores the agent id only; it looks no
  key up, because the key is part of the id.
- **Delegations.** A connection's owner can delegate it to an app agent (an
  installed plugin) and register runtimes (a node's agent for that app).
  Delegations and runtimes are checked on every request, so removing one
  takes effect on the next request. A plugin frame that cannot keep a key
  uses a capability, signed by the owner, valid for at most 15 minutes, and
  bound to a key the frame holds in memory.
- **Idle expiry.** A connection with no authenticated request for 90 days is
  deleted.

Things this model does **not** protect against are listed under
[Limits](#limits).

## Requirements

- **PostgreSQL.** CI runs the tests against PostgreSQL 16. The schema uses
  nothing recent (`CREATE TABLE IF NOT EXISTS`, `make_interval`), but older
  versions have not been tested. The proxy creates its own tables at startup,
  so its role needs `CREATE` on the `public` schema. On PostgreSQL 15 and
  newer, `public` no longer grants that to everyone, so make the role the
  database's owner:

  ```sh
  sudo -u postgres createuser --pwprompt integration_proxy
  sudo -u postgres createdb --owner integration_proxy integration_proxy
  ```

- **A public HTTPS origin**, such as `https://proxy.example.org`. OAuth
  providers redirect browsers to it, the consent cookies are `Secure`, and
  every signature covers it. `http://localhost` works for development only.
- **Outbound HTTPS** to the providers you enable, and, at every start, to
  wherever the catalog and its OpenAPI and overlay documents are hosted
  (by default `ontola.github.io` and `raw.githubusercontent.com`; see
  [`CATALOG_PATH`](#catalog_path)).
- **One TCP port** for HTTP (`PORT`, default 8080).
- To build from source: a stable Rust toolchain. The published binary is not
  distributed pre-built.

## Installing

The crate ships a binary called `integration-proxy`. Choose one of these
three ways to run it.

### cargo install

```sh
cargo install atomic-integration-proxy --version 0.2.0 --locked
# installs ~/.cargo/bin/integration-proxy
```

`--locked` builds with the exact dependency versions the crate was published
with. On Linux the PostgreSQL client uses OpenSSL (`native-tls`), so the build
needs `pkg-config` and the OpenSSL headers (`libssl-dev` on Debian and
Ubuntu), and the running binary needs `libssl3` and `ca-certificates`.

### Docker

[`Dockerfile`](Dockerfile) builds that same crates.io release (not the source
of the checkout it sits in) into a `debian:bookworm-slim` image that runs as
a non-root user:

```sh
docker build -t atomic-integration-proxy \
  --build-arg PROXY_VERSION=0.2.0 \
  https://github.com/ontola/atomic-plugins.git#main:integration-proxy

docker run -d --name integration-proxy --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file /etc/integration-proxy/env \
  atomic-integration-proxy
```

Publish the port on `127.0.0.1` and put a TLS-terminating reverse proxy in
front (see [below](#tls-and-a-reverse-proxy)); inside the container the
proxy listens on `0.0.0.0`. If PostgreSQL runs on the Docker host, a
container reaches it at the host's bridge address (or
`host.docker.internal` with Docker Desktop), not at `127.0.0.1`.

### A wrapper crate

The library exposes the whole server as `atomic_integration_proxy::run()`, so
a deployment can also be its own small crate that depends on the published
version. That is what [`examples/heroku-wrapper/`](examples/heroku-wrapper/)
is. Its entire `main.rs` is:

```rust
#[tokio::main]
async fn main() -> std::process::ExitCode {
    atomic_integration_proxy::run().await
}
```

A wrapper is useful if you want to commit a `Cargo.lock`, or to plug in your
own admission check with `build_app_with_access` (see the
[library API](README.md#library-crate)).

## Configuration

All configuration comes from environment variables. The process does not
read `.env` files itself; systemd's `EnvironmentFile=` or Docker's
`--env-file` can load one. An example
`/etc/integration-proxy/env` (readable only by root and the service user).
Neither systemd nor Docker strips a `#` comment that follows a value, so keep
comments on their own lines:

```sh
BASE_URL=https://proxy.example.org
PORT=8080
DATABASE_URL=postgres://integration_proxy:PASSWORD@127.0.0.1:5432/integration_proxy?sslmode=disable
# Generate both secrets as described below.
ENCRYPTION_KEY=...
SESSION_SECRET=...
# CATALOG_PATH=/etc/integration-proxy/catalog.json
# ALLOWED_AGENTS=atomic:agent:...
# Who runs this proxy, as the landing and consent pages say (0.2.1 and later).
OPERATOR_NAME=Example Org
OPERATOR_URL=https://example.org
OAUTH_GITHUB_ISSUES_CLIENT_ID=...
OAUTH_GITHUB_ISSUES_CLIENT_SECRET=...
RUST_LOG=info
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL URL. See [PostgreSQL and TLS](#database_url-and-postgresql-tls). |
| `ENCRYPTION_KEY` | yes | Unpadded base64url encoding of 32 random bytes (43 characters). |
| `BASE_URL` | yes in production | The exact public origin, e.g. `https://proxy.example.org`. Defaults to `http://localhost:8080`. |
| `SESSION_SECRET` | strongly recommended | Any long random string; keys the consent and OAuth cookies. |
| `PORT` | no | Listening port, default `8080`. The proxy always binds `0.0.0.0`. |
| `CATALOG_PATH` | no | Catalog location. Defaults to `https://ontola.github.io/atomic-plugins/overlays/catalog.json`. |
| `ALLOWED_AGENTS` | no | Comma-separated agent ids. When set, only these agents may own connections. |
| `REVOKED_SUBJECTS` | no | Comma-separated agent ids that may not own connections. |
| `OPERATOR_NAME` | no, recommended | Who runs this proxy, as the landing page and the consent page name them ("Use Example Org to sync …", "run by Example Org"). The consent page also shows the host of `BASE_URL`. Defaults to `this integration proxy`, and the pages then name no one. 0.2.1 and later. |
| `OPERATOR_URL` | no | Link for `OPERATOR_NAME` on those pages: an absolute `http(s)` URL without credentials. Anything else stops the proxy at startup. 0.2.1 and later. |
| `OAUTH_<PLATFORM>_CLIENT_ID`, `_CLIENT_SECRET`, `_CLIENT_AUTH_METHOD` | per OAuth platform | See [Registering OAuth apps](#registering-oauth-apps). |
| `RUST_LOG` | no | Log filter, default `info`. |

Variables from before 0.2 (`APP_AUTH_*`, `SERVER_SECRET`) are ignored.

### `DATABASE_URL` and PostgreSQL TLS

The PostgreSQL client uses a certificate-verifying TLS connector with the
system's trusted roots. The URL's `sslmode` decides whether TLS is used at
all. The client supports `disable`, `prefer` (the default) and `require`;
the `verify-ca`, `verify-full` and `sslrootcert` options of `libpq` are not
supported. Tested against a PostgreSQL 16 container with TLS off:

| `sslmode` | Server without TLS | Server with TLS |
| --- | --- | --- |
| omitted or `prefer` | connects **without** TLS | TLS, certificate must verify |
| `disable` | connects without TLS | connects without TLS |
| `require` | refuses to start (`error performing TLS handshake`) | TLS, certificate must verify |

So:

- **PostgreSQL on the same host, over loopback or a Unix socket:** use
  `?sslmode=disable`. It says what happens, and it avoids a failed handshake
  if the server has TLS on with a self-signed certificate.
- **PostgreSQL across any network:** use `?sslmode=require`, with a
  certificate that chains to a public root. With the default `prefer`, an
  attacker on the path can make the server look like it has no TLS, and the
  client then continues in plaintext. A private CA would have to be added to
  the system trust store; this has not been tried.
- Never use `sslmode=disable` across a network.

### `ENCRYPTION_KEY`

Generate one once and keep it:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

The value must be unpadded base64url (a trailing `=` is refused) that decodes
to exactly 32 bytes. Otherwise the proxy refuses to start.

**There is no key rotation.** Sealed values carry a format version but no key
id, and the proxy holds one key. If `ENCRYPTION_KEY` changes, the proxy can
no longer open any stored connection. Each one then answers
`404 unknown_connection`, as if it had been deleted, and every user has to
connect again. Those rows stay until the 90-day idle sweep removes them. If
the key leaks, the only remedy is to set a new key and have everyone
reconnect (and delete the old rows:
`DELETE FROM agent_connections;` also removes their delegations).

### `SESSION_SECRET`

This secret keys the two short-lived (10-minute) encrypted cookies that carry
a user from the consent page to the provider and back. If it is unset, the
proxy logs a warning and generates a random key at every start. A user who is
halfway through connecting when the proxy restarts then has to start again.
Stored connections are not affected. Set it to a long random value, such as
`openssl rand -base64 48`, and keep it stable across restarts. If you run
several instances behind one name, they must share it.

### `BASE_URL`

`BASE_URL` must be exactly the origin that browsers and Atomic Server use to
reach the proxy: scheme, host, and port if it is not the default. Use no
trailing path. It is used for three things:

- the OAuth callback URL `<BASE_URL>/oauth/<platform>/callback` you register
  with each provider;
- the first part of the URL covered by every request signature. The proxy
  rebuilds the signed URL from `BASE_URL` and the path and query it received,
  never from the `Host` header. If `BASE_URL` is wrong, every signed request
  fails with `401 bad_signature`;
- its origin is the required `aud` of frame capabilities.

At startup the proxy refuses a `BASE_URL` that is not http(s) or that has
credentials, a query or a fragment. A trailing `/` is removed.

### `CATALOG_PATH`

The catalog lists the platforms the proxy supports. For each one it names a
pinned OpenAPI document and the overlays applied to it. At every start the
proxy downloads the catalog and each of those documents over HTTPS, composes
them, and keeps the result in memory. If any download fails, the proxy does
not start. Non-HTTPS sources are refused. `CATALOG_PATH` may be an HTTPS URL
or a local file; the documents it lists must be HTTPS URLs.

The default is `catalog.json` as GitHub Pages serves it from this
repository's `main` branch. The OpenAPI documents it lists are pinned to
commits, but **the overlays are not**: a restart picks up whatever `main`
serves at that moment. To make restarts reproducible, pin the whole catalog
to a commit and serve it locally:

```sh
SHA=<an ontola/atomic-plugins commit>
curl -fsSL "https://raw.githubusercontent.com/ontola/atomic-plugins/$SHA/overlays/catalog.json" \
  | sed "s#https://ontola.github.io/atomic-plugins/overlays/#https://raw.githubusercontent.com/ontola/atomic-plugins/$SHA/overlays/#g" \
  > /etc/integration-proxy/catalog.json
# then: CATALOG_PATH=/etc/integration-proxy/catalog.json
```

This procedure was run against this repository's `main` and composed all
eight platforms. The same file is also where you narrow the allowlist:
delete the platform entries you don't want to offer. Keep the remaining
entries' `name` values unchanged, because the `OAUTH_*` variable names and
callback URLs are derived from them.

### `ALLOWED_AGENTS` and `REVOKED_SUBJECTS`

By default, any Atomic agent that can reach the proxy can create
connections. The proxy has no signup step, so anyone can use your OAuth apps
and your server. To restrict it to your own people, list their agents:

```sh
ALLOWED_AGENTS=atomic:agent:AbC...,atomic:agent:XyZ...
```

The check is on the connection's **owner**, the agent that signed
`/connect/redeem`. It runs at redeem time and on every signed request, and
delegated app agents and plugin frames are judged as their owner, so you
only list the users' own agents, not each installed app. `REVOKED_SUBJECTS`
does the opposite: it refuses the agents it lists, and it takes precedence.
Both accept `atomic:agent:` or legacy `did:ad:agent:` ids in either base64
alphabet. An entry that does not parse as an agent id is ignored, with a
warning in the log at startup. If every `ALLOWED_AGENTS` entry is invalid,
nobody is admitted.

A refused agent gets `403 access_denied`. The unauthenticated routes (`/`,
`/catalog`, the consent page and the OAuth callback) stay reachable by
anyone; the list only stops anyone else from redeeming or using a
connection.

## TLS and a reverse proxy

The proxy speaks plain HTTP. Put a TLS-terminating reverse proxy in front of
it, and make sure the proxy's own port is not reachable from outside. It
binds `0.0.0.0` and has no setting to bind only loopback, so use a firewall,
or publish only on `127.0.0.1` as in the Docker example.

**Caddy** (obtains and renews the certificate itself):

```caddyfile
proxy.example.org {
	reverse_proxy 127.0.0.1:8080
}
```

**nginx** (certificate paths from certbot, adjust to yours):

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name proxy.example.org;
    ssl_certificate     /etc/letsencrypt/live/proxy.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy.example.org/privkey.pem;

    # The proxy accepts request bodies up to 2 MiB; nginx's default is 1 MiB.
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_read_timeout 60s;
    }
}
```

The reverse proxy must pass the path and query through unchanged: they are
part of what the client signed. Neither snippet rewrites them. Do not mount
the proxy under a sub-path. Atomic Server expects a bare origin (see
[below](#pointing-atomic-at-your-proxy)).

## Running it as a service

A systemd unit for a `cargo install`ed binary copied to
`/usr/local/bin/integration-proxy`, with the environment file above. This
unit passes `systemd-analyze verify` (systemd 252, Debian bookworm) but has
not been run as a service; verify it on your own system too.

```ini
# /etc/systemd/system/integration-proxy.service
[Unit]
Description=Atomic integration proxy
Wants=network-online.target
After=network-online.target postgresql.service

[Service]
Type=exec
ExecStart=/usr/local/bin/integration-proxy
EnvironmentFile=/etc/integration-proxy/env
DynamicUser=yes
# The proxy exits if PostgreSQL or the catalog is unreachable at startup.
Restart=on-failure
RestartSec=5s
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes
MemoryDenyWriteExecute=yes

[Install]
WantedBy=multi-user.target
```

```sh
sudo install -m 0755 ~/.cargo/bin/integration-proxy /usr/local/bin/
sudo install -d -m 0750 /etc/integration-proxy
sudo install -m 0600 env /etc/integration-proxy/env   # read by systemd as root
sudo systemctl daemon-reload
sudo systemctl enable --now integration-proxy
curl -fsS https://proxy.example.org/healthz            # prints: ok
```

With `DynamicUser=yes` the process can write nothing on disk. It needs to
read only a local `CATALOG_PATH` file, if you use one, so make that file
world-readable or add `ReadOnlyPaths=`. On stop, the process exits at once
and does not drain in-flight requests.

The same binary runs on any host that provides these environment variables
and a port. For Heroku, see [`examples/heroku-wrapper/`](examples/heroku-wrapper/)
and the [`Procfile`](Procfile).

## Registering OAuth apps

For each OAuth platform you want to offer, register an OAuth app (client)
with the provider under your own account, and give the proxy its
credentials. Platforms without credentials still appear in `/catalog`, but
their consent page answers "This platform is not available for connection".

Two things are the same for every platform:

- **Callback (redirect) URL:** `<BASE_URL>/oauth/<platform>/callback`. For
  example, `https://proxy.example.org/oauth/github-issues/callback`. Register
  it exactly: same scheme, host, port and path, no trailing slash.
- **Environment variables:** `OAUTH_` + the platform name in upper case with
  `-` replaced by `_`, followed by `_CLIENT_ID`, `_CLIENT_SECRET` and,
  optionally, `_CLIENT_AUTH_METHOD` (`none`, `client_secret_post` or
  `client_secret_basic`). When `_CLIENT_AUTH_METHOD` is omitted, the proxy
  uses the first method the catalog declares that it implements. With no
  declaration it uses `client_secret_post`, or `client_secret_basic` when the
  token operation requires it. A method of `none` needs no secret.

Scopes are fixed by the catalog; you cannot add or remove them through
configuration. The table lists the platforms in the catalog on `main` at the
time of writing. `GET <BASE_URL>/catalog` shows what your proxy actually
loaded.

| Platform | Variables | Where to register | Scopes requested | Notes |
| --- | --- | --- | --- | --- |
| `github-issues` | `OAUTH_GITHUB_ISSUES_CLIENT_ID`, `_CLIENT_SECRET` | [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) | `repo` | An OAuth App, not a GitHub App. `repo` grants read and write access to all of the user's repositories, including private ones. |
| `google-calendar` | `OAUTH_GOOGLE_CALENDAR_CLIENT_ID`, `_CLIENT_SECRET` | [Google Cloud console → Credentials](https://console.cloud.google.com/apis/credentials): an OAuth client ID of type *Web application*; also enable the Google Calendar API and configure the consent screen | `calendar.events`, `calendar.calendarlist.readonly` | The catalog selects offline access, so Google issues a refresh token. Google treats these scopes as sensitive. An unverified app shows a warning, is limited to test users while in *Testing*, and, per Google's documentation, its refresh tokens then expire after 7 days. |
| `notion` | `OAUTH_NOTION_CLIENT_ID`, `_CLIENT_SECRET` | [Notion → Integrations](https://www.notion.so/profile/integrations): a *public* integration, with your callback as a redirect URI | none (Notion shares pages the user picks) | Uses `client_secret_basic`, selected automatically; no PKCE (Notion does not support it). |
| `todoist` | `OAUTH_TODOIST_CLIENT_ID`, `_CLIENT_SECRET` | [Todoist App Management Console](https://developer.todoist.com/appconsole.html) | `data:read` | Read-only. |
| `moneybird` | `OAUTH_MONEYBIRD_CLIENT_ID`, `_CLIENT_SECRET` | [Moneybird → register an application](https://moneybird.com/user/applications/new) (an external application, not a personal API token) | `sales_invoices documents estimates bank time_entries settings` | The user supplies their administration id when connecting. |
| `spotify` | `OAUTH_SPOTIFY_CLIENT_ID` | [Spotify for Developers → Dashboard](https://developer.spotify.com/dashboard) | `playlist-read-private`, `playlist-read-collaborative` | A public client: the catalog declares only `none`, so no secret is needed or sent (setting `OAUTH_SPOTIFY_CLIENT_AUTH_METHOD=none` is equivalent). Apps in development mode only admit users you allowlist. |
| `discord` | `OAUTH_DISCORD_CLIENT_ID`, `_CLIENT_SECRET` | [Discord Developer Portal → Applications](https://discord.com/developers/applications) → OAuth2 → Redirects | `identify`, `guilds` | No bot token needed. |
| `clockify` | none | nothing to register | n/a | An API-key platform. The consent page asks the user for their own key (Clockify → Profile settings → API), which is sealed like an OAuth token. |
| `pets` | none | nothing to register | n/a | A static, read-only demo API published on GitHub Pages next to the catalog (`overlays/pets-demo/`), for the Pets drive app. Its document requires no security, so the consent page asks for nothing and no credential is stored or sent. Needs 0.2.2 or later; 0.2.1 lists it but refuses to connect it. |

The consoles' names and layouts change over time; the links were current
when this was written, and no registration was redone for this guide. A
provider may also restrict what it accepts as a redirect URL. Spotify, for
example, documents that it no longer accepts `http://localhost`, only HTTPS
or a loopback IP such as `http://127.0.0.1:<port>`.

After changing any `OAUTH_*` variable, restart the proxy. The variables are
read when a connect starts or a token is refreshed, but restarting is the
supported way to apply them.

## Pointing Atomic at your proxy

Atomic Server and the data browser are configured **separately**. Both must
point at the same proxy. Nothing keeps them in sync yet; that is tracked in
[atomic-server#1700](https://github.com/ontola/atomic-server/issues/1700).

**Atomic Server** (for plugins that call a provider through the server):
start it with `--integration-proxy-url https://proxy.example.org`, or set
`ATOMIC_INTEGRATION_PROXY_URL=https://proxy.example.org`. The value is the
proxy's bare origin, exactly its `BASE_URL`, and the server checks at boot
that it has no path, query, fragment or credentials. The server signs
requests to exactly that origin as the installed plugin's app agent. This
option comes from
[atomic-server#1702](https://github.com/ontola/atomic-server/pull/1702),
which is in the atomic-server commit this repository pins
(`.atomic-server-ref`) but was not yet merged upstream when this was
written. Check your Atomic Server's `--help` for it.

- **Unset, today:** with #1702, if neither `--integration-proxy-url` nor
  `ATOMIC_INTEGRATION_PROXY_URL` is set, no proxy is configured, and plugins
  cannot reach one. Set it to use any proxy at all.
- **Unset, later (planned, not yet released):** the default is planned to
  become atomic.place's proxy, `https://integrations.atomic.place`, in the
  same change that switches the data browser's build-time default (below)
  away from `https://localthought.io`. From then on: if unset, the server
  uses atomic.place's proxy (from version **TODO: fill in the atomic-server
  release that ships this default**); set this flag to use your own.

Which addresses the proxy may be on: the server refuses outgoing requests to
private, loopback and link-local addresses, and before
[atomic-server#1731](https://github.com/ontola/atomic-server/pull/1731) it
exempted the proxy only when `--integration-proxy-url` was a literal
loopback address or `localhost`. With #1731, a URL whose origin (scheme,
host and port) equals exactly the configured proxy origin may resolve to a
loopback or private address (RFC 1918, CGNAT `100.64.0.0/10`, IPv6 ULA
`fc00::/7`, and their IPv4-mapped forms). That allows a proxy on your LAN
(`http://proxy.lan:8787`) or on the Docker host
(`http://host.docker.internal:8787`). Link-local addresses (including cloud
metadata endpoints such as `169.254.169.254`), unspecified and multicast
addresses are still refused, even for the proxy. Every other destination
keeps the full checks. #1731 was **open, and not in this repository's
pinned atomic-server commit**, when this was written; without it, use a
public address or a literal loopback address for the proxy.

**The data browser** (where users click *Connect*): open **Settings →
Integrations** and enter the proxy's origin (HTTPS, or loopback HTTP for
development). The setting is stored per browser, in `localStorage` under
`integration-proxy-url`. Other browsers and other users still use the
default until they change it too. An empty value restores the default, and
an invalid value is ignored in favour of the default. The default is fixed
when the data browser is built, from `VITE_INTEGRATION_PROXY_URL`. It is
meant to be atomic.place's proxy (`https://integrations.atomic.place`, once
that is live); builds at the time of writing fall back to
`https://localthought.io`. If you build the data browser yourself, set
`VITE_INTEGRATION_PROXY_URL=https://proxy.example.org` to make your proxy the
default for everyone who uses that build.

What the data browser does with it, when a user clicks *Connect* for a
drive app (atomic-server#1697): it sends the whole tab to the proxy's
`/connect` (no login, no `user_id`); the proxy's page shows the platform and
the data browser's origin, and goes to the provider (or asks for the API
key); the proxy returns the tab to the data browser's `/app/integrations`
with a single-use handoff code. The data browser then redeems it at `POST
/connect/redeem`, signed with the user's Atomic key, which makes the user
the connection's owner, and delegates the connection to the app's agent
(`POST /connections/{id}/agents`). From then on, the app's null-origin frame
calls `/proxy/{connection_id}/{platform}/…` on your proxy directly, with a
capability the data browser signed and a key only the frame holds. Your
proxy therefore has to answer CORS for the data browser's origin and for
`Origin: null`; it does, for any origin and without cookies. If a user
already has a connection for that platform, the data browser offers to
reuse it, which only adds a delegation.

Connections are stored in the proxy that created them. Pointing Atomic at a
different proxy does not move them: users connect again on the new one.

## Upgrading

- **Patch releases** (`0.2.x`): install the new version (`cargo install
  atomic-integration-proxy --version 0.2.x --locked`, or rebuild the image
  with a new `PROXY_VERSION`) and restart.
- **Minor releases before 1.0** (`0.2` to `0.3`) may be breaking, as 0.1 to
  0.2 was. Read the [README](README.md) of the new version, in particular
  anything like [What was removed](README.md#what-was-removed-flag-day), and
  the commits to `integration-proxy/` in between, before upgrading. There is
  no separate changelog.
- **Schema:** the proxy has no migration tool. At startup it runs
  `CREATE TABLE/INDEX IF NOT EXISTS` for its tables, in a transaction under
  an advisory lock, so several instances can start at once. Tables that an
  older version used are left in place. After upgrading from 0.1,
  `DROP TABLE IF EXISTS connection_codes, oauth_states;` removes the old
  ones. That is optional and irreversible.
- **Rolling back** to an older binary against a database a newer one has
  used has not been tested. Take a backup before upgrading.
- **Clients:** 0.2 accepts only Atomic v2 signatures. Atomic Server and data
  browser builds from before the v2 work cannot use it.

## Backups

Back up the database and `ENCRYPTION_KEY` together, but store them
**separately**. The dump alone does not reveal credentials, the key alone is
useless, and a dump restored without its key is a set of connections that
all answer `404 unknown_connection`.

```sh
pg_dump --format=custom --file=integration-proxy-$(date +%F).dump \
  "postgres://integration_proxy@127.0.0.1/integration_proxy"
```

`SESSION_SECRET` and the `OAUTH_*` values do not need to match on restore:
the former only affects connects in progress, and the latter can be read
from the providers' consoles again, or regenerated there.

A restore puts back each connection's credential as it was at backup time.
Providers that rotate refresh tokens (Todoist, for one, documents this)
will have rotated them since, so the restored ones may be refused. The
affected users get `401 credential_refresh_failed` and have to connect
again. Delegations made after the backup are lost.

## Health checks and monitoring

- `GET /healthz` answers `200 ok` when a `SELECT 1` on the database
  succeeds, and `503 database unavailable` when it fails. It checks nothing
  else: not the catalog (that is loaded once, at startup) and not any
  provider. **Always use a timeout.** The check itself has none: with the
  database container paused, `/healthz` did not answer within 5 seconds.
- A lost database connection is re-established automatically, with backoff
  from 1 to 30 seconds. After a PostgreSQL restart, `/healthz` answered
  `503` for about a second and then `200` again, without restarting the
  proxy.
- The process exits with status 1 and a one-line message on stderr if the
  configuration is invalid, or if the catalog or the database is unreachable
  at startup.
- Logs go to stderr via `tracing`, filtered by `RUST_LOG`. The default is
  `info`. `RUST_LOG=info,tower_http=debug` adds a line per HTTP request. The
  proxy does not log tokens, keys or request bodies. Request paths, which
  contain connection ids, can appear at debug level. Connection ids are not
  secrets.
- There is no metrics endpoint.

## Limits

These are properties of 0.2.0 (0.2.1 where noted) that affect whether
self-hosting fits your needs:

- **No rate limiting.** One agent can send as many requests as the provider
  allows. `ALLOWED_AGENTS` is the only way to limit who can use the proxy at
  all.
- **Anyone can start a connect flow.** The consent page and OAuth callback
  need no login. `ALLOWED_AGENTS` stops strangers from redeeming or using a
  connection, not from seeing your consent page.
- **The catalog is trusted.** Whoever controls the catalog's URLs decides
  which hosts receive users' credentials. Requests to private or internal
  network ranges are not blocked if a catalog entry points there.
- **Sizes and timeouts:** request bodies up to 2 MiB; upstream responses up
  to 10 MiB; 10 s to connect upstream and 30 s per upstream request.
- **One `ENCRYPTION_KEY`**, with no rotation (see above).
- **Branding:** the landing and consent pages name the operator from
  `OPERATOR_NAME` (linked to `OPERATOR_URL`), and the consent page shows the
  host of `BASE_URL`, so users can see whose proxy they are granting access
  to. Before 0.2.1 both pages said "LocalThought" whoever ran the proxy. The
  logo (`/logo.png`, LocalThought's) and the page layout are still compiled
  into the binary and are not configurable, and the `User-Agent` sent to
  providers is still `LocalThought-integration-proxy`.
- **Binds `0.0.0.0` only**, with no graceful drain on shutdown.
- **Startup depends on the network:** the catalog and every document it
  lists are downloaded at each start.

## What is not verified

- Tested for this guide, against PostgreSQL 16 in Docker on macOS: `cargo
  install`-equivalent release build, the Docker image (build, start,
  `/healthz`, `/catalog`, non-root user), the three `sslmode` behaviours, the
  pinned-catalog procedure, and `/healthz` during a database pause and
  restart. That is all.
- **Not tried:** running the systemd unit (only `systemd-analyze verify`
  was run on it), the Caddy and nginx configurations, a
  PostgreSQL other than 16, a PostgreSQL behind TLS, and a private CA.
- **No provider connection was made** against a self-hosted proxy for this
  guide. The per-platform registration steps are *declared* from the catalog
  and the providers' documentation, not verified by a live connect. Which
  platforms currently have live evidence is tracked in this repository's
  [integrations/README.md](../integrations/README.md).
- [SECURITY.md](SECURITY.md#not-verified) lists what is unverified about the
  protocol itself. For example, it states that no real client had signed
  against the proxy yet.
- The Atomic Server option (atomic-server#1702) was unmerged upstream when
  this was written, though in this repository's pinned atomic-server commit;
  the private-address rule (atomic-server#1731) was open and not in the pin.
  The planned default (`https://integrations.atomic.place`) is not
  released. The data-browser setting was described from the atomic-server
  source on its `feat/plugin-debug` branch
  (`browser/data-browser/src/components/Settings/IntegrationSettings.tsx`
  and `browser/data-browser/src/helpers/integrationProxy.ts`), not from a
  release. The connect flow above was read from atomic-server#1697 and run
  against this repository's mock proxy
  (`integrations/localthought/mock-proxy.mjs`, which re-implements the
  proxy's signature, capability and delegation checks) in the drive apps'
  e2e tests, not against a running `integration-proxy`.

Questions and corrections:
[ontola/atomic-plugins issues](https://github.com/ontola/atomic-plugins/issues).
