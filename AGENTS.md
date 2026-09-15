# Agent guidance for integration-proxy

## This repository is platform-agnostic

`integration-proxy` is generic OAuth/catalog plumbing. It knows how to load a
catalog, compose an OpenAPI document from a pinned OAD plus pinned
[Overlay Specification](https://spec.openapis.org/overlay/latest.html)
documents, run the OAuth code/PKCE flows the composed document describes, and
allowlist proxy requests against it. It must never know the name, shape, or
business rules of any specific third-party API.

**No platform-specific code, names, magic numbers, or fixtures belong in this
repository.** That includes, but is not limited to:

- Hard-coding a platform name (`"moneybird"`, `"google-calendar"`, ...) in
  `src/` outside of already-generic config plumbing (e.g. deriving an env var
  name from whatever name the catalog happens to contain).
- Asserting platform-specific facts in tests — expected collection counts,
  scope lists, throttling limits, schema fields, endpoint paths. If a test
  needs to say "Moneybird has 32 read collections" or "the Calendar event
  schema has a `recurrence` field", that assertion belongs in the
  `localthought/overlays` repository, not here.
- Response schema fixes, missing fields, pagination quirks, or throttling
  metadata for a specific API. These are OpenAPI/Overlay documents, and they
  are published and pinned in `localthought/overlays`.

If you find yourself wanting to add any of the above to this repo, stop — the
right place for it is an OpenAPI document or Overlay Specification document in
`localthought/overlays`, referenced from `catalog.json` there. See the
[Catalog section of the README](README.md#catalog) for how sources are pinned
and composed. `localthought/overlays` has its own validation scripts (e.g.
`scripts/validate_moneybird_metadata.rb`) for exactly this kind of
per-platform assertion — extend those instead of teaching this repo about a
platform.

### Why this separation matters

This proxy serves many unrelated third-party APIs through one generic
composition pipeline. If platform knowledge leaks into `src/` or its tests,
every future platform addition or fix requires touching and re-reviewing
generic, security-sensitive code (OAuth flows, credential handling, request
allowlisting) instead of only publishing a new pinned overlay revision. It
also means this repo's test suite silently breaks whenever an upstream API
changes shape, even though nothing about the proxy's own behavior changed.

Background: [PR #46](https://github.com/localthought/integration-proxy/pull/46)
added an `#[ignore]`d test asserting Moneybird-specific numbers (collection
counts, OAuth scope counts, throttling limits) directly in `src/catalog.rs`.
It was reverted in
[PR #70](https://github.com/localthought/integration-proxy/pull/70) because
all of that content was already correctly published as OpenAPI Overlay
documents in `localthought/overlays` and validated there — duplicating it
here only added a platform-specific liability to generic code.

### What generic code may do

- Load and compose *any* catalog entry the same way, regardless of platform.
- Validate the *shape* of a catalog entry generically (e.g. "every OAuth
  provider has at least one scope", "every selection's `query_overrides` path
  exists in the composed document") without asserting platform-specific
  values.
- Reference a pinned `localthought/overlays` catalog URL as the default
  `CATALOG_PATH` (`src/config.rs`) — that's an opaque pointer, not platform
  knowledge.

### What belongs in `localthought/overlays` instead

- OpenAPI Overlay documents that add, fix, or complete response schemas
  (missing fields, corrected types).
- Overlay documents that describe CRUD/collection structure, pagination
  schemes, auth requirements, or throttling limits for a specific API.
- Consumer `selection` objects (query overrides, OAuth security scheme
  choice, trusted tenant-identity operation) for a specific catalog entry.
- Platform-specific validation scripts and fixtures.

## Making a platform-specific fix

1. Make the change as an OpenAPI document or Overlay Specification document
   in `localthought/overlays`, with its own validation there.
2. Publish and verify the immutable pins, then commit the updated root
   `catalog.json` in `localthought/overlays`.
3. Bump the pinned `CATALOG_PATH` default in this repo's `src/config.rs` to
   the new immutable revision (a one-line, platform-agnostic change) and
   restart the service.

Do not add a step that teaches this repo what the platform's API looks like.
