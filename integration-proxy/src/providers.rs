use crate::{catalog::Catalog, config::Config};
use serde_json::Value;
use std::{collections::BTreeSet, env};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Provider {
    pub authorization_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    pub authorization_params: Vec<(String, String)>,
    pub use_pkce: bool,
    supported_client_auth: Option<Vec<String>>,
    token_operation: Option<TokenOperation>,
    refresh_operation: Option<TokenOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TokenOperation {
    json: bool,
    headers: Vec<(String, String)>,
    requires_basic: bool,
}

/// A static-secret OpenAPI `apiKey` security scheme: a declared parameter
/// name/location, filled in at proxy time from a browser-submitted secret.
/// There is no scopes concept and nothing to exchange or refresh.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiKeyScheme {
    pub name: String,
    pub location: ApiKeyLocation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApiKeyLocation {
    Header,
    Query,
    Cookie,
}

impl ApiKeyScheme {
    /// Read API-key capabilities from the composed document, never from platform names.
    pub fn from_document(document: &Value, selected_scheme: Option<&str>) -> Result<Self, String> {
        let schemes = document
            .pointer("/components/securitySchemes")
            .and_then(Value::as_object)
            .ok_or("missing security schemes")?;
        let candidates: Vec<_> = schemes
            .iter()
            .filter(|(_, scheme)| scheme.get("type").and_then(Value::as_str) == Some("apiKey"))
            .collect();
        let (_, scheme) = match selected_scheme {
            Some(selected) => candidates
                .iter()
                .find(|(name, _)| name.as_str() == selected)
                .copied()
                .ok_or("selected API key security scheme is not an apiKey scheme")?,
            None => match candidates.as_slice() {
                [candidate] => *candidate,
                _ => return Err(
                    "apiKeySecurityScheme selection is required when multiple apiKey schemes exist"
                        .into(),
                ),
            },
        };
        let name = scheme
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or("apiKey scheme must declare a non-empty name")?;
        let location = match scheme.get("in").and_then(Value::as_str) {
            Some("header") => ApiKeyLocation::Header,
            Some("query") => ApiKeyLocation::Query,
            Some("cookie") => ApiKeyLocation::Cookie,
            _ => return Err("apiKey scheme must declare a supported 'in' location".into()),
        };
        Ok(Self {
            name: name.to_owned(),
            location,
        })
    }
}

/// Which kind of credential a catalog platform's composed document declares.
/// Resolved generically from the document's `securitySchemes`, never from the
/// platform's name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecurityScheme {
    OAuth(Provider),
    ApiKey(ApiKeyScheme),
    /// The document explicitly requires no security: top-level
    /// `security: []`, no declared security scheme, and no operation that
    /// requires one. Connecting takes consent only, stores no provider
    /// credential, and forwards requests with none.
    NoCredential,
}

impl SecurityScheme {
    pub fn from_document(
        document: &Value,
        oauth_selected: Option<&str>,
        api_key_selected: Option<&str>,
    ) -> Result<Self, String> {
        if declares_no_security(document) {
            return Ok(Self::NoCredential);
        }
        let schemes = document
            .pointer("/components/securitySchemes")
            .and_then(Value::as_object)
            .ok_or("missing security schemes")?;
        let types: BTreeSet<&str> = schemes
            .values()
            .filter_map(|scheme| scheme.get("type").and_then(Value::as_str))
            .collect();
        match (types.contains("oauth2"), types.contains("apiKey")) {
            (true, false) => Provider::from_document(document, oauth_selected).map(Self::OAuth),
            (false, true) => {
                ApiKeyScheme::from_document(document, api_key_selected).map(Self::ApiKey)
            }
            (true, true) => Err(
                "platform declares both oauth2 and apiKey security schemes; mixed-kind catalogs are not supported"
                    .into(),
            ),
            (false, false) => Err("no supported security scheme found".into()),
        }
    }
}

/// Whether `document` opts out of security explicitly, as OpenAPI spells
/// it: a top-level `security` that is an empty array. Anything else that
/// mentions security (a declared scheme, or an operation with a non-empty
/// `security`) keeps the platform out of this kind, so a document that only
/// forgot its auth overlay is refused rather than connected without
/// credentials.
fn declares_no_security(document: &Value) -> bool {
    let top_level_empty = document
        .get("security")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty);
    let no_schemes = document
        .pointer("/components/securitySchemes")
        .and_then(Value::as_object)
        .is_none_or(serde_json::Map::is_empty);
    let no_operation_security = document
        .get("paths")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|paths| paths.values())
        .filter_map(Value::as_object)
        .flat_map(|item| item.values())
        .filter_map(|operation| operation.get("security"))
        .all(|security| security.as_array().is_some_and(Vec::is_empty));
    top_level_empty && no_schemes && no_operation_security
}

impl Provider {
    /// Read API capabilities from the composed document, never from platform names.
    pub fn from_document(document: &Value, selected_scheme: Option<&str>) -> Result<Self, String> {
        let schemes = document
            .pointer("/components/securitySchemes")
            .and_then(Value::as_object)
            .ok_or("missing security schemes")?;
        let candidates: Vec<_> = schemes
            .iter()
            .filter_map(|(name, scheme)| {
                (scheme.get("type")?.as_str()? == "oauth2").then(|| {
                    scheme
                        .pointer("/flows/authorizationCode")
                        .map(|flow| (name, flow))
                })?
            })
            .collect();
        let (scheme_name, flow) = match selected_scheme {
            Some(selected) => candidates
                .iter()
                .find(|(name, _)| name.as_str() == selected)
                .copied()
                .ok_or("selected OAuth security scheme is not an authorization-code scheme")?,
            None => match candidates.as_slice() {
                [candidate] => *candidate,
                _ => return Err(
                    "oauthSecurityScheme selection is required when multiple authorization-code schemes exist"
                        .into(),
                ),
            },
        };
        let scheme = &schemes[scheme_name];
        validate_supported_authentication_details(scheme)?;
        let endpoint = |key: &str| -> Result<String, String> {
            let value = flow
                .get(key)
                .and_then(Value::as_str)
                .ok_or("missing OAuth endpoint")?;
            let url = url::Url::parse(value).map_err(|_| "invalid OAuth endpoint")?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err("OAuth endpoints must be credential-free HTTPS URLs".into());
            }
            Ok(value.into())
        };
        let declared = flow
            .get("scopes")
            .and_then(Value::as_object)
            .ok_or("missing OAuth scopes")?;
        let mut scopes = BTreeSet::new();
        let mut add_requirements = |requirements: Option<&Value>| -> Result<(), String> {
            let Some(requirements) = requirements else {
                return Ok(());
            };
            let requirements = requirements
                .as_array()
                .ok_or("invalid security requirements")?;
            if requirements.is_empty()
                || requirements
                    .iter()
                    .any(|r| r.as_object().is_some_and(|r| r.is_empty()))
            {
                return Ok(());
            }
            // Alternatives are OR; choose a supported single-scheme alternative.
            let requirement = requirements
                .iter()
                .find(|r| {
                    r.as_object()
                        .is_some_and(|r| r.len() == 1 && r.contains_key(scheme_name))
                })
                .ok_or("operation requires an unsupported authentication combination")?;
            for scope in requirement[scheme_name]
                .as_array()
                .ok_or("invalid scope requirements")?
            {
                let scope = scope.as_str().ok_or("invalid OAuth scope")?;
                if !declared.contains_key(scope) {
                    return Err("required OAuth scope is not declared".into());
                }
                scopes.insert(scope.to_string());
            }
            Ok(())
        };
        if let Some(paths) = document.get("paths").and_then(Value::as_object) {
            let helper_refs = ["tokenEndpointOperation", "refreshEndpointOperation"]
                .iter()
                .filter_map(|key| authentication_details(scheme)?.get(*key)?.as_str())
                .collect::<BTreeSet<_>>();
            for (path_name, path) in paths
                .iter()
                .filter_map(|(n, p)| p.as_object().map(|p| (n, p)))
            {
                for method in [
                    "get", "put", "post", "delete", "options", "head", "patch", "trace",
                ] {
                    if let Some(operation) = path.get(method) {
                        let pointer = format!(
                            "#/paths/{}/{}",
                            path_name.replace('~', "~0").replace('/', "~1"),
                            method
                        );
                        if helper_refs.contains(pointer.as_str()) {
                            continue;
                        }
                        add_requirements(
                            operation
                                .get("security")
                                .or_else(|| document.get("security")),
                        )?;
                    }
                }
            }
        }
        let authorization_url = endpoint("authorizationUrl")?;
        let token_url = endpoint("tokenUrl")?;
        let authorization_params = authorization_params(document, scheme)?;
        validate_authorization_url(&authorization_url, &authorization_params)?;
        Ok(Self {
            authorization_url: authorization_url.clone(),
            token_url: token_url.clone(),
            scopes: scopes.into_iter().collect(),
            authorization_params,
            use_pkce: pkce_behavior(scheme)?,
            supported_client_auth: supported_client_auth(scheme)?,
            token_operation: operation_details(
                document,
                scheme,
                "tokenEndpointOperation",
                &token_url,
            )?,
            refresh_operation: operation_details(
                document,
                scheme,
                "refreshEndpointOperation",
                &token_url,
            )?,
        })
    }

    fn select_client_auth(&self, configured: Option<&str>) -> Result<ClientAuth, String> {
        let requires_basic = self
            .token_operation
            .as_ref()
            .is_some_and(|op| op.requires_basic)
            || self
                .refresh_operation
                .as_ref()
                .is_some_and(|op| op.requires_basic);
        let client_auth = match configured {
            Some(method) => ClientAuth::parse(method)?,
            None => match &self.supported_client_auth {
                Some(methods) => methods.iter().filter_map(|method| ClientAuth::parse(method).ok())
                    .find(|method| !requires_basic || *method == ClientAuth::SecretBasic)
                    .ok_or("no advertised client authentication method is supported by the proxy and token operations")?,
                None if requires_basic => ClientAuth::SecretBasic,
                None => ClientAuth::SecretPost,
            },
        };
        if requires_basic && client_auth != ClientAuth::SecretBasic {
            return Err("OAuth token operation requires client_secret_basic".into());
        }
        if self
            .supported_client_auth
            .as_ref()
            .is_some_and(|supported| {
                !supported
                    .iter()
                    .any(|method| method == client_auth.registered_name())
            })
        {
            return Err("configured client authentication method is not supported by the authorization server".into());
        }
        Ok(client_auth)
    }

    pub fn configured(catalog: &Catalog, name: &str) -> Result<ConfiguredProvider, String> {
        let provider = catalog.oauth_provider(name)?;
        let prefix = Config::provider_env_prefix(name)?;
        let client_id = env::var(format!("{prefix}_CLIENT_ID"))
            .map_err(|_| format!("{prefix}_CLIENT_ID must be set"))?;
        let method = env::var(format!("{prefix}_CLIENT_AUTH_METHOD")).ok();
        let client_auth = provider.select_client_auth(method.as_deref())?;
        let client_secret = if client_auth == ClientAuth::None {
            String::new()
        } else {
            env::var(format!("{prefix}_CLIENT_SECRET"))
                .map_err(|_| format!("{prefix}_CLIENT_SECRET must be set"))?
        };
        Ok(ConfiguredProvider {
            provider,
            client_id,
            client_secret,
            client_auth,
        })
    }
}

const RESERVED_AUTHORIZATION_PARAMETERS: &[&str] = &[
    "client_id",
    "client_secret",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "code",
    "code_challenge",
    "code_challenge_method",
    "code_verifier",
];

fn authentication_details(scheme: &Value) -> Option<&Value> {
    scheme.get("x-oauth-authentication-details")
}

fn validate_supported_authentication_details(scheme: &Value) -> Result<(), String> {
    if scheme.get("oauth2MetadataUrl").is_some() {
        return Err("oauth2MetadataUrl discovery is not supported by this proxy".into());
    }
    let Some(details) = authentication_details(scheme) else {
        return Ok(());
    };
    let _details = details
        .as_object()
        .ok_or("OAuth authentication details must be an object")?;
    Ok(())
}

fn operation_details(
    document: &Value,
    scheme: &Value,
    key: &str,
    endpoint: &str,
) -> Result<Option<TokenOperation>, String> {
    let Some(reference) = authentication_details(scheme)
        .and_then(|d| d.get(key))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    let pointer = reference
        .strip_prefix('#')
        .ok_or("OAuth operation references must be local")?;
    if !pointer.ends_with("/post") {
        return Err("OAuth token operation must use POST".into());
    }
    let operation = document
        .pointer(pointer)
        .ok_or("OAuth operation reference does not resolve")?;
    let requires_basic = operation
        .get("security")
        .and_then(Value::as_array)
        .map(|reqs| {
            !reqs.is_empty()
                && reqs.iter().all(|r| {
                    r.as_object().is_some_and(|obj| {
                        obj.keys().any(|name| {
                            document
                                .pointer(&format!("/components/securitySchemes/{name}"))
                                .is_some_and(|s| {
                                    s.get("type").and_then(Value::as_str) == Some("http")
                                        && s.get("scheme")
                                            .and_then(Value::as_str)
                                            .is_some_and(|v| v.eq_ignore_ascii_case("basic"))
                                })
                        })
                    })
                })
        })
        .unwrap_or(false);
    let actual = operation_endpoint(document, &format!("#{pointer}"))
        .ok_or("OAuth operation reference is not a path operation")?;
    if actual != endpoint {
        return Err("OAuth token operation URL does not match OAuth endpoint".into());
    }
    let body = operation
        .get("requestBody")
        .and_then(|b| b.get("content"))
        .and_then(Value::as_object)
        .ok_or("OAuth token operation must declare request content")?;
    let json = body.contains_key("application/json");
    if !json && !body.contains_key("application/x-www-form-urlencoded") {
        return Err("OAuth token operation uses unsupported content type".into());
    }
    let mut headers = Vec::new();
    if let Some(parameters) = operation.get("parameters").and_then(Value::as_array) {
        for parameter in parameters {
            let parameter = if let Some(reference) = parameter.get("$ref").and_then(Value::as_str) {
                let pointer = reference
                    .strip_prefix('#')
                    .ok_or("OAuth parameter references must be local")?;
                document
                    .pointer(pointer)
                    .ok_or("OAuth parameter reference does not resolve")?
            } else {
                parameter
            };
            if parameter.get("in").and_then(Value::as_str) != Some("header") {
                continue;
            }
            let name = parameter
                .get("name")
                .and_then(Value::as_str)
                .ok_or("OAuth header parameter has no name")?;
            if name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("host") {
                return Err("OAuth operation cannot override protected headers".into());
            }
            let value = parameter
                .get("schema")
                .and_then(|s| s.get("default"))
                .or_else(|| {
                    parameter
                        .get("schema")
                        .and_then(|s| s.get("enum"))
                        .and_then(|e| e.as_array())
                        .filter(|a| a.len() == 1)
                        .and_then(|a| a.first())
                })
                .and_then(Value::as_str)
                .ok_or("OAuth header parameter needs a string default or singleton enum")?;
            headers.push((name.to_owned(), value.to_owned()));
        }
    }
    Ok(Some(TokenOperation {
        json,
        headers,
        requires_basic,
    }))
}

fn operation_endpoint(document: &Value, pointer: &str) -> Option<String> {
    let server = document
        .get("servers")?
        .as_array()?
        .first()?
        .get("url")?
        .as_str()?;
    let mut base = url::Url::parse(server).ok()?;
    for (path, item) in document.get("paths")?.as_object()? {
        for method in [
            "get", "put", "post", "delete", "options", "head", "patch", "trace",
        ] {
            let escaped = path.replace('~', "~0").replace('/', "~1");
            if format!("#/paths/{escaped}/{method}") == pointer && item.get(method).is_some() {
                base.set_path(&format!("{}{}", base.path().trim_end_matches('/'), path));
                return Some(base.to_string().trim_end_matches('/').to_owned());
            }
        }
    }
    None
}

fn supported_client_auth(scheme: &Value) -> Result<Option<Vec<String>>, String> {
    let Some(details) = authentication_details(scheme) else {
        return Ok(None);
    };
    let details = details
        .as_object()
        .ok_or("OAuth authentication details must be an object")?;
    let Some(metadata) = details.get("authorizationServerMetadata") else {
        return Ok(None);
    };
    let metadata = metadata
        .as_object()
        .ok_or("authorization server metadata must be an object")?;
    let Some(value) = metadata.get("token_endpoint_auth_methods_supported") else {
        return Ok(None);
    };
    let methods = value
        .as_array()
        .ok_or("invalid token endpoint authentication methods")?;
    if methods.is_empty() {
        return Err("token endpoint authentication methods must not be empty".into());
    }
    let parsed = methods
        .iter()
        .map(|method| {
            method
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "invalid token endpoint authentication method".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parsed.iter().collect::<BTreeSet<_>>().len() != methods.len() {
        return Err("duplicate token endpoint authentication method".into());
    }
    Ok(Some(parsed))
}

fn pkce_behavior(scheme: &Value) -> Result<bool, String> {
    let Some(details) = authentication_details(scheme) else {
        // Preserve the proxy's established secure behavior when metadata is absent.
        return Ok(true);
    };
    let details = details
        .as_object()
        .ok_or("OAuth authentication details must be an object")?;
    if details
        .get("authorizationServerMetadata")
        .is_some_and(|metadata| !metadata.is_object())
    {
        return Err("authorization server metadata must be an object".into());
    }
    let methods_value = details
        .get("authorizationServerMetadata")
        .and_then(|metadata| metadata.get("code_challenge_methods_supported"));
    let methods = methods_value
        .map(|value| {
            let values = value
                .as_array()
                .ok_or("PKCE challenge methods must be an array")?;
            values
                .iter()
                .map(|value| value.as_str().ok_or("invalid PKCE challenge method"))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let pkce = details
        .get("authorizationCode")
        .and_then(|value| value.get("pkce"));
    let requirement = match pkce {
        Some(Value::Object(pkce)) => pkce
            .get("requirement")
            .and_then(Value::as_str)
            .ok_or("PKCE requirement must be a string")
            .map(Some)?,
        Some(_) => return Err("PKCE requirements must be an object".into()),
        None => None,
    };
    if requirement == Some("conditional") {
        let pkce = pkce.unwrap();
        if !pkce
            .get("requiredFor")
            .and_then(Value::as_array)
            .is_some_and(|values| {
                !values.is_empty() && values.iter().all(|value| value.is_string())
            })
            || pkce
                .get("description")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
        {
            return Err("conditional PKCE requires requiredFor and description".into());
        }
    }
    if !matches!(
        requirement,
        None | Some("required" | "optional" | "conditional" | "unsupported")
    ) {
        return Err("invalid PKCE requirement".into());
    }
    if requirement == Some("unsupported") {
        if methods.is_some_and(|methods| !methods.is_empty()) {
            return Err("unsupported PKCE contradicts declared challenge methods".into());
        }
        return Ok(false);
    }
    if methods
        .as_ref()
        .is_some_and(|methods| !methods.contains(&"S256"))
    {
        return Err(
            "S256 is required by the proxy but is not supported by the authorization server".into(),
        );
    }
    if requirement.is_some() && methods.as_ref().is_none_or(|methods| methods.is_empty()) {
        return Err("PKCE requirement has no declared challenge methods".into());
    }
    Ok(true)
}

fn validate_authorization_url(
    authorization_url: &str,
    authorization_params: &[(String, String)],
) -> Result<(), String> {
    let url = url::Url::parse(authorization_url).map_err(|_| "invalid OAuth endpoint")?;
    let fixed: BTreeSet<_> = authorization_params
        .iter()
        .map(|(key, _)| key.as_str())
        .collect();
    if url.query_pairs().any(|(key, _)| {
        RESERVED_AUTHORIZATION_PARAMETERS.contains(&key.as_ref()) || fixed.contains(key.as_ref())
    }) {
        return Err("authorization URL query conflicts with generated OAuth parameters".into());
    }
    Ok(())
}

fn authorization_params(document: &Value, scheme: &Value) -> Result<Vec<(String, String)>, String> {
    let Some(parameters) = authentication_details(scheme)
        .and_then(|details| details.pointer("/authorizationCode/profile/parameters"))
    else {
        return Ok(Vec::new());
    };
    let parameters = parameters
        .as_array()
        .ok_or("invalid authorization parameters")?;
    let mut output = Vec::new();
    let mut names = BTreeSet::new();
    let mut emitted_names = BTreeSet::new();
    for entry in parameters {
        let parameter = entry
            .get("parameter")
            .ok_or("missing authorization parameter")?;
        let parameter = resolve_parameter(document, parameter)?;
        let name = parameter
            .get("name")
            .and_then(Value::as_str)
            .ok_or("authorization parameter has no name")?;
        if parameter.get("in").and_then(Value::as_str) != Some("query")
            || RESERVED_AUTHORIZATION_PARAMETERS.contains(&name)
            || !names.insert(name.to_owned())
        {
            return Err("invalid or duplicate authorization query parameter".into());
        }
        let value = entry
            .get("value")
            .ok_or("authorization parameter has no value")?;
        validate_schema(value, parameter.get("schema"))?;
        let mut serialized = Vec::new();
        serialize_parameter(name, value, parameter, &mut serialized)?;
        let local_names: BTreeSet<_> = serialized.iter().map(|(key, _)| key.clone()).collect();
        if local_names.iter().any(|key| emitted_names.contains(key)) {
            return Err("authorization parameters serialize to duplicate query names".into());
        }
        emitted_names.extend(local_names);
        output.extend(serialized);
    }
    Ok(output)
}

fn resolve_parameter<'a>(document: &'a Value, parameter: &'a Value) -> Result<&'a Value, String> {
    let Some(reference) = parameter.get("$ref").and_then(Value::as_str) else {
        return Ok(parameter);
    };
    let pointer = reference
        .strip_prefix('#')
        .ok_or("authorization parameter references must be local")?;
    document
        .pointer(pointer)
        .ok_or_else(|| "authorization parameter reference does not resolve".into())
}

fn validate_schema(value: &Value, schema: Option<&Value>) -> Result<(), String> {
    let Some(schema) = schema.and_then(Value::as_object) else {
        return Err("authorization parameter schema is required".into());
    };
    const SUPPORTED: &[&str] = &[
        "type",
        "enum",
        "items",
        "properties",
        "required",
        "additionalProperties",
        "title",
        "description",
        "default",
        "example",
        "examples",
        "deprecated",
        "readOnly",
        "writeOnly",
    ];
    if schema.keys().any(|key| !SUPPORTED.contains(&key.as_str())) {
        return Err("authorization parameter schema uses unsupported keywords".into());
    }
    let valid_type = match schema.get("type").and_then(Value::as_str) {
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("number") => value.is_number(),
        Some("array") => {
            let values = value.as_array();
            values.is_some()
                && schema.get("items").is_some()
                && values.is_some_and(|values| {
                    values
                        .iter()
                        .all(|value| validate_schema(value, schema.get("items")).is_ok())
                })
        }
        Some("object") => {
            let Some(value) = value.as_object() else {
                return Err("authorization parameter value does not match its schema".into());
            };
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .ok_or("object authorization parameter requires properties")?;
            let required = schema
                .get("required")
                .map(|required| {
                    required
                        .as_array()
                        .ok_or("object schema required must be an array")?
                        .iter()
                        .map(|value| value.as_str().ok_or("invalid required property"))
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?
                .unwrap_or_default();
            let allows_additional =
                schema.get("additionalProperties").and_then(Value::as_bool) != Some(false);
            let known = value.iter().all(|(key, value)| {
                properties
                    .get(key)
                    .map(|schema| validate_schema(value, Some(schema)).is_ok())
                    .unwrap_or(allows_additional)
            });
            required.iter().all(|key| value.contains_key(*key))
                && (allows_additional || value.keys().all(|key| properties.contains_key(key)))
                && known
        }
        _ => false,
    };
    if !valid_type
        || schema
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|values| !values.contains(value))
    {
        return Err("authorization parameter value does not match its schema".into());
    }
    Ok(())
}

fn scalar(value: &Value) -> Result<String, String> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        _ => Err("authorization parameter contains a non-scalar value".into()),
    }
}

fn serialize_parameter(
    name: &str,
    value: &Value,
    parameter: &Value,
    output: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let style = parameter
        .get("style")
        .and_then(Value::as_str)
        .unwrap_or("form");
    let explode = parameter
        .get("explode")
        .and_then(Value::as_bool)
        .unwrap_or(style == "form");
    match value {
        Value::Array(values) => {
            let values = values.iter().map(scalar).collect::<Result<Vec<_>, _>>()?;
            if style == "form" && explode {
                output.extend(values.into_iter().map(|value| (name.to_owned(), value)));
            } else {
                let delimiter = match style {
                    "form" => ",",
                    "spaceDelimited" => " ",
                    "pipeDelimited" => "|",
                    _ => return Err("unsupported authorization parameter serialization".into()),
                };
                output.push((name.to_owned(), values.join(delimiter)));
            }
        }
        Value::Object(values) => {
            if style == "deepObject" {
                for (key, value) in values {
                    output.push((format!("{name}[{key}]"), scalar(value)?));
                }
            } else if style == "form" && explode {
                for (key, value) in values {
                    if RESERVED_AUTHORIZATION_PARAMETERS.contains(&key.as_str()) {
                        return Err(
                            "authorization object parameter expands to a reserved name".into()
                        );
                    }
                    output.push((key.clone(), scalar(value)?));
                }
            } else if style == "form" {
                let mut flattened = Vec::new();
                for (key, value) in values {
                    flattened.push(key.clone());
                    flattened.push(scalar(value)?);
                }
                output.push((name.to_owned(), flattened.join(",")));
            } else {
                return Err("unsupported authorization parameter serialization".into());
            }
        }
        _ if style == "form" => output.push((name.to_owned(), scalar(value)?)),
        _ => return Err("unsupported authorization parameter serialization".into()),
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientAuth {
    None,
    SecretPost,
    SecretBasic,
}
impl ClientAuth {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "none" => Ok(Self::None),
            "client_secret_post" => Ok(Self::SecretPost),
            "client_secret_basic" => Ok(Self::SecretBasic),
            _ => Err("unsupported client authentication method".into()),
        }
    }
    fn registered_name(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::SecretPost => "client_secret_post",
            Self::SecretBasic => "client_secret_basic",
        }
    }
}
#[derive(Clone, Debug)]
pub struct ConfiguredProvider {
    pub provider: Provider,
    pub client_id: String,
    pub client_secret: String,
    pub client_auth: ClientAuth,
}
impl ConfiguredProvider {
    pub fn token_request(
        &self,
        client: &reqwest::Client,
        params: &[(&str, &str)],
    ) -> reqwest::RequestBuilder {
        let mut form = params.to_vec();
        let mut request = client.post(&self.provider.token_url);
        if self.client_auth == ClientAuth::SecretBasic {
            // RFC 6749 section 2.3.1 requires form encoding before HTTP Basic encoding.
            let encode = |value: &str| {
                url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
            };
            request =
                request.basic_auth(encode(&self.client_id), Some(encode(&self.client_secret)));
        } else {
            form.push(("client_id", &self.client_id));
            if self.client_auth == ClientAuth::SecretPost {
                form.push(("client_secret", &self.client_secret));
            }
        }
        let operation = if params
            .iter()
            .any(|(key, value)| *key == "grant_type" && *value == "refresh_token")
        {
            self.provider
                .refresh_operation
                .as_ref()
                .or(self.provider.token_operation.as_ref())
        } else {
            self.provider.token_operation.as_ref()
        };
        if let Some(operation) = operation {
            if operation.requires_basic && self.client_auth != ClientAuth::SecretBasic {
                return request;
            }
            for (name, value) in &operation.headers {
                request = request.header(name, value);
            }
            if operation.json {
                let body = form
                    .into_iter()
                    .map(|(k, v)| (k.to_owned(), serde_json::Value::String(v.to_owned())))
                    .collect::<serde_json::Map<_, _>>();
                return request.json(&body).header("accept", "application/json");
            }
        }
        request.form(&form).header("accept", "application/json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document() -> Value {
        serde_json::json!({"components":{"securitySchemes":{"auth":{"type":"oauth2","flows":{"authorizationCode":{
            "authorizationUrl":"https://auth.example/authorize","tokenUrl":"https://auth.example/token",
            "scopes":{"read":"Read","write":"Write","unused":"Optional"}}}}}},
            "security":[{"auth":["read"]}],"paths":{"/records":{"get":{},"post":{"security":[{"auth":["write"]}]}}}})
    }
    #[test]
    fn required_scopes_follow_operation_overrides_without_requesting_all_supported_scopes() {
        let mut doc = document();
        assert_eq!(
            Provider::from_document(&doc, None).unwrap().scopes,
            ["read", "write"]
        );
        doc["paths"]["/records"]["post"]["security"] = serde_json::json!([]);
        assert_eq!(
            Provider::from_document(&doc, None).unwrap().scopes,
            ["read"]
        );
        doc["paths"]["/records"]["get"]["security"] = serde_json::json!([{}]);
        assert!(Provider::from_document(&doc, None)
            .unwrap()
            .scopes
            .is_empty());
    }
    #[test]
    fn rejects_invalid_endpoints_ambiguous_schemes_and_unknown_scopes() {
        for endpoint in [
            "http://auth.example/token",
            "https://secret@auth.example/token",
            "https://auth.example/token#fragment",
        ] {
            let mut doc = document();
            doc["components"]["securitySchemes"]["auth"]["flows"]["authorizationCode"]
                ["tokenUrl"] = endpoint.into();
            assert!(Provider::from_document(&doc, None).is_err());
        }
        let mut doc = document();
        doc["security"] = serde_json::json!([{"auth":["undeclared"]}]);
        assert!(Provider::from_document(&doc, None).is_err());
        let mut doc = document();
        doc["components"]["securitySchemes"]["second"] =
            doc["components"]["securitySchemes"]["auth"].clone();
        assert!(Provider::from_document(&doc, None).is_err());
    }
    #[test]
    fn trusted_scheme_selection_applies_fixed_parameters_and_pkce_capability() {
        let mut doc = document();
        doc["components"]["parameters"] = serde_json::json!({
            "accessType": {
                "name": "access_type", "in": "query",
                "schema": {"type": "string", "enum": ["online", "offline"]}
            },
            "audience": {
                "name": "audience", "in": "query", "style": "form", "explode": true,
                "schema": {"type": "array", "items": {"type": "string"}}
            }
        });
        let mut offline = doc["components"]["securitySchemes"]["auth"].clone();
        offline["x-oauth-authentication-details"] = serde_json::json!({
            "authorizationServerMetadata": {
                "token_endpoint_auth_methods_supported": ["client_secret_post"],
            },
            "authorizationCode": {
                "pkce": {"requirement": "unsupported"},
                "profile": {"parameters": [
                    {"parameter": {"$ref": "#/components/parameters/accessType"}, "value": "offline"},
                    {"parameter": {"$ref": "#/components/parameters/audience"}, "value": ["one", "two"]}
                ]}
            }
        });
        doc["components"]["securitySchemes"]["offline"] = offline;
        doc["security"] = serde_json::json!([{"offline":["read"]}]);
        doc["paths"]["/records"]["post"]["security"] = serde_json::json!([{"offline":["write"]}]);
        let provider = Provider::from_document(&doc, Some("offline")).unwrap();
        assert_eq!(
            provider.authorization_params,
            [
                ("access_type".into(), "offline".into()),
                ("audience".into(), "one".into()),
                ("audience".into(), "two".into())
            ]
        );
        assert!(!provider.use_pkce);
        assert_eq!(
            provider.supported_client_auth.unwrap(),
            vec!["client_secret_post".to_string()]
        );
        assert!(Provider::from_document(&doc, None).is_err());
        assert!(Provider::from_document(&doc, Some("missing")).is_err());
    }
    #[test]
    fn rejects_reserved_fixed_parameters_and_incompatible_pkce_metadata() {
        let mut doc = document();
        doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] = serde_json::json!({
            "authorizationCode": {
                "profile": {"parameters": [{
                    "parameter": {"name": "code_verifier", "in": "query", "schema": {"type": "string"}},
                    "value": "fixed"
                }]}
            }
        });
        assert!(Provider::from_document(&doc, None).is_err());

        doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] = serde_json::json!({
            "authorizationServerMetadata": {"code_challenge_methods_supported": ["plain"]},
            "authorizationCode": {"pkce": {"requirement": "required"}}
        });
        assert!(Provider::from_document(&doc, None).is_err());

        for details in [
            serde_json::json!({
                "authorizationServerMetadata": {"code_challenge_methods_supported": ["plain"]}
            }),
            serde_json::json!({
                "authorizationServerMetadata": {"code_challenge_methods_supported": ["S256"]},
                "authorizationCode": {"pkce": {"requirement": "unsupported"}}
            }),
            serde_json::json!({
                "authorizationServerMetadata": {"code_challenge_methods_supported": ["S256"]},
                "authorizationCode": {"pkce": {"requirement": "conditional"}}
            }),
            serde_json::json!({
                "authorizationCode": {"pkce": "required"}
            }),
        ] {
            let mut doc = document();
            doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] =
                details;
            assert!(Provider::from_document(&doc, None).is_err());
        }
    }

    #[test]
    fn rejects_authorization_query_collisions_and_unvalidated_schema_keywords() {
        let mut doc = document();
        doc["components"]["securitySchemes"]["auth"]["flows"]["authorizationCode"]
            ["authorizationUrl"] = "https://auth.example/authorize?state=fixed".into();
        assert!(Provider::from_document(&doc, None).is_err());

        let mut doc = document();
        doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] = serde_json::json!({"authorizationCode":{"profile":{"parameters":[
            {"parameter":{"name":"options","in":"query","style":"form","explode":true,
                "schema":{"type":"object","properties":{"access_type":{"type":"string"}}}},
             "value":{"access_type":"offline"}},
            {"parameter":{"name":"access_type","in":"query","schema":{"type":"string"}},
             "value":"online"}
        ]}}});
        assert!(Provider::from_document(&doc, None).is_err());

        let mut doc = document();
        doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] = serde_json::json!({"authorizationCode":{"profile":{"parameters":[{
            "parameter":{"name":"prompt","in":"query",
                "schema":{"type":"string","minLength":3}},
            "value":"consent"
        }]}}});
        assert!(Provider::from_document(&doc, None).is_err());

        let mut doc = document();
        doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] = serde_json::json!({"authorizationCode":{"profile":{"parameters":[{
            "parameter":{"name":"audience","in":"query",
                "schema":{"type":"array","items":{"type":"integer"}}},
            "value":["not-an-integer"]
        }]}}});
        assert!(Provider::from_document(&doc, None).is_err());
    }

    #[test]
    fn rejects_unimplemented_discovery_but_accepts_token_operation_semantics() {
        let mut doc = document();
        doc["components"]["securitySchemes"]["auth"]["oauth2MetadataUrl"] =
            "https://auth.example/.well-known/oauth-authorization-server".into();
        assert!(Provider::from_document(&doc, None).is_err());

        let mut doc = document();
        doc["servers"] = serde_json::json!([{"url":"https://auth.example"}]);
        doc["paths"]["/token"] = serde_json::json!({"post": {
            "requestBody": {"content": {"application/json": {"schema": {"type": "object"}}}},
            "parameters": [{"name": "Notion-Version", "in": "header", "schema": {"type":"string", "enum":["2026-03-11"]}}]
        }});
        doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] = serde_json::json!({"tokenEndpointOperation": "#/paths/~1token/post", "refreshEndpointOperation": "#/paths/~1token/post"});
        let provider = Provider::from_document(&doc, None).unwrap();
        let configured = ConfiguredProvider {
            provider,
            client_id: "client".into(),
            client_secret: "secret".into(),
            client_auth: ClientAuth::SecretBasic,
        };
        let request = configured
            .token_request(
                &reqwest::Client::new(),
                &[("grant_type", "authorization_code"), ("code", "abc")],
            )
            .build()
            .unwrap();
        assert_eq!(request.headers()["content-type"], "application/json");
        assert_eq!(request.headers()["notion-version"], "2026-03-11");
        assert!(
            String::from_utf8(request.body().unwrap().as_bytes().unwrap().to_vec())
                .unwrap()
                .contains("\"code\":\"abc\"")
        );
        doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"]
            ["tokenEndpointOperation"] = "#/paths/~1records/get".into();
        assert!(Provider::from_document(&doc, None).is_err());
    }
    #[test]
    fn default_client_auth_uses_metadata_order_and_preserves_overrides() {
        let mut doc = document();
        doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] = serde_json::json!({
            "authorizationServerMetadata": {
                "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"]
            }
        });
        let provider = Provider::from_document(&doc, None).unwrap();
        assert_eq!(provider.select_client_auth(None).unwrap(), ClientAuth::None);
        assert_eq!(
            provider
                .select_client_auth(Some("client_secret_basic"))
                .unwrap(),
            ClientAuth::SecretBasic
        );
        assert!(provider.select_client_auth(Some("unknown")).is_err());
    }

    #[test]
    fn default_client_auth_skips_unimplemented_methods_but_rejects_no_match() {
        let mut doc = document();
        for (methods, expected) in [
            (
                serde_json::json!(["private_key_jwt", "client_secret_basic", "none"]),
                Some(ClientAuth::SecretBasic),
            ),
            (
                serde_json::json!(["client_secret_basic"]),
                Some(ClientAuth::SecretBasic),
            ),
            (serde_json::json!(["private_key_jwt"]), None),
        ] {
            doc["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"] = serde_json::json!({
                "authorizationServerMetadata": {"token_endpoint_auth_methods_supported": methods}
            });
            let provider = Provider::from_document(&doc, None).unwrap();
            assert_eq!(provider.select_client_auth(None).ok(), expected);
            assert!(provider
                .select_client_auth(Some("client_secret_post"))
                .is_err());
        }
    }

    #[test]
    fn default_client_auth_respects_token_operations_and_legacy_fallback() {
        let mut provider = Provider::from_document(&document(), None).unwrap();
        assert_eq!(
            provider.select_client_auth(None).unwrap(),
            ClientAuth::SecretPost
        );
        provider.refresh_operation = Some(TokenOperation {
            json: true,
            headers: vec![],
            requires_basic: true,
        });
        assert_eq!(
            provider.select_client_auth(None).unwrap(),
            ClientAuth::SecretBasic
        );
        provider.supported_client_auth = Some(vec!["none".into(), "client_secret_basic".into()]);
        assert_eq!(
            provider.select_client_auth(None).unwrap(),
            ClientAuth::SecretBasic
        );
        assert!(provider.select_client_auth(Some("none")).is_err());
        provider.supported_client_auth = Some(vec!["none".into()]);
        assert!(provider.select_client_auth(None).is_err());
    }

    #[test]
    fn client_registration_selects_token_authentication_for_exchange_and_refresh() {
        use base64::Engine;
        for client_auth in [
            ClientAuth::None,
            ClientAuth::SecretPost,
            ClientAuth::SecretBasic,
        ] {
            let provider = ConfiguredProvider {
                provider: Provider::from_document(&document(), None).unwrap(),
                client_id: "client:id".into(),
                client_secret: "secret+value".into(),
                client_auth: client_auth.clone(),
            };
            for grant in ["authorization_code", "refresh_token"] {
                let request = provider
                    .token_request(&reqwest::Client::new(), &[("grant_type", grant)])
                    .build()
                    .unwrap();
                let form: std::collections::HashMap<_, _> =
                    url::form_urlencoded::parse(request.body().unwrap().as_bytes().unwrap())
                        .into_owned()
                        .collect();
                assert_eq!(form.get("grant_type").unwrap(), grant);
                assert_eq!(
                    form.contains_key("client_secret"),
                    client_auth == ClientAuth::SecretPost
                );
                assert_eq!(
                    form.contains_key("client_id"),
                    client_auth != ClientAuth::SecretBasic
                );
                if client_auth == ClientAuth::SecretBasic {
                    let header = request.headers()["authorization"].to_str().unwrap();
                    assert_eq!(
                        base64::engine::general_purpose::STANDARD
                            .decode(header.strip_prefix("Basic ").unwrap())
                            .unwrap(),
                        b"client%3Aid:secret%2Bvalue"
                    );
                } else {
                    assert!(!request.headers().contains_key("authorization"));
                }
            }
        }
        assert!(ClientAuth::parse("unknown").is_err());
    }

    fn api_key_document() -> Value {
        serde_json::json!({"components":{"securitySchemes":{"clockifyApiKey":{
            "type":"apiKey","in":"header","name":"X-Api-Key"}}},
            "security":[{"clockifyApiKey":[]}],
            "paths":{"/workspaces":{"get":{}}}})
    }

    #[test]
    fn api_key_scheme_reads_declared_name_and_location() {
        let scheme = ApiKeyScheme::from_document(&api_key_document(), None).unwrap();
        assert_eq!(scheme.name, "X-Api-Key");
        assert_eq!(scheme.location, ApiKeyLocation::Header);
    }

    #[test]
    fn api_key_scheme_supports_query_and_cookie_locations() {
        for (location, expected) in [
            ("query", ApiKeyLocation::Query),
            ("cookie", ApiKeyLocation::Cookie),
        ] {
            let mut doc = api_key_document();
            doc["components"]["securitySchemes"]["clockifyApiKey"]["in"] = location.into();
            assert_eq!(
                ApiKeyScheme::from_document(&doc, None).unwrap().location,
                expected
            );
        }
    }

    #[test]
    fn api_key_scheme_rejects_missing_name_unsupported_location_and_ambiguous_selection() {
        let mut doc = api_key_document();
        doc["components"]["securitySchemes"]["clockifyApiKey"]["name"] = "".into();
        assert!(ApiKeyScheme::from_document(&doc, None).is_err());

        let mut doc = api_key_document();
        doc["components"]["securitySchemes"]["clockifyApiKey"]["in"] = "body".into();
        assert!(ApiKeyScheme::from_document(&doc, None).is_err());

        let mut doc = api_key_document();
        doc["components"]["securitySchemes"]["second"] =
            doc["components"]["securitySchemes"]["clockifyApiKey"].clone();
        assert!(ApiKeyScheme::from_document(&doc, None).is_err());
        assert!(ApiKeyScheme::from_document(&doc, Some("missing")).is_err());
        assert_eq!(
            ApiKeyScheme::from_document(&doc, Some("second"))
                .unwrap()
                .name,
            "X-Api-Key"
        );
    }

    #[test]
    fn security_scheme_dispatches_generically_on_declared_type() {
        assert!(matches!(
            SecurityScheme::from_document(&document(), None, None).unwrap(),
            SecurityScheme::OAuth(_)
        ));
        assert!(matches!(
            SecurityScheme::from_document(&api_key_document(), None, None).unwrap(),
            SecurityScheme::ApiKey(_)
        ));
    }

    #[test]
    fn security_scheme_rejects_mixed_or_absent_scheme_types() {
        let mut mixed = document();
        mixed["components"]["securitySchemes"]["clockifyApiKey"] =
            api_key_document()["components"]["securitySchemes"]["clockifyApiKey"].clone();
        assert!(SecurityScheme::from_document(&mixed, None, None).is_err());

        let neither = serde_json::json!({"components":{"securitySchemes":{"basic":{
            "type":"http","scheme":"basic"}}}});
        assert!(SecurityScheme::from_document(&neither, None, None).is_err());
    }

    fn no_security_document() -> Value {
        serde_json::json!({"servers":[{"url":"https://pets.example/api"}],
            "security":[], "paths":{"/pets":{"get":{}}}})
    }

    #[test]
    fn an_explicit_empty_security_requirement_needs_no_credential() {
        assert_eq!(
            SecurityScheme::from_document(&no_security_document(), None, None),
            Ok(SecurityScheme::NoCredential)
        );
        // An empty scheme map and per-operation `security: []` are still none.
        let mut doc = no_security_document();
        doc["components"] = serde_json::json!({"securitySchemes": {}});
        doc["paths"]["/pets"]["get"]["security"] = serde_json::json!([]);
        assert_eq!(
            SecurityScheme::from_document(&doc, None, None),
            Ok(SecurityScheme::NoCredential)
        );
    }

    #[test]
    fn a_document_that_does_not_opt_out_explicitly_still_needs_a_scheme() {
        // No `security` at all: e.g. a base document whose auth overlay is
        // missing. Refused, never connected without credentials.
        let mut silent = no_security_document();
        silent.as_object_mut().unwrap().remove("security");
        assert!(SecurityScheme::from_document(&silent, None, None).is_err());
        // `security: []` next to a declared scheme is not an opt-out.
        let mut declared = api_key_document();
        declared["security"] = serde_json::json!([]);
        assert!(matches!(
            SecurityScheme::from_document(&declared, None, None),
            Ok(SecurityScheme::ApiKey(_))
        ));
        // Nor is one operation that requires a scheme.
        let mut operation = no_security_document();
        operation["paths"]["/pets"]["get"]["security"] = serde_json::json!([{"key": []}]);
        assert!(SecurityScheme::from_document(&operation, None, None).is_err());
        // A non-array top-level `security` is not an opt-out either.
        let mut malformed = no_security_document();
        malformed["security"] = serde_json::json!({});
        assert!(SecurityScheme::from_document(&malformed, None, None).is_err());
    }

    #[test]
    fn composed_notion_fixture_builds_json_token_request() {
        let document: Value =
            serde_yaml::from_str(include_str!("../tests/fixtures/notion-composed.yaml")).unwrap();
        let provider = Provider::from_document(&document, Some("notionOAuth")).unwrap();
        let client_auth = provider.select_client_auth(None).unwrap();
        assert_eq!(client_auth, ClientAuth::SecretBasic);
        let configured = ConfiguredProvider {
            provider,
            client_id: "id".into(),
            client_secret: "secret".into(),
            client_auth,
        };
        let request = configured
            .token_request(
                &reqwest::Client::new(),
                &[
                    ("grant_type", "authorization_code"),
                    ("code", "abc"),
                    ("redirect_uri", "https://example/cb"),
                ],
            )
            .build()
            .unwrap();
        assert_eq!(request.headers()["content-type"], "application/json");
        assert_eq!(request.headers()["notion-version"], "2026-03-11");
        assert!(
            String::from_utf8(request.body().unwrap().as_bytes().unwrap().to_vec())
                .unwrap()
                .contains("\"grant_type\":\"authorization_code\"")
        );
    }
}
