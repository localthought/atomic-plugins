# Changelog

Releases of the `atomic-integration-proxy` crate. Earlier releases are
described in the README ("Deploying 0.2", and the "0.2.1 and later" notes).

## 0.2.2 (unreleased)

- A catalog platform whose composed OpenAPI document declares top-level
  `security: []`, no security scheme, and no operation that requires one now
  connects without a credential. The consent page asks for nothing, the
  connection seals only the platform name, and requests are forwarded with no
  `Authorization` or key. Signatures, frame capabilities, owner and delegation
  checks, the access policy and the catalog allowlist apply as before. A
  document with no `security` at all is still refused, so a platform whose
  auth overlay is missing is never connected without credentials. If the
  catalog later gives such a platform a scheme, its existing connections
  answer `401 credential_refresh_failed` (connect again).
  (ontola/atomic-plugins#174)
- The default catalog (`overlays/catalog.json`) gains `pets`, a static,
  read-only demo API on GitHub Pages that uses this. 0.2.1 loads that catalog
  and lists `pets`, but its consent page answers "This platform is not
  available for connection".
- `CHANGELOG.md` is packaged with the crate.
