//! Resolves a tenant identity from a catalog-selected authenticated API operation.
//!
//! The OpenAPI declaration describes a capability only.  The catalog selection is
//! the trust decision: without `selection.tenantIdentity`, this module never
//! treats an API response as a tenant identity.
use serde_json::Value;
use url::Url;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TenantIdentity {
    pub namespace: String,
    pub subject: String,
    pub scope: IdentityScope,
    pub client_id: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub picture: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IdentityScope {
    Provider,
    Client,
}

impl TenantIdentity {
    /// A deliberately unambiguous, versioned wire identity. JSON string
    /// quoting preserves the distinction between an integer subject and its
    /// textual look-alike before it reaches this canonical form.
    pub fn canonical(&self) -> String {
        // JSON is the encoding, not a delimiter-separated convention: this
        // keeps `7` and `"7"` distinct and makes every field unambiguous.
        format!(
            "tenant:v1:{}",
            serde_json::json!({"namespace": self.namespace, "scope": self.scope_name(), "client": self.client_id, "subject": serde_json::from_str::<Value>(&self.subject).expect("subject is serialized JSON")})
        )
    }
    pub fn legacy_subject_if_matches(
        &self,
        namespace: Option<&str>,
    ) -> Result<Option<String>, String> {
        (matches!(self.scope, IdentityScope::Provider)
            && namespace == Some(self.namespace.as_str()))
        .then(|| serde_json::from_str::<String>(&self.subject).ok())
        .flatten()
        .map_or(Ok(None), |subject| {
            (!subject.starts_with("tenant:v1:"))
                .then_some(subject)
                .ok_or_else(|| "legacy identity subject uses reserved tenant:v1: prefix".into())
                .map(Some)
        })
    }
    fn scope_name(&self) -> &'static str {
        match self.scope {
            IdentityScope::Provider => "provider",
            IdentityScope::Client => "client",
        }
    }
}

#[derive(Clone, Debug)]
pub struct IdentityOperation {
    pub url: Url,
    pub namespace: String,
    pub scope: IdentityScope,
    pub subject: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub picture: Option<String>,
}

fn expression(value: &Value, name: &str) -> Result<String, String> {
    let value = value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("x-authenticated-principal.{name} must be a string expression"))?;
    let pointer = value.strip_prefix("$response.body#").ok_or_else(|| {
        format!("x-authenticated-principal.{name} must start with $response.body#")
    })?;
    if (!pointer.is_empty() && !pointer.starts_with('/'))
        || pointer.split('/').skip(1).any(|part| {
            part.bytes().enumerate().any(|(i, byte)| {
                byte == b'~' && !matches!(part.as_bytes().get(i + 1), Some(b'0' | b'1'))
            })
        })
    {
        return Err(format!(
            "x-authenticated-principal.{name} must select a response field"
        ));
    }
    Ok(pointer.to_owned())
}

fn optional_expression(value: &Value, name: &str) -> Result<Option<String>, String> {
    match value.get(name) {
        None => Ok(None),
        Some(_) => expression(value, name).map(Some),
    }
}

fn fixed_https_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "identity server URL is invalid")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
        || value.contains('{')
    {
        return Err("identity endpoint must be a fixed credential-free HTTPS URL".into());
    }
    Ok(url)
}

/// Parses a selected operation. This accepts no OpenAPI parameters: omitting a
/// declared parameter is unsafe because it can silently change which principal
/// the provider returns. A later metadata revision can add explicit bindings.
pub fn parse(document: &Value, selection: &Value) -> Result<IdentityOperation, String> {
    let selection = selection
        .get("tenantIdentity")
        .and_then(Value::as_object)
        .ok_or("tenantIdentity selection is required")?;
    let operation_id = selection
        .get("operationId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("tenantIdentity.operationId must be a nonempty string")?;
    let namespace = selection
        .get("namespace")
        .and_then(Value::as_str)
        .ok_or("tenantIdentity.namespace must be an HTTPS URI")?;
    let _namespace_url = fixed_https_url(namespace)?;
    let mut found = None;
    for (path, item) in document
        .get("paths")
        .and_then(Value::as_object)
        .ok_or("OpenAPI document has no paths")?
    {
        let item = item.as_object().ok_or("invalid path item")?;
        for method in [
            "get", "post", "put", "patch", "delete", "head", "options", "trace",
        ] {
            let Some(operation) = item.get(method).and_then(Value::as_object) else {
                continue;
            };
            if operation.get("operationId").and_then(Value::as_str) == Some(operation_id)
                && found
                    .replace((path.as_str(), item, operation, method))
                    .is_some()
            {
                return Err(
                    "tenantIdentity.operationId must identify exactly one operation".into(),
                );
            }
        }
    }
    let Some((path, item, operation, method)) = found else {
        return Err("tenantIdentity.operationId does not resolve".into());
    };
    let has_parameters = |value: Option<&Value>| match value {
        None => Ok(false),
        Some(Value::Array(parameters)) => Ok(!parameters.is_empty()),
        Some(_) => Err("tenant identity operation parameters must be an array"),
    };
    if !path.starts_with('/')
        || path.contains('{')
        || has_parameters(operation.get("parameters"))?
        || has_parameters(item.get("parameters"))?
    {
        return Err("tenant identity operation must be a fixed GET without parameters".into());
    }
    if !operation.get("x-authenticated-principal").is_some() {
        return Err("selected identity operation lacks x-authenticated-principal".into());
    }
    // Identity lookup must be an authenticated read. Other methods can create
    // side effects merely by resolving a principal.
    if method != "get" {
        return Err("tenant identity operation must use GET".into());
    }
    let principal = operation.get("x-authenticated-principal").unwrap();
    let principal = principal
        .as_object()
        .ok_or("x-authenticated-principal must be an object")?;
    if principal.keys().any(|key| {
        !matches!(
            key.as_str(),
            "kind" | "namespace" | "subject" | "identifier" | "claims"
        )
    }) {
        return Err("x-authenticated-principal contains unsupported fields".into());
    }
    if principal.get("kind").and_then(Value::as_str) != Some("user") {
        return Err("x-authenticated-principal.kind must be user".into());
    }
    if principal.get("namespace").and_then(Value::as_str) != Some(namespace) {
        return Err(
            "x-authenticated-principal.namespace must exactly match tenantIdentity.namespace"
                .into(),
        );
    }
    let identity = principal
        .get("identifier")
        .and_then(Value::as_object)
        .ok_or("x-authenticated-principal.identifier must be an object")?;
    if identity
        .keys()
        .any(|key| !matches!(key.as_str(), "scope" | "stable" | "reassigned"))
    {
        return Err("x-authenticated-principal.identifier contains unsupported fields".into());
    }
    if identity.get("stable").and_then(Value::as_bool) != Some(true)
        || identity.get("reassigned").and_then(Value::as_bool) != Some(false)
    {
        return Err("tenant identity identifiers must be stable and never reassigned".into());
    }
    let scope = match identity.get("scope").and_then(Value::as_str) {
        Some("provider") => IdentityScope::Provider,
        Some("client") => IdentityScope::Client,
        _ => return Err("tenant identity identifier.scope must be provider or client".into()),
    };
    let server = operation
        .get("servers")
        .or_else(|| item.get("servers"))
        .or_else(|| document.get("servers"))
        .and_then(Value::as_array)
        .and_then(|s| s.first())
        .and_then(|s| s.get("url"))
        .and_then(Value::as_str)
        .ok_or("identity operation needs a server URL")?;
    let mut url = fixed_https_url(server)?;
    let base = url.path().trim_end_matches('/');
    url.set_path(&format!("{base}{path}"));
    let subject = expression(&Value::Object(principal.clone()), "subject")?;
    let claims = match principal.get("claims") {
        None => serde_json::Map::new(),
        Some(value) => value
            .as_object()
            .ok_or("x-authenticated-principal.claims must be an object")?
            .clone(),
    };
    if claims.keys().any(|key| {
        !matches!(
            key.as_str(),
            "name" | "email" | "picture" | "email_verified"
        )
    }) {
        return Err("x-authenticated-principal.claims contains unsupported fields".into());
    }
    let claims = Value::Object(claims);
    // This claim is display-policy metadata for now, but parsing it here keeps
    // malformed declarations from being silently accepted as trusted identity
    // metadata.
    let _email_verified = optional_expression(&claims, "email_verified")?;
    Ok(IdentityOperation {
        url,
        namespace: namespace.into(),
        scope,
        subject,
        name: optional_expression(&claims, "name")?,
        email: optional_expression(&claims, "email")?,
        picture: optional_expression(&claims, "picture")?,
    })
}

pub fn resolve(
    operation: &IdentityOperation,
    body: &Value,
    client_id: &str,
) -> Result<TenantIdentity, String> {
    let select = |pointer: &str| body.pointer(pointer).cloned();
    let subject = match select(&operation.subject) {
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 512 => {
            serde_json::to_string(&value).unwrap()
        }
        Some(Value::Number(value)) if value.is_i64() || value.is_u64() => {
            serde_json::to_string(&value).unwrap()
        }
        _ => return Err("identity subject must be a nonempty string or integer".into()),
    };
    let display = |pointer: Option<&String>| {
        pointer.and_then(|p| select(p)).and_then(|v| {
            v.as_str()
                .filter(|value| value.len() <= 512)
                .map(str::to_owned)
        })
    };
    Ok(TenantIdentity {
        namespace: operation.namespace.clone(),
        subject,
        client_id: matches!(operation.scope, IdentityScope::Client).then(|| client_id.to_owned()),
        scope: operation.scope.clone(),
        name: display(operation.name.as_ref()),
        email: display(operation.email.as_ref()),
        picture: display(operation.picture.as_ref()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn doc() -> Value {
        serde_json::json!({"servers":[{"url":"https://api.example/v1"}],"paths":{"/me":{"get":{"operationId":"me","x-authenticated-principal":{"kind":"user","namespace":"https://issuer.example/tenant","subject":"$response.body#/id","identifier":{"scope":"provider","stable":true,"reassigned":false},"claims":{"name":"$response.body#/name","email":"$response.body#/email"}}}}}})
    }
    fn selected() -> Value {
        serde_json::json!({"tenantIdentity":{"operationId":"me","namespace":"https://issuer.example/tenant"}})
    }
    #[test]
    fn selection_and_declaration_are_both_required() {
        assert!(parse(&doc(), &selected()).is_ok());
        assert!(parse(&doc(), &serde_json::json!({})).is_err());
        let mut d = doc();
        d["paths"]["/me"]["get"]
            .as_object_mut()
            .unwrap()
            .remove("x-authenticated-principal");
        assert!(parse(&d, &selected()).is_err());
    }
    #[test]
    fn canonical_identity_preserves_subject_types() {
        let op = parse(&doc(), &selected()).unwrap();
        let string = resolve(&op, &serde_json::json!({"id":"7"}), "client").unwrap();
        let number = resolve(&op, &serde_json::json!({"id":7}), "client").unwrap();
        assert_ne!(string.canonical(), number.canonical());
    }
    #[test]
    fn scalar_response_root_is_a_valid_subject_expression() {
        let mut document = doc();
        document["paths"]["/me"]["get"]["x-authenticated-principal"]["subject"] =
            "$response.body#".into();
        let operation = parse(&document, &selected()).unwrap();
        assert!(resolve(&operation, &serde_json::json!(7), "client").is_ok());
    }
    #[test]
    fn rejects_dynamic_or_unsafe_endpoint() {
        let mut d = doc();
        d["servers"][0]["url"] = "http://api.example/{version}".into();
        assert!(parse(&d, &selected()).is_err());
        d = doc();
        d["paths"]["/me"]["get"]["parameters"] =
            serde_json::json!([{"name":"page","in":"query","required":true}]);
        assert!(parse(&d, &selected()).is_err());
    }
}
