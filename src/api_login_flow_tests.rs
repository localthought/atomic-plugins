//! Database-backed standalone API-login regression coverage.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use axum::{
    http::{header, Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json,
};
use axum_extra::extract::cookie::Cookie;
use tower::ServiceExt;

fn catalog() -> crate::catalog::Catalog {
    crate::catalog::Catalog::from_test_document(
        "github-issues",
        serde_json::json!({
          "servers":[{"url":"https://api.example"}],
          "components":{"securitySchemes":{"oauth":{"type":"oauth2","flows":{"authorizationCode":{"authorizationUrl":"https://auth.example/authorize","tokenUrl":"https://auth.example/token","scopes":{"data":"data","profile":"profile"}}}}}},
          "paths":{"/data":{"get":{"security":[{"oauth":["data"]}]}},"/me":{"get":{"operationId":"identity","security":[{"oauth":["profile"]}],"x-authenticated-principal":{"kind":"user","namespace":"https://issuer.example","subject":"$response.body#/id","identifier":{"scope":"provider","stable":true,"reassigned":false},"claims":{"name":"$response.body#/name"}}}}}
        }),
        serde_json::json!({"oauthSecurityScheme":"oauth","tenantIdentity":{"operationId":"identity","namespace":"https://issuer.example"}}),
    )
}

fn state(security: crate::security::Security) -> crate::AppState {
    crate::AppState {
        oauth_client: oauth2::basic::BasicClient::new(
            oauth2::ClientId::new("fixture-google".into()),
            None,
            oauth2::AuthUrl::new("https://accounts.example/auth".into()).unwrap(),
            None,
        ),
        app_auth_userinfo_url: "https://accounts.example/userinfo".into(),
        app_auth_label: "OIDC".into(),
        app_auth_identity_namespace: None,
        http_client: crate::build_http_client(),
        identity_http_client: crate::build_identity_http_client(),
        key: axum_extra::extract::cookie::Key::generate(),
        server_secret: "secret".into(),
        base_url: "https://localthought.io".into(),
        catalog: catalog(),
        security: Some(security),
        test_upstream: None,
    }
}

fn cookies(response: &axum::response::Response) -> String {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().split(';').next().unwrap())
        .collect::<Vec<_>>()
        .join("; ")
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL and local fixture OAuth credentials"]
async fn standalone_login_uses_only_profile_scope_and_never_mints_connection_credentials() {
    let token_hits = Arc::new(AtomicUsize::new(0));
    let identity_hits = Arc::new(AtomicUsize::new(0));
    let token_counter = token_hits.clone();
    let verifier_seen = Arc::new(AtomicUsize::new(0));
    let verifier_counter = verifier_seen.clone();
    let identity_counter = identity_hits.clone();
    let upstream = axum::Router::new()
        .route(
            "/token",
            post(move |body: String| {
                let c = token_counter.clone();
                let verifier = verifier_counter.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    if body.contains("code_verifier=") {
                        verifier.fetch_add(1, Ordering::SeqCst);
                    }
                    Json(serde_json::json!({"access_token":"token"}))
                }
            }),
        )
        .route(
            "/identity",
            get(move || {
                let c = identity_counter.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Json(serde_json::json!({"id":42,"name":"Ada"}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let db = std::env::var("TEST_DATABASE_URL").unwrap();
    let security = crate::security::Security::connect(
        &db,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        vec![],
    )
    .await
    .unwrap();
    let mut state = state(security.clone());
    state.test_upstream = Some(upstream_url);
    let start = crate::router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/auth/login/github-issues")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::SEE_OTHER);
    let authorize = url::Url::parse(start.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let scopes = authorize
        .query_pairs()
        .find(|(k, _)| k == "scope")
        .unwrap()
        .1;
    assert_eq!(scopes, "profile");
    assert_eq!(
        authorize
            .query_pairs()
            .find(|(k, _)| k == "code_challenge_method")
            .unwrap()
            .1,
        "S256"
    );
    assert!(
        authorize
            .query_pairs()
            .find(|(k, _)| k == "code_challenge")
            .unwrap()
            .1
            .len()
            >= 43
    );
    let oauth_state = authorize
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let cookie = cookies(&start);
    let callback = crate::router(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/oauth/github-issues/callback?state={oauth_state}&code=code"
                ))
                .header(header::COOKIE, &cookie)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::SEE_OTHER);
    assert_eq!(callback.headers()[header::LOCATION], "/");
    assert_eq!(token_hits.load(Ordering::SeqCst), 1);
    assert_eq!(verifier_seen.load(Ordering::SeqCst), 1);
    assert_eq!(identity_hits.load(Ordering::SeqCst), 1);
    assert!(callback
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .all(|v| !v.to_str().unwrap().contains("connection_code")
            && !v.to_str().unwrap().contains("tenant_secret")));
    let mut headers = axum::http::HeaderMap::new();
    let session_cookie = callback
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .find(|v| v.to_str().unwrap().starts_with("session="))
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    headers.insert(header::COOKIE, session_cookie.parse().unwrap());
    let session = crate::session::read_session(
        &axum_extra::extract::PrivateCookieJar::from_headers(&headers, state.key.clone()),
    )
    .unwrap();
    assert_eq!(session.subject, "tenant:v1:{\"client\":null,\"namespace\":\"https://issuer.example\",\"scope\":\"provider\",\"subject\":42}");
    assert_eq!(session.name, "Ada");
    assert_eq!(session.identity_label.as_deref(), Some("github-issues"));
    let replay = crate::router(state)
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/oauth/github-issues/callback?state={oauth_state}&code=code"
                ))
                .header(header::COOKIE, cookie)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
    assert_eq!(token_hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL and local fixture OAuth credentials"]
async fn standalone_login_rejects_missing_changed_or_appeared_browser_state_before_exchange() {
    #[derive(Clone, Copy)]
    enum Case {
        MissingBinding,
        WrongBinding,
        AppearedSession,
    }
    let token_hits = Arc::new(AtomicUsize::new(0));
    let counter = token_hits.clone();
    let upstream = axum::Router::new().route(
        "/token",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Json(serde_json::json!({"access_token":"unexpected"}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let db = std::env::var("TEST_DATABASE_URL").unwrap();
    for case in [
        Case::MissingBinding,
        Case::WrongBinding,
        Case::AppearedSession,
    ] {
        let security = crate::security::Security::connect(
            &db,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            vec![],
        )
        .await
        .unwrap();
        let mut state = state(security.clone());
        state.test_upstream = Some(upstream_url.clone());
        let first = crate::router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/auth/login/github-issues")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let url = url::Url::parse(first.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        let oauth_state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        let mut cookie = match case {
            Case::MissingBinding => String::new(),
            Case::WrongBinding => {
                let second = crate::router(state.clone())
                    .oneshot(
                        Request::builder()
                            .uri("/auth/login/github-issues")
                            .body(axum::body::Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                cookies(&second)
            }
            Case::AppearedSession => cookies(&first),
        };
        if matches!(case, Case::AppearedSession) {
            let user = crate::session::SessionUser::new(
                "other".into(),
                "other@example.com".into(),
                "Other".into(),
                None,
            );
            let response = crate::session::set_session(
                axum_extra::extract::PrivateCookieJar::new(state.key.clone()),
                &user,
            )
            .into_response();
            let session = cookies(&response);
            cookie = format!("{cookie}; {session}");
        }
        let mut request = Request::builder().uri(format!(
            "/oauth/github-issues/callback?state={oauth_state}&code=fixture"
        ));
        if !cookie.is_empty() {
            request = request.header(header::COOKIE, cookie);
        }
        let response = crate::router(state.clone())
            .oneshot(request.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(security
            .take_oauth_state(&oauth_state)
            .await
            .unwrap()
            .is_none());
    }
    assert_eq!(token_hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL and local fixture OAuth credentials"]
async fn standalone_login_cancellation_returns_validated_pending_connect_to_hub() {
    let token_hits = Arc::new(AtomicUsize::new(0));
    let counter = token_hits.clone();
    let upstream = axum::Router::new().route(
        "/token",
        post(move || {
            let c = counter.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Json(serde_json::json!({"access_token":"unexpected"}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let db = std::env::var("TEST_DATABASE_URL").unwrap();
    let security = crate::security::Security::connect(
        &db,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        vec![],
    )
    .await
    .unwrap();
    let mut state = state(security.clone());
    state.test_upstream = Some(upstream_url);
    let local = format!("/connect?platform=github-issues&redirect_uri=https%3A%2F%2Fhub.example%2Fapp%2Fintegrations%3Fstate%3Dpending&user_id=did%3Aad%3Aagent%3Atest&code_challenge={}&code_challenge_method=S256&credentials=connection", crate::connect::pkce_challenge(&"a".repeat(43)).unwrap());
    let initial = crate::session::set_connect_redirect(
        axum_extra::extract::PrivateCookieJar::new(state.key.clone()),
        &local,
    )
    .add(
        Cookie::build(("platform_consent", "seed"))
            .path("/")
            .build(),
    )
    .into_response();
    let start = crate::router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/auth/login/github-issues")
                .header(header::COOKIE, cookies(&initial))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let authorize = url::Url::parse(start.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    let oauth_state = authorize
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let callback_cookies = format!("{}; {}", cookies(&initial), cookies(&start));
    let callback = crate::router(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/oauth/github-issues/callback?state={oauth_state}&error=access_denied"
                ))
                .header(header::COOKIE, callback_cookies)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::SEE_OTHER);
    let destination =
        url::Url::parse(callback.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    assert_eq!(
        destination.origin().ascii_serialization(),
        "https://hub.example"
    );
    assert_eq!(
        destination
            .query_pairs()
            .find(|(k, _)| k == "error")
            .unwrap()
            .1,
        "access_denied"
    );
    assert_eq!(token_hits.load(Ordering::SeqCst), 0);
    assert!(security
        .take_oauth_state(&oauth_state)
        .await
        .unwrap()
        .is_none());
    let set = cookies(&callback);
    assert!(set.contains("api_login_binding=") && set.contains("platform_consent="));
}
