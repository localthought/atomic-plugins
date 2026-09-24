# Connection security

## Identity and request signatures (issue #54)

The proxy's account is an Atomic agent, `atomic:agent:<Ed25519 public key>`.
Ids are parsed by one function, accept the legacy `did:ad:agent:` prefix and
both base64 alphabets, and are canonicalized (`atomic:agent:` + unpadded
base64url) before any comparison or storage. Weak (small-order) keys are
refused and signatures are checked with `verify_strict`.

Every request that reads or changes a connection is signed with Atomic's v2
headers. The message covers the method, the full URL (the configured
`BASE_URL` plus the path and query as received, never the `Host` header),
the timestamp and a SHA-256 of the body, under a fixed `atomic-request-v2`
prefix, so a captured request cannot be replayed with another body, method,
path or proxy. The proxy accepts v2 only and never falls back to Atomic's v1
message (`"{URL} {timestamp}"`), whose proofs are reusable for five minutes
and do not cover the body. Timestamps must be within ±5 minutes; a SHA-256 of
every accepted message is stored for ten minutes and a second use is
refused, including across instances (PostgreSQL `used_challenges`).

## Connections, delegations and runtimes

A connection row holds one provider credential sealed with
XChaCha20-Poly1305 under `ENCRYPTION_KEY`, with associated data binding the
envelope to its row id, so an envelope copied into another row does not
open. The row records its platform and owner. Only the owner (the agent that
signed `/connect/redeem`) may delete it, delegate it, or list it. A delegation
names an app agent; a runtime registered by the owner names a node's agent
that acts for a delegated app. Both are read on every proxied request, so
revocation is immediate. A connection unused for 90 days is deleted with its
delegations; only an authenticated request counts as use, so knowing a
connection id does not keep it alive. Connection ids are 256-bit random
values and are not secret: an unknown id answers `404 unknown_connection`
before any signature check.

Concurrent requests that find an OAuth token about to expire take a
per-connection refresh lease, so a rotating refresh token is spent once.

## Frame capabilities

A capability is signed by the connection owner over a fixed
`integration-proxy-capability-v2` prefix plus its JSON claims, so it cannot
be confused with a request signature. It is bound to the proxy (`aud`), a
connection and platform, an app agent that must hold a live delegation, and
a frame key (`cnf`); it lasts at most 15 minutes. The request that presents
it must be signed by `cnf`, so a leaked capability without the frame's
in-memory key is useless. What it does not prevent: while the frame is open,
plugin code can make requests of its own choosing within that scope and
lifetime. The v1 capability of draft PR #72 (a bearer token) is not accepted.

## Connecting a provider

`/connect` needs no login. Its consent screen names the platform and the
destination; approval requires a cookie-bound random CSRF token, is single
use, and checks `Origin` when present. Return addresses must be `https`,
loopback `http`, or the Atomic app's `atomic://` deep link, with no embedded
credentials, fragment, or pre-set `connection_code`/`error` parameters. The
provider callback is bound to the approving browser by a separate
`Secure`/`HttpOnly`/`SameSite=Lax` cookie and returns only a five-minute,
single-use handoff code bound to the hub's PKCE challenge, never a token.
`/connect/redeem` needs the PKCE verifier **and** a v2 signature; the signer
becomes the owner, so the page that started the flow must also hold the
user's key. A wrong verifier does not burn the handoff; concurrent second
redemptions fail. Responses are `no-store`.

For an API-key platform the key is typed into the proxy's own consent page
and sealed like an OAuth token; it is never returned to the hub.

## Admission

An `AccessPolicy` is asked about the connection owner at redeem and on every
signed request (delegates and frames are judged as their owner). The default
allows everyone except `REVOKED_SUBJECTS`, optionally only `ALLOWED_AGENTS`.
The atomic.place account and tier lookup (ontola/atomic-saas#138) is not
implemented here.

## Not verified

- No real client has signed against this proxy yet; the wire format is
  aligned with the atomic-server v2 work in progress, not tested against it.
- WebCrypto Ed25519 in plugin frames was tested by hand in Chromium only
  (issue #54); Safari's engine and Firefox are unconfirmed.
- Other programs on the same machine can reach a loopback proxy; the
  signature requirement is the control, as decision 12 of #54 expects.

## OAuth (#9)

The following are the requirements this deployment targets; see "Release
gate" below for what is still outstanding rather than already implemented.

Register a distinct redirect URI per provider and validate it exactly. The
OAuth state and PKCE verifier are single-use PostgreSQL rows; the callback is
bound to the approving browser by an encrypted, short-lived, `Secure`,
`HttpOnly`, `SameSite=Lax` cookie. Request narrowly scoped
tokens, never put access tokens, refresh tokens, or encrypted token bundles in
URLs, HTML, logs, referrers, or error messages.

An encrypted token bundle needs authenticated encryption (for example,
XChaCha20-Poly1305 or AES-256-GCM), a fresh random nonce for every encryption,
key versioning, and associated data binding it to the connection row. A server-secret HMAC is not encryption. Prefer an
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
Rate-limit per owner, audit token use without logging secrets, and return
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
