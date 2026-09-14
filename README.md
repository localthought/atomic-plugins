# overlays
OpenAPI Overlay files that complete existing OpenAPI files with Pagination Schemes and other additions

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

Validate the full catalog-pinned compositions with
`python tests/test_identity_overlays.py` after installing
`requirements-identity-tests.txt`. Generate proxy regression fixtures with
`python tests/generate_identity_catalog_fixtures.py --output <fixture-directory>`;
the generated `sources.json` records the source URLs and content hashes.
