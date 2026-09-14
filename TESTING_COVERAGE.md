# Test coverage

## Authenticated API tenant identity

| Behavior | Cheapest meaningful coverage |
| --- | --- |
| Catalog trust selection, namespace match, authenticated operation, stable non-reassigned ID, supported fixed HTTPS GET | `src/identity_policy_tests.rs`, `src/identity.rs`, `src/catalog.rs` |
| Provider/client namespace separation and string versus integer subjects | `src/identity_policy_tests.rs` |
| Explicit legacy subject mapping and unchanged tenant-secret derivation | `src/identity_policy_tests.rs`, `src/identity_catalog_tests.rs` |
| Real composed Google Offline and GitHub metadata, operation-only login scopes and integration scopes | `src/identity_catalog_tests.rs`, `src/catalog.rs`; pinned fixture provenance in `tests/identity-catalog/sources.json` |
| Anonymous connection: one OAuth exchange, identity resolution, session, PKCE redemption | PostgreSQL router tests in `src/connect.rs` |
| Existing tenant retention with no identity lookup; resolved bootstrap revocation before session/handoff | PostgreSQL mock-provider tests in `src/connect.rs` |
| Callback state consumption and browser/session binding before token exchange | PostgreSQL router tests in `src/connect.rs`, `src/api_login_flow_tests.rs` |
| Standalone API sign-in: identity scopes, PKCE, session, token disposal, no connection credential | PostgreSQL router tests in `src/api_login_flow_tests.rs` |
| Cancellation during pending connection returns to validated hub with generic error | PostgreSQL router tests in `src/api_login_flow_tests.rs` |
| Consent disclosure, escaping, provider choices and profiles without email | `src/templates.rs` |
| Legacy namespace configuration rejects unsafe URLs | `src/config.rs` |

Run `cargo test` for local tests. Database tests are marked ignored so ordinary
runs do not require PostgreSQL; CI sets `TEST_DATABASE_URL` and fixture OAuth
credentials and runs `cargo test -- --include-ignored`. See README for the
isolated database command and required environment.

## Limits

Mock-provider router tests exercise the real state, cookie, token request and
handoff paths. They do not prove live Google/GitHub registration, provider
consent behavior or a deployed hub import. Those require matching deployed
proxy/catalog revisions and a real account. Fixture validation establishes the
contents of immutable dependencies; availability of newly published raw URLs
must also be checked before rollout. No browser UI automation was added for
this proxy-only change.
