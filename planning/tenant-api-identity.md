# Tenant identity from authenticated APIs

Task: 01a09f59-3029-7960-bf56-2f2f573956c1
Worktree: /private/tmp/tenant-identity-task/integration-proxy
Branch: codex/tenant-api-identity
Base: origin/main 2071c79b126987d87a0c584db7cebb2668edf435 (integration-proxy uses main; Atomic develop is not the target).
Original checkout: /Users/michieldejong/gh/localthought/integration-proxy, clean baseline saved outside repository.

## Contract and acceptance criteria

- [x] Astra architecture review: operation-level x-authenticated-principal describes current caller identity, ordinary OAuth security supplies scopes; catalog selection grants trust.
- [x] Terra implements generic parser/resolver and combined anonymous /connect flow; no platform-specific runtime branches.
- [x] Namespaced stable subjects, client-scoped IDs where declared, explicit operator legacy mapping preserves existing bare-sub tenants; emails never identify or link tenants.
- [x] Existing-session connections preserve their tenant. Bootstrap callbacks reject changed sessions and retain browser binding, one-use state/consent, PKCE and revocation protections.
- [x] Specification and schema/examples describe capability rather than proxy policy; pinned-dependency validation passes.
- [x] Calendar and a non-OIDC API metadata demonstrate provider-neutral capability with immutable dependency pins.
- [x] Public docs and meaningful parser plus mock-OAuth/DB integration tests.
- [x] Review complete diff; fmt, clippy, build and tests including PostgreSQL regressions.
- [ ] Publish feature PRs and follow exact-commit checks. No merge/deploy authorization given.
- [ ] Remove completed plan after required checks and verify final commit checks.

## Ownership

Coordinator: isolation, plan, catalog metadata, dependency pins, cross-repository integration, PRs and CI.
Terra runtime agent: integration-proxy src and tests plus runtime docs; no git publication.
Terra specification agent: openapi-extensions spec/authenticated-principal and README only.

## Boundaries

Only trusted catalog identity sources may authenticate; declaration alone grants no authority. Fixed HTTPS GET with no redirects initially; fail closed on unsupported metadata. Identity is versioned tuple namespace/scope/client-if-needed/subject. Existing login fallback remains for platforms without identity. Cross-provider alias linking requires a separate explicit proof-of-control flow and is outside this first implementation; adding connections never links identities implicitly.

## Review and validation notes

- Reviewed current Atomic client: integrations/localthought/browser.ts uses the selected-platform /connect and PKCE redemption protocol already; no Atomic frontend code change is needed for the proxy flow.
- Spec draft lives in /private/tmp/tenant-identity-task/openapi-extensions, branch codex/authenticated-principal. Schema/examples passed initial validation. Lifecycle guarantees omitted mean unknown, not false.
- Metadata work lives in /private/tmp/tenant-identity-task/overlays, branch codex/tenant-api-identity. Google discovery verified UserInfo endpoint and public-subject issuer; GitHub official OAuth app best practices guarantee durable, non-reassigned numeric user id.
- Isolated PostgreSQL: task-owned Docker container tenant-api-identity-postgres on 127.0.0.1:15439, database connect_test. Parent owns cleanup.
- User explicitly approved publication. Design issue #21 and PR #22 in pondersource/openapi-extensions, overlays PR #154 and integration-proxy PR #69 are open.

- Full composed Google Offline and GitHub catalog fixtures now pass the actual proxy parser tests (2 tests), with exact upstream source URLs and content hashes. These replace the earlier insufficient hand-reduced projections.

## Published immutable dependencies

- Extension proposal: pondersource/openapi-extensions codex/authenticated-principal, fea4f0a (initial schema/examples commit 4362e6c).
- Identity overlays: localthought/overlays ee929c625d3c63dea87bcccae932a98a33138a8f.
- Catalog selection: localthought/overlays 8f29d9973267b6b3877aa27a5ab50cd41b010e6c; proxy default updated to this pin.
- Final full fixtures regenerated from the exact local identity-overlay commit blobs cached under their eventual immutable URLs, plus already-published pinned dependencies. This is local pre-publication validation, not evidence that the new remote URLs resolve.
- Publish overlays branch before proxy PR/CI; then verify raw URLs and load the actual remote catalog through the proxy. Fresh downloads now reproduce the committed fixtures exactly; the real proxy Catalog::load regression passes for this published revision.

## Final local review

- Astra reviewed scope choice, cancellation, callback ordering, session binding, network limits and legacy compatibility; no remaining actionable finding.
- Final runtime suite: 102 passed, 0 failed, 0 ignored with TEST_DATABASE_URL and fixture OAuth credentials using cargo test -- --include-ignored. Formatting, Clippy --all-targets --all-features with warnings denied, build --all-targets and diff checks pass. Standalone cancellation test seeds actual encrypted consent before checking cleanup.
- Added TESTING_COVERAGE.md mapping acceptance criteria to test layers and explicitly recording live-provider/deployment gaps.
- Overlay generator corrected in 07c9138 to compose only catalog-pinned URLs, avoiding a local overlay override that could mask future pin drift. Default catalog pin remains 8f29d997.
- Both original checkouts remain clean, matching saved baselines.

- Final schema suite: 3 passed. Both overlay composition tests pass with the exact-commit source cache; new remote URLs and CI remain unverified until approved publication.

- Specification and overlays CI passed for fea4f0a and 07c9138. Implementation CI pending; added a published-catalog loader regression after remote availability was established.
