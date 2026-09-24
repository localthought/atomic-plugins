"""Validate full catalog-pinned compositions, without task-local base files."""
import tempfile
import unittest
from pathlib import Path
import yaml
from generate_identity_catalog_fixtures import apply, compose, fetch, platform_config


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

    def test_google_calendar_event_patch_overlay(self):
        document = self.composed("google-calendar")
        operation = document["paths"]["/calendars/{calendarId}/events/{eventId}"]["patch"]
        self.assertEqual(operation["operationId"], "calendar.events.patch")
        self.assertEqual(operation["x-crud"], {"action": "update", "resource": "event"})
        for scheme in ("googleOnline", "googleOffline"):
            self.assertIn(
                {scheme: ["https://www.googleapis.com/auth/calendar.events"]},
                operation["security"],
            )
        self.assertIn("application/json", operation["requestBody"]["content"])
        self.assertEqual(
            operation["requestBody"]["content"]["application/json"]["schema"],
            {"$ref": "#/components/schemas/Event"},
        )
        self.assertIn("412", operation["responses"])
        self.assertIn("etag", document["components"]["schemas"]["Event"]["properties"])

    def test_clockify_time_entry_write_overlay(self):
        # compose() also validates the composed document as OpenAPI 3.
        document = self.composed("clockify")
        paths = document["paths"]
        item = "/v1/workspaces/{workspaceId}/time-entries/{id}"
        # Reading one entry by id comes from the base document, unchanged.
        self.assertEqual(paths[item]["get"]["operationId"], "get-time-entry")
        self.assertEqual(paths[item]["get"]["x-crud"], {"action": "read", "resource": "timeEntry"})
        create = paths["/v1/workspaces/{workspaceId}/time-entries"]["post"]
        update = paths[item]["put"]
        delete = paths[item]["delete"]
        self.assertEqual(create["x-crud"]["action"], "create")
        self.assertEqual(update["x-crud"], {"action": "update", "mode": "replace", "resource": "timeEntry"})
        self.assertEqual(delete["x-crud"], {"action": "delete", "resource": "timeEntry"})
        for operation in (create, update, delete):
            self.assertEqual(operation["security"], [{"clockifyApiKey": []}])
        # The proxy only forwards a body to an operation with a requestBody
        # for that media type (integration-proxy catalog.rs validate_request).
        for operation in (create, update):
            self.assertEqual(
                operation["requestBody"]["content"]["application/json"]["schema"],
                {"$ref": "#/components/schemas/TimeEntryWriteRequest"},
            )
        self.assertNotIn("requestBody", delete)
        self.assertEqual(document["components"]["schemas"]["TimeEntryWriteRequest"]["required"], ["start"])
        # Still no write on the list path, and no PATCH anywhere.
        self.assertEqual(set(paths["/v1/workspaces/{workspaceId}/user/{userId}/time-entries"]), {"get"})
        self.assertEqual(set(paths[item]), {"get", "put", "delete"})

    def test_clockify_setup_reads_are_read_overlay_operations(self):
        # The timesheets app's setup reads the key's user and its workspaces.
        document = self.composed("clockify")
        for path, operation_id in (
            ("/v1/user", "getClockifyCurrentUser"),
            ("/v1/workspaces", "listClockifyWorkspaces"),
        ):
            self.assertEqual(set(document["paths"][path]), {"get"})
            operation = document["paths"][path]["get"]
            self.assertEqual(operation["operationId"], operation_id)
            self.assertEqual(operation["security"], [{"clockifyApiKey": []}])
            self.assertNotIn("requestBody", operation)
        # They come from the read overlays: composing without the write
        # overlay's catalog line keeps them, and has no write operation.
        config = platform_config("clockify")
        read_overlays = [u for u in config["overlays"] if not u.endswith("/time-entry-write-overlay.yaml")]
        self.assertEqual(len(read_overlays), len(config["overlays"]) - 1)
        with tempfile.TemporaryDirectory() as cache:
            base, _ = fetch(config["openapi"], Path(cache))
            read_only = yaml.safe_load(base)
            for url in read_overlays:
                apply(read_only, yaml.safe_load(fetch(url, Path(cache))[0]))
        self.assertIn("get", read_only["paths"]["/v1/user"])
        self.assertIn("get", read_only["paths"]["/v1/workspaces"])
        methods = {m for item in read_only["paths"].values() for m in item}
        self.assertEqual(methods, {"get"})

    def test_github_auth_and_identity_overlay(self):
        document = self.composed("github-issues")
        operation = document["paths"]["/user"]["get"]
        self.assertEqual(operation["operationId"], "getGitHubAuthenticatedPrincipal")
        self.assertEqual(operation["x-authenticated-principal"]["subject"], "$response.body#/id")
        self.assertEqual(operation["security"], [{"githubOAuth": []}])


if __name__ == "__main__":
    unittest.main()
