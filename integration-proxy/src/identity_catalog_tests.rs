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
