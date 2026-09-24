//! OAuth/catalog integration proxy for Atomic Server and LocalThought
//! clients.
//!
//! Clients authenticate with their Atomic agent key (issue #54): every
//! request that matters carries an Atomic v2 request signature, a connection
//! is owned by the agent that redeemed it, and apps use it through
//! owner-signed delegations. There are no accounts, logins, tenants or
//! rotating codes.
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
//!   themselves. [`build_app_with_access`] does the same with a custom
//!   [`AccessPolicy`] (e.g. a SaaS account and tier lookup).
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

mod access;
mod agent_id;
mod api_error;
mod capability;
mod catalog;
mod config;
mod connect;
mod connections;
#[cfg(test)]
mod identity_catalog_tests;
mod oauth;
mod providers;
mod proxy;
mod security;
mod signature;
mod templates;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

use axum::{
    extract::{FromRef, State},
    response::Html,
    routing::{delete, get, post},
    Router,
};
use axum_extra::extract::cookie::Key;
use sha2::{Digest, Sha512};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

pub use access::{Access, AccessPolicy, AllowAll, EnvAccessPolicy};
pub use agent_id::{parse as parse_agent_id, AgentId};
pub use config::{Config, DEFAULT_CATALOG_PATH};

#[derive(Clone)]
struct AppState {
    http_client: reqwest::Client,
    key: Key,
    /// `Config::base_url`, trailing `/` trimmed: the signed URL's prefix.
    base_url: String,
    /// `Config::public_origin`: a capability's `aud`, and the only `Origin`
    /// accepted on the consent form.
    public_origin: String,
    catalog: catalog::Catalog,
    security: Option<security::Security>,
    access: Arc<dyn AccessPolicy>,
    #[cfg(test)]
    test_upstream: Option<String>,
}

impl FromRef<AppState> for Key {
    fn from_ref(state: &AppState) -> Self {
        state.key.clone()
    }
}

pub(crate) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch")
        .as_secs()
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis() as u64
}

/// Asks the access policy about `owner`.
pub(crate) async fn check_access(
    state: &AppState,
    owner: &AgentId,
) -> Result<(), api_error::ApiError> {
    match state.access.check(owner).await {
        Access::Allowed => Ok(()),
        Access::Denied(reason) => Err(api_error::ApiError::AccessDenied(reason)),
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

/// A failure while starting or running the proxy. The [`std::fmt::Display`]
/// form is the one-line message the binary prints before exiting.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// Missing or invalid environment configuration.
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

/// Builds the complete application router from `config`, with the default
/// [`EnvAccessPolicy`] (`REVOKED_SUBJECTS`, `ALLOWED_AGENTS`).
pub async fn build_app(config: &Config) -> Result<Router, Error> {
    let access = EnvAccessPolicy::new(
        config.allowed_agents.clone(),
        config.revoked_subjects.clone(),
    );
    build_app_with_access(config, Arc::new(access)).await
}

/// Builds the complete application router from `config`: the cookie key, the
/// composed catalog (fetched from `config.catalog_path`, which may be an
/// HTTPS URL) and the PostgreSQL-backed store, admitting connection owners
/// through `access`. The returned router already carries CORS and request
/// tracing layers.
pub async fn build_app_with_access(
    config: &Config,
    access: Arc<dyn AccessPolicy>,
) -> Result<Router, Error> {
    let base_url = config::validate_base_url(&config.base_url).map_err(Error::Config)?;
    let key = match &config.session_secret {
        Some(secret) => Key::from(&Sha512::digest(secret.as_bytes())),
        None => {
            tracing::warn!(
                "SESSION_SECRET is not set; using a random key. A consent screen open during a restart must be started again."
            );
            Key::generate()
        }
    };

    let http_client = build_http_client();
    let catalog = catalog::Catalog::load(&config.catalog_path, &http_client)
        .await
        .map_err(Error::Catalog)?;
    let security = security::Security::connect(&config.database_url, &config.encryption_key)
        .await
        .map_err(Error::Security)?;

    let state = AppState {
        http_client,
        key,
        base_url,
        public_origin: config.public_origin(),
        catalog,
        security: Some(security),
        access,
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
    tracing::info!("integration-proxy listening on http://{addr}");

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

// Signatures and capabilities are supplied explicitly by the caller, never
// as cookies, so any origin may call, including a plugin's null-origin
// frame. Never enable cookie credentials: consent remains a top-level
// navigation.
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
            HeaderName::from_static(signature::AGENT_HEADER),
            HeaderName::from_static(signature::PUBLIC_KEY_HEADER),
            HeaderName::from_static(signature::TIMESTAMP_HEADER),
            HeaderName::from_static(signature::SIGNATURE_HEADER),
            HeaderName::from_static(signature::VERSION_HEADER),
        ])
        .expose_headers([
            header::CONTENT_TYPE,
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
        .route("/connect", get(connect::page))
        .route("/connect/authorize", post(connect::authorize))
        .route("/connect/redeem", post(connect::redeem))
        .route("/connections", get(connections::list))
        .route("/connections/:connection_id", delete(connections::delete))
        .route(
            "/connections/:connection_id/agents",
            post(connections::add_agent),
        )
        .route(
            "/connections/:connection_id/agents/:agent",
            delete(connections::remove_agent),
        )
        .route("/runtimes", post(connections::add_runtime))
        .route("/runtimes/:agent", delete(connections::remove_runtime))
        .route(
            "/proxy/:connection_id/:platform/*path",
            axum::routing::any(proxy::forward),
        )
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

async fn home() -> Html<String> {
    Html(templates::render_home())
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
    async fn a_null_origin_frame_may_preflight_signed_proxy_requests() {
        let app = test_support::router_without_database();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/proxy/conn/pets/pets")
                    .header("origin", "null")
                    .header("access-control-request-method", "PATCH")
                    .header(
                        "access-control-request-headers",
                        "authorization,content-type,if-match,x-atomic-agent,x-atomic-public-key,x-atomic-timestamp,x-atomic-signature,x-atomic-signature-version",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        let allowed = response.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .to_owned();
        for name in [
            "authorization",
            "content-type",
            "if-match",
            "x-atomic-agent",
            "x-atomic-public-key",
            "x-atomic-timestamp",
            "x-atomic-signature",
            "x-atomic-signature-version",
        ] {
            assert!(allowed.contains(name), "{name} not in {allowed}");
        }
        assert!(!response
            .headers()
            .contains_key("access-control-allow-credentials"));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/catalog")
                    .header("origin", "null")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let exposed = response.headers()["access-control-expose-headers"]
            .to_str()
            .unwrap();
        for name in ["link", "retry-after", "etag", "content-type"] {
            assert!(exposed.contains(name), "{name} not in {exposed}");
        }
        assert!(!exposed.contains("x-connection-code"));
    }
}
