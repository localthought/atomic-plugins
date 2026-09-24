use std::env;
use url::Url;

/// Runtime configuration, loaded entirely from environment variables so the
/// server itself stays container-friendly.
///
/// Issue #54 removed the tenant concept. `APP_AUTH_*`, `SERVER_SECRET` and
/// the other tenant-era variables are no longer read; leaving them set is
/// harmless.
#[derive(Clone)]
pub struct Config {
    /// Public URL the proxy is reachable at, e.g. `https://auth.example.com`.
    /// Used for OAuth redirect URLs, and as the origin of the URL covered by
    /// every Atomic v2 request signature and of a capability's `aud`. It must
    /// be exactly what clients use: behind TLS termination the proxy cannot
    /// tell its public scheme or host from the request.
    pub base_url: String,
    pub port: u16,
    /// Secret used to encrypt the short-lived consent and OAuth-binding
    /// cookies. If unset, a random key is generated at startup, so a consent
    /// screen open during a restart has to be started again.
    pub session_secret: Option<String>,
    /// Local file or immutable HTTPS URL listing the pinned OADs and overlays.
    pub catalog_path: String,
    /// PostgreSQL: connections, delegations, runtimes, handoffs and the
    /// single-use record of signed requests.
    pub database_url: String,
    /// Base64url-encoded 32-byte key for sealed provider credentials.
    pub encryption_key: String,
    /// `REVOKED_SUBJECTS`: comma-separated agent ids (any accepted spelling)
    /// refused by the default access policy.
    pub revoked_subjects: Vec<String>,
    /// `ALLOWED_AGENTS`: when set, comma-separated agent ids; the default
    /// access policy admits only these owners.
    pub allowed_agents: Option<Vec<String>>,
    /// `OPERATOR_NAME`: who runs this proxy, as the landing and consent pages
    /// name them. Defaults to [`DEFAULT_OPERATOR_NAME`] when unset or blank.
    pub operator_name: String,
    /// `OPERATOR_URL`: optional absolute http(s) link for the operator's
    /// name on those pages.
    pub operator_url: Option<String>,
}

/// The operator name when `OPERATOR_NAME` is unset: neutral, because the
/// crate does not know who runs it.
pub const DEFAULT_OPERATOR_NAME: &str = "this integration proxy";

/// Where GitHub Pages serves this repository's `overlays/` folder. Every
/// overlay URL in `overlays/catalog.json` starts with this prefix.
pub const OVERLAYS_PAGES_BASE: &str = "https://ontola.github.io/atomic-plugins/overlays/";

/// `overlays/catalog.json` as GitHub Pages publishes it from this
/// repository's `main`, used when `CATALOG_PATH` is not set. Unlike the
/// commit-pinned `raw.githubusercontent.com` URLs this replaced, it changes
/// whenever `main` changes; the proxy reads it once, at startup. Shared with
/// tests that need to validate the exact catalog the application would load
/// by default (they read the checked-in copy; see `Catalog::load_checked_in`).
pub const DEFAULT_CATALOG_PATH: &str =
    "https://ontola.github.io/atomic-plugins/overlays/catalog.json";

/// Reads a required environment variable and rejects it if unset or blank,
/// so a blank `.env` value fails configuration explicitly instead of being
/// silently accepted (e.g. as a reproducible empty secret).
fn require_env(name: &str) -> Result<String, String> {
    match env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(format!("{name} must be set")),
    }
}

fn list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `BASE_URL` must be an absolute http(s) URL without credentials, query or
/// fragment: it is the signed origin, so anything ambiguous is refused at
/// startup rather than failing every signature later.
pub(crate) fn validate_base_url(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "BASE_URL must be an absolute URL".to_string())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "BASE_URL must be an http(s) URL without credentials, query or fragment".into(),
        );
    }
    Ok(value.trim_end_matches('/').to_owned())
}

/// `OPERATOR_NAME`, trimmed; unset or blank means [`DEFAULT_OPERATOR_NAME`].
pub(crate) fn operator_name(value: Option<&str>) -> String {
    match value.map(str::trim) {
        Some(name) if !name.is_empty() => name.to_owned(),
        _ => DEFAULT_OPERATOR_NAME.to_owned(),
    }
}

/// `OPERATOR_URL`, if set: an absolute http(s) URL without credentials. It is
/// rendered as a link, so anything else (`javascript:`, a relative path) is
/// refused at startup.
pub(crate) fn validate_operator_url(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let url = Url::parse(value)
        .map_err(|_| "OPERATOR_URL must be an absolute http(s) URL".to_string())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("OPERATOR_URL must be an http(s) URL without credentials".into());
    }
    Ok(Some(url.to_string()))
}

/// `host[:port]` of an http(s) URL, the port only when it is not the
/// scheme's default. Falls back to the input when it does not parse.
pub(crate) fn public_host(base_url: &str) -> String {
    match Url::parse(base_url) {
        Ok(url) => match (url.host_str(), url.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_owned(),
            _ => base_url.to_owned(),
        },
        Err(_) => base_url.to_owned(),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let base_url = validate_base_url(
            &env::var("BASE_URL").unwrap_or_else(|_| "http://localhost:8080".to_string()),
        )?;
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080);
        // An empty SESSION_SECRET is treated as unset, so it triggers random
        // key generation instead of being hashed into a reproducible,
        // guessable cookie-encryption key.
        let session_secret = env::var("SESSION_SECRET")
            .ok()
            .filter(|value| !value.is_empty());
        let catalog_path =
            env::var("CATALOG_PATH").unwrap_or_else(|_| DEFAULT_CATALOG_PATH.to_string());
        let database_url = require_env("DATABASE_URL").map_err(|_| {
            "DATABASE_URL must be set for connections and replay protection".to_string()
        })?;
        let encryption_key = require_env("ENCRYPTION_KEY")?;
        let revoked_subjects = list(&env::var("REVOKED_SUBJECTS").unwrap_or_default());
        let allowed_agents = env::var("ALLOWED_AGENTS")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| list(&value));
        let operator_name = operator_name(env::var("OPERATOR_NAME").ok().as_deref());
        let operator_url = validate_operator_url(env::var("OPERATOR_URL").ok().as_deref())?;

        Ok(Self {
            base_url,
            port,
            session_secret,
            catalog_path,
            database_url,
            encryption_key,
            revoked_subjects,
            allowed_agents,
            operator_name,
            operator_url,
        })
    }

    /// The origin (`scheme://host[:port]`) of [`Config::base_url`]: a
    /// capability's required `aud`.
    pub fn public_origin(&self) -> String {
        Url::parse(&self.base_url)
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_else(|_| self.base_url.clone())
    }

    /// `host[:port]` of [`Config::base_url`], as the consent page shows it.
    pub fn public_host(&self) -> String {
        public_host(&self.base_url)
    }

    /// OAuth callback and credential variable names are deterministic from the
    /// catalog platform name, e.g. `google-calendar` becomes
    /// `OAUTH_GOOGLE_CALENDAR_CLIENT_ID` and `/oauth/google-calendar/callback`.
    pub fn provider_env_prefix(provider: &str) -> Result<String, String> {
        if provider.is_empty()
            || !provider
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(
                "provider names may contain only lowercase letters, digits, and hyphens"
                    .to_string(),
            );
        }
        Ok(format!(
            "OAUTH_{}",
            provider.replace('-', "_").to_ascii_uppercase()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_names_produce_predictable_environment_prefixes() {
        assert_eq!(
            Config::provider_env_prefix("google-calendar").unwrap(),
            "OAUTH_GOOGLE_CALENDAR"
        );
        assert!(Config::provider_env_prefix("Google Calendar").is_err());
    }

    #[test]
    fn require_env_rejects_missing_and_blank_values() {
        let name = "INTEGRATION_PROXY_TEST_REQUIRE_ENV_VAR";
        env::remove_var(name);
        assert!(require_env(name).is_err());
        env::set_var(name, "");
        assert!(require_env(name).is_err());
        env::set_var(name, "a-value");
        assert_eq!(require_env(name).unwrap(), "a-value");
        env::remove_var(name);
    }

    #[test]
    fn base_url_is_the_signed_origin_and_must_be_unambiguous() {
        assert_eq!(
            validate_base_url("https://proxy.example/").unwrap(),
            "https://proxy.example"
        );
        assert_eq!(
            validate_base_url("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
        for invalid in [
            "proxy.example",
            "ftp://proxy.example",
            "https://u:p@proxy.example",
            "https://proxy.example?x=1",
            "https://proxy.example#x",
        ] {
            assert!(validate_base_url(invalid).is_err(), "{invalid}");
        }
        let config = Config {
            base_url: "https://proxy.example:8443/prefix".into(),
            port: 0,
            session_secret: None,
            catalog_path: String::new(),
            database_url: String::new(),
            encryption_key: String::new(),
            revoked_subjects: vec![],
            allowed_agents: None,
            operator_name: DEFAULT_OPERATOR_NAME.into(),
            operator_url: None,
        };
        assert_eq!(config.public_origin(), "https://proxy.example:8443");
        assert_eq!(config.public_host(), "proxy.example:8443");
        assert_eq!(public_host("https://proxy.example"), "proxy.example");
        assert_eq!(public_host("http://127.0.0.1:8080"), "127.0.0.1:8080");
    }

    #[test]
    fn operator_name_defaults_to_a_neutral_phrase() {
        assert_eq!(operator_name(None), DEFAULT_OPERATOR_NAME);
        assert_eq!(operator_name(Some("  ")), DEFAULT_OPERATOR_NAME);
        assert_eq!(operator_name(Some(" Atomic Data ")), "Atomic Data");
    }

    #[test]
    fn operator_url_is_optional_and_must_be_a_plain_http_url() {
        assert_eq!(validate_operator_url(None).unwrap(), None);
        assert_eq!(validate_operator_url(Some(" ")).unwrap(), None);
        assert_eq!(
            validate_operator_url(Some("https://atomic.place")).unwrap(),
            Some("https://atomic.place/".into())
        );
        for invalid in [
            "atomic.place",
            "javascript:alert(1)",
            "data:text/html,x",
            "https://u:p@atomic.place",
        ] {
            assert!(validate_operator_url(Some(invalid)).is_err(), "{invalid}");
        }
    }

    #[test]
    fn lists_are_comma_separated_and_trimmed() {
        assert_eq!(list(" a, b ,,c "), vec!["a", "b", "c"]);
        assert!(list("").is_empty());
    }
}
