# Test coverage

## Agent-signed connections (issue #54)

| Behavior | Coverage |
| --- | --- |
| Agent ids: `atomic:agent:` and `did:ad:agent:`, both base64 alphabets, padding, one canonical output; non-agent ids, malformed and weak keys refused | `src/agent_id.rs` |
| v2 message layout and body hash; signed URL from `BASE_URL`, not `Host` | `src/signature.rs`; `proxy::postgres_each_verification_step_fails_closed` (spoofed `Host`, signature over the internal URL) |
| Each v2 check: missing headers, version 1/other/absent, agent vs public key, invalid agent, ±5 min skew both ways, malformed timestamps, tampered method/URL/origin/scheme/body, a genuine v1 signature | `src/signature.rs`, `proxy::postgres_each_verification_step_fails_closed` |
| Single use: replayed proxy, frame and management requests | `proxy::postgres_the_owner_signs_requests_that_reach_the_provider_once_each`, `proxy::postgres_a_frame_capability_works_only_with_the_frame_key_and_a_live_delegation`, `connections::postgres_a_management_signature_cannot_be_replayed_with_a_different_body`, `security::nonces_are_single_use` |
| Capability v2: owner signature, domain separation, `aud`, expiry, 15-minute cap, connection/platform scope, delegation, `cnf` binding, copied capability without the frame key, owner key in place of frame key, #72's v1 bearer shape, malformed/unknown fields | `src/capability.rs`, `proxy::postgres_capability_misuse_is_refused_with_a_specific_reason`, `proxy::postgres_a_frame_capability_works_only_with_the_frame_key_and_a_live_delegation` |
| Standing: owner, delegate, runtime of a delegated app; revocation of a delegation or runtime effective on the next request; connection deletion | `security::standing_follows_delegations_and_runtimes_immediately`, `proxy::postgres_delegates_and_runtimes_lose_access_the_moment_they_are_revoked` |
| Access policy asked about the owner on every request, delegates judged as their owner; redeem refused for a denied owner before the handoff is spent | `proxy::postgres_the_access_policy_is_asked_about_the_owner_on_every_request`, `connect::postgres_redeem_canonicalizes_a_legacy_signer_and_refuses_unsigned_or_denied`, `src/access.rs` |
| Management: only the owner delegates, deletes, lists; delegates cannot re-delegate; canonical ids in and out; label and body validation; runtimes; no credentials in listings | `connections::postgres_only_the_owner_manages_a_connection` |
| Connection rows: AAD bound to the row, 90-day idle expiry and sweep with delegations, refresh lease | `security::a_connection_row_is_bound_to_its_id_and_expires_after_90_idle_days`, `security::only_one_caller_holds_the_refresh_lease`, `proxy::postgres_concurrent_requests_refresh_an_expired_token_once` |
| Connect: no login, return-address rules incl. `atomic://`, PKCE, CSRF/origin, single-use consent, browser-bound callback, cancellation, API-key sealing, signed redeem makes the signer owner, legacy signer canonicalized, concurrent redemption, expired handoff | `src/connect.rs` (unit and PostgreSQL tests) |
| Whole flow: consent, OAuth callback with a mocked token endpoint, signed redeem, proxied call, delegation, delegated call | `connect::postgres_oauth_connect_redeem_delegate_and_proxy_end_to_end` |
| Tenant routes and parameters removed (`/session`, `/auth/*`, `POST /connect`, `/proxy`, `/oauth/{p}/start`, signed legacy `/connect`), `Bearer` codes refused | `connect::removed_tenant_routes_are_gone`, `connect::legacy_connect_parameters_are_refused`, `proxy::postgres_each_verification_step_fails_closed` |
| CORS for a null-origin frame: preflight of `authorization` and the five `x-atomic-*` headers; exposed headers | `browser_tests::a_null_origin_frame_may_preflight_signed_proxy_requests` |
| Composed catalog fixtures still yield the OAuth provider and scopes; leftover `tenantIdentity` selections are ignored | `src/identity_catalog_tests.rs` |

Run `cargo test` for local tests. Database tests are marked ignored so ordinary
runs do not require PostgreSQL; CI sets `TEST_DATABASE_URL` and fixture OAuth
credentials and runs `cargo test -- --include-ignored`. See README for the
isolated database command and required environment.

## Limits

Mock-provider router tests exercise the real state, cookie, token request,
handoff, signature and delegation paths. They do not prove live provider
registration or consent behavior, and no real Atomic client (browser
`@tomic/lib`, a plugin frame's WebCrypto key, or a node's app agent) has
signed against this proxy yet: signatures in tests come from
`ed25519-dalek` with the same message layout. Cross-implementation test
vectors (atomic-server `lib/src/authentication_v2_vectors.json`) are not yet
checked here.
