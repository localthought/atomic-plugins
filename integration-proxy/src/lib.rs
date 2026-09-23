//! Stateless OAuth/catalog integration proxy for LocalThought and Atomic
//! Server clients.
//!
//! This crate is the whole service; the `integration-proxy` binary in this
//! package, and any deployment wrapper (e.g. the Heroku app that serves
//! localthought.io), is a thin `main` around it. The public API is
//! deliberately small:
//!
//! - [`Config`] — all runtime configuration, loaded with
//!   [`Config::from_env`] from the environment variables documented in the
//!   README.
//! - [`build_app`] — loads the catalog, connects to PostgreSQL and returns the
//!   ready-to-serve [`axum::Router`], for callers that bind or wrap it
//!   themselves.
//! - [`serve`] — [`build_app`] plus binding `0.0.0.0:{config.port}` and
//!   serving until the listener fails.
//! - [`run`] — what the bundled binary does: initialise `tracing` from
//!   `RUST_LOG`, load [`Config::from_env`], [`serve`], and turn any
//!   [`Error`] into a message on stderr and a failing exit code.
//!
//! A minimal wrapper binary is therefore:
//!
//! ```no_run
//! #[tokio::main]
//! async fn main() -> std::process::ExitCode {
//!     atomic_integration_proxy::run().await
//! }
//! ```
//!
//! Everything else (route handlers, catalog composition, the security
//! store) is private and may change in any release.

mod api_login;
#[cfg(test)]
mod api_login_flow_tests;
mod auth;
mod catalog;
mod config;
mod connect;
mod identity;
#[cfg(test)]
mod identity_catalog_tests;
#[cfg(test)]
mod identity_policy_tests;
mod oauth;
#[allow(dead_code)] // used by the provider OAuth routes introduced with issue #9
mod providers;
mod proxy;
mod security;
mod session;
mod templates;
mod tenant_secret;

use axum::{
    extract::{FromRef, State},
    response::Html,
    routing::{get, post},
    Router,
};
use axum_extra::extract::{cookie::Key, PrivateCookieJar};
use oauth2::basic::BasicClient;
use sha2::{Digest, Sha512};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

pub use config::{Config, DEFAULT_CATALOG_PATH};

#[derive(Clone)]
struct AppState {
    oauth_client: BasicClient,
    app_auth_userinfo_url: String,
    app_auth_label: String,
    app_auth_identity_namespace: Option<String>,
    http_client: reqwest::Client,
    identity_http_client: reqwest::Client,
    key: Key,
    server_secret: String,
    base_url: String,
    catalog: catalog::Catalog,
    security: Option<security::Security>,
    #[cfg(test)]
    test_upstream: Option<String>,
}

impl FromRef<AppState> for Key {
    fn from_ref(state: &AppState) -> Self {
        state.key.clone()
    }
}

fn build_http_client() -> reqwest::Client {
    // GitHub's REST API requires a User-Agent on every request. Redirects are
    // disabled because only the initial target is validated against the
    // catalog allowlist; a followed redirect would escape that validation.
    // A bounded timeout keeps a stalled or slow upstream from holding the
    // connection (and the caller's request) open indefinitely.
    reqwest::Client::builder()
        .user_agent("LocalThought-integration-proxy")
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("failed to build HTTP client")
}

fn build_identity_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("LocalThought-integration-proxy")
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("failed to build identity HTTP client")
}

/// A failure while starting or running the proxy. The [`std::fmt::Display`]
/// form is the one-line message the binary prints before exiting.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// Missing or invalid environment configuration, or an OIDC client that
    /// cannot be built from it.
    Config(String),
    /// The catalog at `CATALOG_PATH` could not be loaded or composed.
    Catalog(String),
    /// The PostgreSQL connection or `ENCRYPTION_KEY` was rejected.
    Security(String),
    /// Binding the listening socket failed.
    Bind {
        /// The address that could not be bound.
        addr: String,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// The HTTP server stopped with an I/O error.
    Serve(std::io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Config(err) => write!(f, "configuration error: {err}"),
            Error::Catalog(err) => write!(f, "catalog configuration error: {err}"),
            Error::Security(err) => write!(f, "security configuration error: {err}"),
            Error::Bind { addr, source } => write!(f, "failed to bind {addr}: {source}"),
            Error::Serve(err) => write!(f, "server error: {err}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Bind { source, .. } | Error::Serve(source) => Some(source),
            _ => None,
        }
    }
}

/// Builds the complete application router from `config`: the application
/// OIDC client, the session-cookie key, the composed catalog (fetched from
/// `config.catalog_path`, which may be an HTTPS URL) and the PostgreSQL-backed
/// security store. The returned router already carries CORS and request
/// tracing layers.
pub async fn build_app(config: &Config) -> Result<Router, Error> {
    let oauth_client = auth::build_client(config).map_err(Error::Config)?;

    let key = match &config.session_secret {
        Some(secret) => Key::from(&Sha512::digest(secret.as_bytes())),
        None => {
            tracing::warn!(
                "SESSION_SECRET is not set; using a random key. Sessions will not survive a restart."
            );
            Key::generate()
        }
    };

    let http_client = build_http_client();
    let identity_http_client = build_identity_http_client();
    let catalog = catalog::Catalog::load(&config.catalog_path, &http_client)
        .await
        .map_err(Error::Catalog)?;
    let security = security::Security::connect(
        &config.database_url,
        &config.encryption_key,
        config.revoked_subjects.clone(),
    )
    .await
    .map_err(Error::Security)?;

    let state = AppState {
        oauth_client,
        app_auth_userinfo_url: config.app_auth_userinfo_url.clone(),
        app_auth_label: config.app_auth_label.clone(),
        app_auth_identity_namespace: config.app_auth_identity_namespace.clone(),
        http_client,
        identity_http_client,
        key,
        server_secret: config.server_secret.clone(),
        base_url: config.base_url.clone(),
        catalog,
        security: Some(security),
        #[cfg(test)]
        test_upstream: None,
    };

    Ok(router(state))
}

/// Runs [`build_app`] and serves it on `0.0.0.0:{config.port}` until the
/// server fails; under normal operation it does not return.
pub async fn serve(config: Config) -> Result<(), Error> {
    let app = build_app(&config).await?;

    let addr = format!("0.0.0.0:{}", config.port);
    tracing::info!("auth-proxy listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|source| Error::Bind {
            addr: addr.clone(),
            source,
        })?;
    axum::serve(listener, app).await.map_err(Error::Serve)
}

/// The bundled binary's entry point: installs a `tracing` subscriber
/// filtered by `RUST_LOG` (default `info`; skipped if the caller already
/// installed one), loads [`Config::from_env`] and runs [`serve`]. Any
/// [`Error`] is printed to stderr and reported as a failing exit code.
pub async fn run() -> std::process::ExitCode {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .try_init();

    let result = match Config::from_env() {
        Ok(config) => serve(config).await,
        Err(err) => Err(Error::Config(err)),
    };
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            std::process::ExitCode::FAILURE
        }
    }
}

// Bearer credentials are explicitly supplied by the browser. Never enable
// cookie credentials: login/consent remain top-level navigations.
fn browser_cors() -> tower_http::cors::CorsLayer {
    use axum::http::{header, HeaderName, Method};
    use tower_http::cors::{Any, CorsLayer};
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_MATCH,
        ])
        .expose_headers([
            HeaderName::from_static("x-connection-code"),
            header::LINK,
            header::RETRY_AFTER,
            header::ETAG,
            HeaderName::from_static("x-total-count"),
            HeaderName::from_static("x-next-page"),
        ])
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(home))
        .route("/healthz", get(healthz))
        .route("/logo.png", get(logo))
        .route("/auth/login", get(auth::login))
        .route("/auth/login/:platform", get(api_login::start))
        .route("/auth/callback", get(auth::callback))
        .route("/auth/logout", post(auth::logout))
        .route("/connect", get(connect::page).post(proxy::connect_confirm))
        .route("/connect/authorize", post(connect::authorize))
        .route("/connect/redeem", post(connect::redeem))
        .route("/proxy", axum::routing::any(proxy::proxy))
        .route("/proxy/*path", axum::routing::any(proxy::forward))
        .route("/session", get(proxy::session_challenge))
        .route("/oauth/:provider/start", get(oauth::start))
        .route("/oauth/:provider/callback", get(oauth::callback))
        .route("/catalog", get(catalog::list))
        .route("/catalog/:file", get(catalog::document))
        .layer(browser_cors())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Reports whether the database is currently reachable, so an operator or
/// load balancer can detect a still-recovering connection instead of only
/// finding out from a failed request.
async fn healthz(State(state): State<AppState>) -> impl axum::response::IntoResponse {
    match &state.security {
        Some(security) if security.is_ready().await => (axum::http::StatusCode::OK, "ok"),
        _ => (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "database unavailable",
        ),
    }
}

async fn logo() -> impl axum::response::IntoResponse {
    (
        [
            (axum::http::header::CONTENT_TYPE, "image/png"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        include_bytes!("../static/logo.png").as_slice(),
    )
}

async fn home(State(state): State<AppState>, jar: PrivateCookieJar) -> Html<String> {
    let user = session::read_session(&jar);
    let tenant_secret = user
        .as_ref()
        .map(|u| tenant_secret::derive(&state.server_secret, &u.subject));
    Html(templates::render_home(
        user.as_ref(),
        tenant_secret.as_deref(),
        user.as_ref()
            .and_then(|user| user.identity_label.as_deref())
            .unwrap_or(&state.app_auth_label),
        &state
            .catalog
            .names()
            .into_iter()
            .filter(|platform| state.catalog.tenant_identity(platform).is_ok())
            .collect::<Vec<_>>(),
    ))
}

#[cfg(test)]
mod browser_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn browser_preflight_and_rotation_headers() {
        let app = Router::new()
            .route(
                "/proxy/pets",
                get(|| async {
                    (
                        [
                            ("x-connection-code", "rotated"),
                            ("link", "</next>; rel=next"),
                        ],
                        "[]",
                    )
                }),
            )
            .layer(browser_cors());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/proxy/pets")
                    .header("origin", "https://atomic.example")
                    .header("access-control-request-method", "PATCH")
                    .header(
                        "access-control-request-headers",
                        "authorization,content-type,if-match",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert!(response.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .contains("authorization"));
        assert!(response.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .contains("if-match"));
        assert!(!response
            .headers()
            .contains_key("access-control-allow-credentials"));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/proxy/pets")
                    .header("origin", "https://atomic.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let exposed = response.headers()["access-control-expose-headers"]
            .to_str()
            .unwrap();
        assert!(exposed.contains("x-connection-code"));
        assert!(exposed.contains("link"));
    }
}
