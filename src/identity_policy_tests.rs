use serde_json::{json, Value};

use crate::{catalog::Catalog, identity, tenant_secret};

fn selection(namespace: &str) -> Value {
    json!({"oauthSecurityScheme":"oauth", "tenantIdentity":{"operationId":"identity","namespace":namespace}})
}

fn document() -> Value {
    json!({"servers":[{"url":"https://api.example/v1"}],"components":{"securitySchemes":{"oauth":{"type":"oauth2","flows":{"authorizationCode":{"authorizationUrl":"https://auth.example/a","tokenUrl":"https://auth.example/t","scopes":{"identity":"identity"}}}}}},"paths":{"/me":{"get":{"operationId":"identity","security":[{"oauth":["identity"]}],"x-authenticated-principal":{"kind":"user","namespace":"https://issuer.example/tenant","subject":"$response.body#/id","identifier":{"scope":"provider","stable":true,"reassigned":false},"claims":{"email_verified":"$response.body#/verified"}}}}}})
}

fn operation(document: Value) -> identity::IdentityOperation {
    identity::parse(&document, &selection("https://issuer.example/tenant")).unwrap()
}

#[test]
fn canonical_identity_preserves_namespace_client_and_json_type() {
    let identity_op = operation(document());
    let string = identity::resolve(&identity_op, &json!({"id":"7"}), "a").unwrap();
    let number = identity::resolve(&identity_op, &json!({"id":7}), "a").unwrap();
    assert_ne!(string.canonical(), number.canonical());
    let mut other = document();
    other["paths"]["/me"]["get"]["x-authenticated-principal"]["namespace"] =
        json!("https://issuer.example/other");
    let other = identity::parse(&other, &selection("https://issuer.example/other")).unwrap();
    assert_ne!(
        string.canonical(),
        identity::resolve(&other, &json!({"id":"7"}), "a")
            .unwrap()
            .canonical()
    );
    let mut client = document();
    client["paths"]["/me"]["get"]["x-authenticated-principal"]["identifier"]["scope"] =
        json!("client");
    let client = operation(client);
    assert_ne!(
        identity::resolve(&client, &json!({"id":"7"}), "a")
            .unwrap()
            .canonical(),
        identity::resolve(&client, &json!({"id":"7"}), "b")
            .unwrap()
            .canonical()
    );
}

#[test]
fn legacy_mapping_is_exact_and_reserved_prefix_is_refused() {
    let op = operation(document());
    let identity = identity::resolve(&op, &json!({"id":"historic"}), "client").unwrap();
    let legacy = identity
        .legacy_subject_if_matches(Some("https://issuer.example/tenant"))
        .unwrap()
        .unwrap();
    assert_eq!(
        tenant_secret::derive("secret", &legacy),
        tenant_secret::derive("secret", "historic")
    );
    assert_eq!(
        identity.legacy_subject_if_matches(Some("https://other.example")),
        Ok(None)
    );
    let reserved = identity::resolve(&op, &json!({"id":"tenant:v1:forged"}), "client").unwrap();
    assert!(reserved
        .legacy_subject_if_matches(Some("https://issuer.example/tenant"))
        .is_err());
}

#[test]
fn subject_and_declaration_fail_closed() {
    let op = operation(document());
    for value in [
        json!(null),
        json!(""),
        json!(1.5),
        json!({"id":1}),
        json!([]),
    ] {
        assert!(identity::resolve(&op, &json!({"id":value}), "client").is_err());
    }
    assert!(identity::resolve(&op, &json!({}), "client").is_err());
    let mut bad = document();
    bad["paths"]["/me"]["get"]["x-authenticated-principal"]["claims"]["email_verified"] =
        json!("$response.body#/bad~2pointer");
    assert!(identity::parse(&bad, &selection("https://issuer.example/tenant")).is_err());
    bad = document();
    bad["paths"]["/me"]["get"]["x-authenticated-principal"]["extra"] = json!(true);
    assert!(identity::parse(&bad, &selection("https://issuer.example/tenant")).is_err());
    assert!(identity::parse(&document(), &selection("https://issuer.example/other")).is_err());
}

#[test]
fn catalog_rejects_anonymous_identity_and_unsafe_operation_shape() {
    let mut anonymous = document();
    anonymous["paths"]["/me"]["get"]["security"] = json!([{}, {"oauth":["identity"]}]);
    assert!(Catalog::from_test_document(
        "x",
        anonymous,
        selection("https://issuer.example/tenant")
    )
    .tenant_identity("x")
    .is_err());
    for server in [
        "https://api.example/{tenant}",
        "https://api.example/?q=1",
        "https://api.example/#fragment",
    ] {
        let mut unsafe_doc = document();
        unsafe_doc["servers"][0]["url"] = json!(server);
        assert!(identity::parse(&unsafe_doc, &selection("https://issuer.example/tenant")).is_err());
    }
    let mut params = document();
    params["paths"]["/me"]["get"]["parameters"] = json!([{"name":"x","in":"query"}]);
    assert!(identity::parse(&params, &selection("https://issuer.example/tenant")).is_err());
    params["paths"]["/me"]["get"]["parameters"] = json!([]);
    assert!(identity::parse(&params, &selection("https://issuer.example/tenant")).is_ok());
    let mut root = document();
    root["paths"]["/me"]["get"]["x-authenticated-principal"]["subject"] = json!("$response.body#");
    assert!(identity::parse(&root, &selection("https://issuer.example/tenant")).is_ok());
}
