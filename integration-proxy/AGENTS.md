# Agent guidance for integration-proxy

## This repository is platform-agnostic

`integration-proxy` is generic OAuth/catalog plumbing. It knows how to load a
catalog, compose an OpenAPI document from a pinned OAD plus pinned
[Overlay Specification](https://spec.openapis.org/overlay/latest.html)
documents, run the OAuth code/PKCE flows the composed document describes, and
allowlist proxy requests against it. Its *runtime behavior* must never depend
on the name, shape, or business rules of any specific third-party API.

**No platform-specific behavior, branching, or hand-authored data belongs in
this repository's production code.** That includes:

- Hard-coding a platform name (`"moneybird"`, `"google-calendar"`, ...) to
  drive a code path in `src/`, outside of already-generic config plumbing
  (e.g. deriving an env var name from whatever name the catalog happens to
  contain).
- Hand-writing response schema fixes, missing fields, CRUD/collection
  structure, pagination quirks, or throttling metadata for a specific API
  inline in this crate. These are OpenAPI/Overlay documents, and they are
  authored and published in [`../overlays/`](../overlays/) (migrated from
  `localthought/overlays`).
- Consumer `selection` objects (query overrides, OAuth security scheme
  choice, trusted tenant-identity operation) for a specific catalog entry —
  those are also authored in `../overlays/catalog.json`.

If you find yourself wanting to add any of the above, stop — the right place
is an OpenAPI document or Overlay Specification document in `../overlays/`,
referenced from `catalog.json` there. See the
[Catalog section of the README](README.md#catalog) for how sources are
published and composed. `../overlays/` has its own validation scripts (e.g.
`scripts/validate_moneybird_metadata.rb`) for authoring correctness — extend
those instead of teaching this crate how to author a platform's data.

### Tests that use pinned platform fixtures are fine

The rule above is about *authoring* platform data and *branching on* platform
identity in runtime code — not about testing. A test — especially an
`#[ignore]`d one gated behind a real network fetch — that loads a real catalog
(the checked-in `../overlays/catalog.json` via `Catalog::load_checked_in`, or
a pinned historical `localthought/overlays` revision) and asserts facts about the
*composed result* (e.g. "the composed Moneybird document has N collections",
"every provider has non-empty OAuth scopes") is the correct way to prove the
generic load-and-compose pipeline actually produces the right document for
real inputs. This repo already does this: `src/identity_catalog_tests.rs` and
the pinned-catalog test in `src/catalog.rs` both load real composed
Google/GitHub/Moneybird data, with fixture provenance recorded in
`tests/identity-catalog/sources.json`. That's a different, complementary
layer from `../overlays/`' own authoring-time validation — this
repo's version proves the *proxy* composes real pins correctly at runtime,
not just that the overlay documents are internally well-formed.

The line: a test may *read and assert against* pinned platform data. Runtime
`src/` code may never *contain or branch on* it.

### What generic code may do

- Load and compose *any* catalog entry the same way, regardless of platform.
- Validate the *shape* of a catalog entry generically (e.g. "every OAuth
  provider has at least one scope") without depending on which platform it
  came from.
- Reference the GitHub Pages URL of `../overlays/catalog.json` as the
  default `CATALOG_PATH` (`src/config.rs`) — that's an opaque pointer, not
  platform knowledge.
- Assert platform-specific facts about a pinned fixture in a test, to prove
  the composition pipeline works end-to-end (see above).

### What belongs in `../overlays/` instead

- OpenAPI Overlay documents that add, fix, or complete response schemas,
  CRUD/collection structure, pagination schemes, auth requirements, or
  throttling limits for a specific API.
- Consumer `selection` objects for a specific catalog entry.
- Platform-specific validation scripts and fixtures for authoring correctness.

## Making a platform-specific fix

1. Make the change as an OpenAPI document or Overlay Specification document
   in `../overlays/`, with its own validation there, and update
   `../overlays/catalog.json` in the same PR if the platform's list of
   overlays changes.
2. `Overlays CI` and this crate's `default_catalog_*` tests validate the
   checked-in catalog before merge. Optionally add or extend a test here that
   asserts the newly composed document looks right — that's welcome.
3. After merge, `Overlays published` confirms GitHub Pages serves it; then
   restart the service. `src/config.rs`'s `DEFAULT_CATALOG_PATH` does not
   change.

Do not add a step that teaches this repo how to author the platform's data,
and do not make runtime `src/` code behave differently for one platform.

## Background

[PR #46](https://github.com/localthought/integration-proxy/pull/46) added an
`#[ignore]`d test asserting Moneybird-specific facts (collection counts,
throttling limits) about a pinned real catalog fixture in `src/catalog.rs`.
It was briefly reverted in
[PR #70](https://github.com/localthought/integration-proxy/pull/70) on
concern that this was Moneybird-specific code leaking into the generic proxy.
On inspection, it wasn't: the underlying data was authored correctly as
Overlay documents in `localthought/overlays`, and the test followed the same
pinned-fixture pattern already used elsewhere in this repo (see above) — it
just proved the proxy composes those pins correctly. PR #70 was closed as a
false alarm; this file exists so the actual boundary is written down instead
of re-litigated next time.
