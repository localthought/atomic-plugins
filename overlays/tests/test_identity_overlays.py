"""Validate full catalog-pinned compositions, without task-local base files."""
import tempfile
import unittest
from pathlib import Path
from generate_identity_catalog_fixtures import compose


class IdentityOverlayTests(unittest.TestCase):
    def composed(self, name):
        with tempfile.TemporaryDirectory() as cache:
            return compose(name, Path(cache))[0]

    def test_google_auth_and_identity_overlay(self):
        document = self.composed("google-calendar")
        operation = document["paths"]["/v1/userinfo"]["get"]
        self.assertEqual(operation["operationId"], "getGoogleAuthenticatedPrincipal")
        self.assertEqual(operation["x-authenticated-principal"]["subject"], "$response.body#/sub")
        for scheme in ("googleOnline", "googleOffline"):
            scopes = document["components"]["securitySchemes"][scheme]["flows"]["authorizationCode"]["scopes"]
            self.assertTrue({"openid", "email", "profile"} <= set(scopes))

    def test_github_auth_and_identity_overlay(self):
        document = self.composed("github-issues")
        operation = document["paths"]["/user"]["get"]
        self.assertEqual(operation["operationId"], "getGitHubAuthenticatedPrincipal")
        self.assertEqual(operation["x-authenticated-principal"]["subject"], "$response.body#/id")
        self.assertEqual(operation["security"], [{"githubOAuth": []}])


if __name__ == "__main__":
    unittest.main()
