//! Shared test helpers: an `AppState` without real I/O, and requests signed
//! the way an Atomic client signs them.
use crate::agent_id::test_signer::Agent;
use crate::AppState;

pub const BASE_URL: &str = "https://proxy.example";
pub const PUBLIC_ORIGIN: &str = "https://proxy.example";

pub fn state(security: Option<crate::security::Security>) -> AppState {
    AppState {
        http_client: crate::build_http_client(),
        key: axum_extra::extract::cookie::Key::generate(),
        base_url: BASE_URL.into(),
        public_origin: PUBLIC_ORIGIN.into(),
        catalog: crate::catalog::Catalog::for_test("github-issues"),
        security,
        access: std::sync::Arc::new(crate::access::AllowAll),
        operator: crate::templates::Operator::new(
            crate::config::DEFAULT_OPERATOR_NAME,
            None,
            &crate::config::public_host(BASE_URL),
        ),
        test_upstream: None,
    }
}

pub fn router_without_database() -> axum::Router {
    crate::router(state(None))
}

pub async fn security() -> crate::security::Security {
    crate::security::Security::connect(
        &crate::security::tests::test_database_url(),
        crate::security::tests::TEST_KEY,
    )
    .await
    .expect("connect to TEST_DATABASE_URL")
}

/// A request to `path` (path and query) signed by `agent` for this state's
/// public base URL, now.
pub fn signed_request(
    state: &AppState,
    agent: &Agent,
    method: &str,
    path: &str,
    body: Vec<u8>,
) -> axum::http::Request<axum::body::Body> {
    signed_request_at(state, agent, method, path, body, unique_now_ms())
}

pub fn signed_request_at(
    state: &AppState,
    agent: &Agent,
    method: &str,
    path: &str,
    body: Vec<u8>,
    timestamp_ms: u64,
) -> axum::http::Request<axum::body::Body> {
    let url = crate::signature::signed_url(&state.base_url, path);
    build(agent, method, path, &url, body, timestamp_ms)
}

/// A request to `path` whose signature covers `url` instead of the proxy's
/// configured public URL.
pub fn signed_request_for_url(
    agent: &Agent,
    method: &str,
    path: &str,
    url: &str,
    body: Vec<u8>,
) -> axum::http::Request<axum::body::Body> {
    build(agent, method, path, url, body, unique_now_ms())
}

fn build(
    agent: &Agent,
    method: &str,
    path: &str,
    url: &str,
    body: Vec<u8>,
    timestamp_ms: u64,
) -> axum::http::Request<axum::body::Body> {
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .extension(BodyCopy(body.clone()));
    for (name, value) in crate::signature::test_headers(agent, method, url, timestamp_ms, &body) {
        builder = builder.header(name, value);
    }
    builder.body(axum::body::Body::from(body)).unwrap()
}

/// Distinct per call, so two otherwise identical requests signed in the same
/// millisecond are not mistaken for a replay of each other.
fn unique_now_ms() -> u64 {
    static OFFSET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    crate::now_ms() - 60_000 + OFFSET.fetch_add(1, std::sync::atomic::Ordering::SeqCst) % 60_000
}

/// The same request again, headers and all. Only for requests built by this
/// module, whose bodies are known: the clone carries the original's body.
pub fn clone_request(
    request: &axum::http::Request<axum::body::Body>,
) -> axum::http::Request<axum::body::Body> {
    let mut builder = axum::http::Request::builder()
        .method(request.method().clone())
        .uri(request.uri().clone());
    for (name, value) in request.headers() {
        builder = builder.header(name, value);
    }
    let body = request
        .extensions()
        .get::<BodyCopy>()
        .map(|copy| copy.0.clone())
        .unwrap_or_default();
    let mut clone = builder.body(axum::body::Body::from(body.clone())).unwrap();
    clone.extensions_mut().insert(BodyCopy(body));
    clone
}

#[derive(Clone)]
struct BodyCopy(Vec<u8>);

pub async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&bytes)))
}
