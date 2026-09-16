# Connection security

## Browser bootstrap and credential handoff

New browser clients request a specific catalog platform at `/connect`, with a return URI, local actor id, S256 PKCE challenge and explicit credential grant. A catalog-selected `tenantIdentity` operation can establish the tenant from the same provider OAuth authorization; an OpenAPI declaration without that trusted catalog selection has no authority. The identity request is a fixed HTTPS authenticated GET, has no redirects, and accepts only a stable, non-reassigned provider or client subject. Email is display data only. A tenant secret is included only for the explicit `connection+tenant_secret` grant and is disclosed during consent. Standalone API login uses the same trusted operation and browser binding, issues no connection credential, and returns only to `/` or an already validated pending connection.

The complete request survives configured application login inside a short-lived encrypted cookie. Consent requires a cookie-bound random CSRF token and a single-use database nonce. It requires either an existing session or a catalog-trusted identity bootstrap. Bootstrap rejects a newly appeared session before exchanging the OAuth code; existing-session connections retain their original tenant. Return URIs require HTTPS (HTTP only for loopback development), no embedded user credentials or fragment, and no pre-existing credential/error fields. The hub creates and validates its own return state and binds it to the actor, drive and platform.

Provider OAuth state binds the platform, tenant, user, callback, PKCE verifier and an encrypted bootstrap context. A separate Secure/HttpOnly/SameSite=Lax browser cookie and the original browser binding are required at callback for the new flow. Provider cancellation returns only a generic error to the already validated hub URI. Existing signed OAuth flows retain their prior callback format.

A new callback returns only a random five-minute handoff code, never a token envelope or tenant secret. `/connect/redeem` requires the original PKCE verifier and atomically deletes the matching, unexpired handoff before issuing one rotating connection credential. Wrong verifiers do not burn a valid handoff; replays and concurrent second redemptions fail. The encrypted database payload carries platform/tenant/user identity and the exact requested grant. Revocation is checked again at redemption. Handoff codes cannot be used directly as proxy credentials. Redemption and consent responses are non-cacheable and use a no-referrer policy.

The browser clears callback parameters before further use, retains pending state outside graph resources, and removes its verifier when redeeming. A lost redemption response requires reconnecting rather than blindly retrying. The existing ten-minute idle expiry and one-use rotation rules still apply to proxy credentials (the handoff code above keeps its own, separate five-minute lifetime).

The legacy tenant-proof endpoints remain for compatibility. They are not used by the new hub flow. The legacy tenant-secret redirect is deprecated; new callers must request the optional grant through PKCE redemption. No existing tenant or provider secrets are rotated by this deployment.

## Tenant session

`/session` signs a timestamp and `/connect` checks a tenant response and a
tenant-vouched user id. This proves possession of the tenant secret, but it is
a bearer credential: anyone who obtains it can mint proofs for any user id.
Use a high-entropy `SERVER_SECRET`, give every tenant a distinct identity, and
rotate the server secret only with a migration plan. Challenges now contain a
random nonce and are consumed atomically in PostgreSQL when `/connect` is
confirmed; a second use is rejected. Expired nonce records are cleaned during
subsequent consumption.

## OAuth (#9)

The following are the requirements this deployment targets; see "Release
gate" below for what is still outstanding rather than already implemented.

Register a distinct redirect URI per provider and validate it exactly. Keep
the OAuth state and PKCE verifier in authenticated, short-lived, `Secure`,
`HttpOnly`, `SameSite=Lax` cookies. Bind the state to the tenant and user id;
reject callback requests whose binding does not match. Request narrowly scoped
tokens, never put access tokens, refresh tokens, or encrypted token bundles in
URLs, HTML, logs, referrers, or error messages.

An encrypted token bundle needs authenticated encryption (for example,
XChaCha20-Poly1305 or AES-256-GCM), a fresh random nonce for every encryption,
key versioning, and associated data binding it to the tenant id, user id,
provider, and expiry. A server-secret HMAC is not encryption. Prefer an
opaque, short-lived reference with server-side storage if revocation and
replay prevention are required.

## Validating proxy (#10)

The proxy must select its upstream only from a server-owned catalog entry;
never accept an upstream URL or host from the client. Resolve and validate the
requested method, path, parameters, body, and content type against the
published OAD before contacting the provider. Reject unknown paths and methods,
strip client-supplied `Authorization`, `Host`, forwarding, and proxy headers,
and apply request size, timeout, redirect, and response-size limits.

Refresh tokens only at the provider token endpoint configured for that
platform. Store rotated tokens atomically before returning a replacement
credential. Do not forward the upstream's cookies or authorization headers.
Rate-limit per tenant, audit token use without logging secrets, and return
generic authentication errors.

Implemented today: the requested path is rejected if it contains a `.` or
`..` segment before catalog validation, so it cannot normalize to a
different path than the one authorized (see `proxy::contains_traversal_segment`).
Upstream requests use a bounded connect/read timeout and disable automatic
redirects, so a redirect cannot send a request to a destination the catalog
never validated. The upstream response body is read incrementally and capped
at 10 MiB instead of being buffered in full before the limit is checked.
Request validation against the OAD (`Catalog::validate_request`) is a bounded
subset: it checks that declared *required* query parameters are present,
that an enum-constrained query parameter's value is one of the declared
values, and that a request body's presence and content type match the
operation's declared `requestBody`. It does not validate full JSON Schema
for bodies or non-enum query parameter values.

## Release gate

Provider callback URLs and credential variable names are now deterministic
from catalog platform names. Path-traversal rejection, upstream redirect
disabling, and the bounded OAD request validation above are implemented.
The remaining gate for #9 and #10 is provider registration, full JSON Schema
body validation, further SSRF hardening (e.g. blocking requests to internal
network ranges), rate limiting, and an external review of the token envelope
format before live credentials are handled.
