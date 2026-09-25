"""Validate full catalog-pinned compositions, without task-local base files."""
import json
import tempfile
import unittest
from pathlib import Path
import yaml
from generate_identity_catalog_fixtures import PAGES_BASE, ROOT, apply, compose, fetch, platform_config


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

    def test_github_repository_picker_and_label_operations(self):
        # The issue-tracker drive app (ontola/atomic-plugins#147): the
        # repository picker's read and the two `atomic:doing` label writes.
        document = self.composed("github-issues")
        paths = document["paths"]
        repos = paths["/user/repos"]
        self.assertEqual(set(repos), {"get"})
        read = repos["get"]
        self.assertEqual(read["operationId"], "repos-list-for-authenticated-user")
        self.assertEqual(read["security"], [{"githubOAuth": ["repo"]}])
        # GitHub pages it with the Link header, like the issue lists.
        self.assertEqual(read["x-pagination"], [{"scheme": "nextLink"}])
        self.assertEqual(
            document["components"]["paginationSchemes"]["nextLink"]["response"]["headers"]["Link"]["role"],
            "nextLink",
        )
        query = {p["name"]: p for p in read["parameters"] if p["in"] == "query"}
        self.assertEqual(set(query), {"per_page", "page", "sort", "direction"})
        self.assertFalse(any(p.get("required") for p in query.values()))
        self.assertIn("updated", query["sort"]["schema"]["enum"])
        self.assertNotIn("requestBody", read)
        self.assertNotIn("x-crud", read)
        self.assertIn("full_name", document["components"]["schemas"]["repository"]["required"])
        # A read, not a collection Reflector would sync.
        self.assertEqual(set(document["components"]["crudResources"]), {"issue", "issueComment"})

        labels = paths["/repos/{owner}/{repo}/issues/{issue_number}/labels"]
        label = paths["/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}"]
        self.assertEqual(set(labels), {"post"})
        self.assertEqual(set(label), {"delete"})
        add, remove = labels["post"], label["delete"]
        for operation in (add, remove):
            self.assertEqual(operation["security"], [{"githubOAuth": ["repo"]}])
            self.assertEqual(operation["x-crud"]["action"], "update")
            self.assertEqual(operation["x-crud"]["resource"], "issue")
        body = add["requestBody"]
        self.assertTrue(body["required"])
        self.assertEqual(
            body["content"]["application/json"]["schema"]["properties"]["labels"]["items"],
            {"type": "string"},
        )
        self.assertNotIn("requestBody", remove)
        # The OAuth app still asks for one scope, `repo`, which covers issue
        # labels and private repositories.
        scopes = set()
        for item in paths.values():
            for operation in item.values():
                for requirement in operation.get("security", []):
                    scopes.update(requirement.get("githubOAuth", []))
        self.assertEqual(scopes, {"repo"})

    def test_pets_demo_needs_no_credential_and_serves_its_schema(self):
        # Published whole from this folder: the OAD and the static API it
        # describes (GitHub Pages serves both). compose() validates the OAD.
        config = platform_config("pets")
        self.assertEqual(config["openapi"], PAGES_BASE + "pets-demo/1.0.0/openapi.json")
        self.assertEqual(config["overlays"], [])
        self.assertNotIn("selection", config)
        document = self.composed("pets")
        # The integration proxy's no-credential kind: an explicit empty
        # top-level requirement and no scheme anywhere.
        self.assertEqual(document["security"], [])
        self.assertNotIn("securitySchemes", document.get("components", {}))
        server = document["servers"][0]["url"]
        self.assertEqual(server, PAGES_BASE + "pets-demo/1.0.0/api")
        # Read-only: one collection, GET only.
        self.assertEqual(set(document["paths"]), {"/pets"})
        self.assertEqual(set(document["paths"]["/pets"]), {"get"})
        # What Pages serves at server + /pets matches the Pet schema.
        pets = json.loads((ROOT / server[len(PAGES_BASE):] / "pets").read_text())
        schema = document["components"]["schemas"]["Pet"]
        types = {"integer": int, "string": str, "boolean": bool, "number": (int, float)}
        self.assertEqual(len(pets), 5)
        self.assertEqual(len({pet["id"] for pet in pets}), 5)
        for pet in pets:
            self.assertEqual(set(pet), set(schema["properties"]))
            for field in schema["required"]:
                self.assertIn(field, pet)
            for field, value in pet.items():
                expected = types[schema["properties"][field]["type"]]
                self.assertIsInstance(value, expected, field)
                if expected is int:
                    self.assertNotIsInstance(value, bool, field)
        # The Pets drive app bundles the same document.
        app = json.loads((ROOT.parent / "integrations/pets/app/openapi.json").read_text())
        self.assertEqual(app, document)


if __name__ == "__main__":
    unittest.main()
