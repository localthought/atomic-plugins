//! Composed-catalog fixtures (provenance in `tests/identity-catalog/sources.json`).
//!
//! These fixtures were pinned for the tenant-identity login that issue #54
//! removed. The identity operations they declare are no longer read; the
//! tests below keep asserting what the proxy still takes from them: the OAuth
//! provider and its scopes, composed from the real pinned sources.
use serde_json::json;

use crate::catalog::Catalog;

fn catalog(platform: &str, source: &str, selection: serde_json::Value) -> Catalog {
    Catalog::from_test_document(platform, serde_yaml::from_str(source).unwrap(), selection)
}

#[test]
fn composed_google_calendar_keeps_its_data_scopes() {
    let catalog = catalog(
        "google-calendar",
        include_str!("../tests/identity-catalog/google-calendar-composed.yaml"),
        // A leftover `tenantIdentity` selection is ignored, not an error.
        json!({
            "oauthSecurityScheme": "googleOffline",
            "tenantIdentity": {"operationId": "getGoogleAuthenticatedPrincipal", "namespace": "https://accounts.google.com"}
        }),
    );
    let provider = catalog.oauth_provider("google-calendar").unwrap();
    assert_eq!(
        provider.scopes,
        vec![
            "email",
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            "https://www.googleapis.com/auth/calendar.events",
            "openid",
            "profile"
        ]
    );
}

/// The calls atomic-plugins' Calendar drive app (integrations/calendar/app/)
/// makes through the host relay, exactly as it makes them, against the same
/// checked-in composed document. `If-Match` itself is not a catalog question:
/// `upstream_request` forwards it for every allowed operation.
#[test]
fn composed_google_calendar_permits_the_calendar_app_operations() {
    let catalog = catalog(
        "google-calendar",
        include_str!("../tests/identity-catalog/google-calendar-composed.yaml"),
        json!({"oauthSecurityScheme": "googleOffline"}),
    );
    let events = "/calendar/v3/calendars/synthetic%40example.com/events";
    let allowed = [
        (
            "GET",
            "/calendar/v3/users/me/calendarList".to_string(),
            "maxResults=250&pageToken=next",
            false,
        ),
        (
            "GET",
            events.to_string(),
            "singleEvents=false&showDeleted=true&maxResults=250&pageToken=next",
            false,
        ),
        ("GET", format!("{events}/timed"), "", false),
        ("PATCH", format!("{events}/timed"), "sendUpdates=all", true),
    ];
    for (method, path, query, body) in &allowed {
        let target = catalog
            .allows("google-calendar", method, path)
            .unwrap_or_else(|| panic!("{method} {path} must be allowed"));
        assert_eq!(target.as_str(), "https://www.googleapis.com/calendar/v3");
        assert_eq!(
            catalog.required_headers("google-calendar", method, path),
            Some(vec![]),
            "{method} {path}"
        );
        catalog
            .validate_request(
                "google-calendar",
                method,
                path,
                Some(query),
                body.then_some("application/json"),
                *body,
            )
            .unwrap_or_else(|err| panic!("{method} {path}?{query}: {err}"));
    }

    // The declared enum is enforced; the relay path keeps the server's base.
    assert_eq!(
        catalog.validate_request(
            "google-calendar",
            "PATCH",
            &format!("{events}/timed"),
            Some("sendUpdates=everyone"),
            Some("application/json"),
            true,
        ),
        Err("query parameter value is not permitted")
    );
    assert!(catalog
        .allows("google-calendar", "GET", "/calendars/primary/events")
        .is_none());
}

#[test]
fn composed_github_issues_requests_the_repo_scope() {
    let catalog = catalog(
        "github-issues",
        include_str!("../tests/identity-catalog/github-issues-composed.yaml"),
        json!({"oauthSecurityScheme": "githubOAuth"}),
    );
    let provider = catalog.oauth_provider("github-issues").unwrap();
    assert_eq!(provider.scopes, vec!["repo"]);
}

#[tokio::test]
#[ignore = "downloads the pinned OAD sources the published catalog composes"]
async fn published_catalog_still_loads_with_tenant_identity_selections_present() {
    let catalog = Catalog::load_checked_in(&crate::build_http_client())
        .await
        .expect("published catalog must load through the runtime loader");
    for platform in ["google-calendar", "github-issues"] {
        assert!(
            catalog.oauth_provider(platform).is_ok(),
            "{platform} must still compose an OAuth provider"
        );
    }
}
