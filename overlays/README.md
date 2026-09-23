# overlays
OpenAPI Overlay files that complete existing OpenAPI files with Pagination Schemes and other additions

## Where this lives and how it is published

This folder was migrated from the standalone `localthought/overlays`
repository (full history via `git subtree`, from its `main` plus its
`calendar-events-write-back-prod` branch, which the integration proxy's
production catalog pinned). Author new overlays here, not there.

GitHub Pages publishes this repository's `main` from its root (legacy
build; the root `.nojekyll` makes it serve every file byte-for-byte), so
any file `overlays/<path>` is served at:

```
https://ontola.github.io/atomic-plugins/overlays/<path>
```

`catalog.json` lists each platform's overlays by those URLs, and the
integration proxy's default `CATALOG_PATH` is
`https://ontola.github.io/atomic-plugins/overlays/catalog.json`. Before this
migration every overlay URL was pinned to a `localthought/overlays` commit
on `raw.githubusercontent.com`; the Pages URLs are not pinned, so a merge
to `main` changes what the proxy composes at its next start. The OAD
(`openapi`) URLs are still pinned to an `openapi-directory` commit
(`localthought/`, or `ontola/` for Google Calendar).

Overlays are applied in the order `catalog.json` lists them, and an action
whose target does not exist yet fails the whole catalog load. Clockify's
`crud-causality-overlay.yaml` is listed first because it defines the
projects/users paths its auth and pagination overlays target.

Checks:

- `.github/workflows/overlays-ci.yml` (PRs): every catalog overlay URL maps
  to a file in this folder, and the identity tests below pass. It reads the
  Pages-published sources from the checkout, so it validates a change before
  Pages serves it.
- `integration-proxy`'s `default_catalog_*` tests (PRs touching this folder):
  compose this `catalog.json` with the proxy's runtime loader, reading
  overlays from this folder.
- `.github/workflows/overlays-published.yml` (after each Pages build): the
  served `catalog.json` and every overlay it lists match the built commit.

## Authenticated principal overlays

The Google Calendar and GitHub Issues identity overlays add a current-principal
operation without making it a collection or assigning CRUD metadata. The
catalog is the trusted identity selection and associates it with its ordinary
OAuth scheme. Google uses either `googleOnline` or `googleOffline`; GitHub
uses `githubOAuth`. Before rollout, an operator upgrading an existing
Google-login deployment explicitly sets
`APP_AUTH_IDENTITY_NAMESPACE=https://accounts.google.com` to retain the prior
tenant mapping. This is operator-only configuration; there is no default and
callers cannot choose an identity namespace.

For example, the Google Calendar catalog entry selects:

```json
{
  "oauthSecurityScheme": "googleOffline",
  "tenantIdentity": {
    "operationId": "getGoogleAuthenticatedPrincipal",
    "namespace": "https://accounts.google.com"
  }
}
```

GitHub uses `githubOAuth`, `getGitHubAuthenticatedPrincipal`, and
`https://github.com`. Merely adding the extension to an OpenAPI document does
not enable tenant login; the trusted catalog must select the operation.

Google's overlay is applied after its auth overlay because it adds `openid`,
`email`, and `profile` to both `googleOnline` and `googleOffline`. GitHub's
overlay is also applied after `auth-overlay.yaml`, which declares `githubOAuth`.
The overlays only describe the provider endpoints and response metadata; the
runtime supplies its normal User-Agent header and bearer token.

The Google declaration follows its [OpenID Connect discovery and UserInfo
reference](https://developers.google.com/identity/openid-connect/reference).
The GitHub declaration follows the [authenticated-user endpoint](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
and GitHub's [durable numeric-ID guidance](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app).

Validate the full catalog compositions, from this folder, with
`python tests/test_identity_overlays.py` after installing
`requirements-identity-tests.txt`. Generate proxy regression fixtures with
`python tests/generate_identity_catalog_fixtures.py --output <fixture-directory>`;
the generated `sources.json` records the source URLs and content hashes.
Both read overlays under the Pages URL from this checkout and download only
the pinned OADs.
