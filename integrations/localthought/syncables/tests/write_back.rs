//! `SyncClient::create`/`update`/`remove` — the write-back prototype for
//! [issue #9](https://github.com/localthought/syncables-rs/issues/9) — against
//! a Moneybird-shaped `contact` resource (mirroring `moneybird_fixture.rs`'s
//! `administration_id`-scoped collections), exercised with a [`Fetch`] test
//! double rather than a live server.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use syncables::client::client::{Fetch, HttpRequest, HttpResponse};
use syncables::{
    ClientConfig, Credentials, InMemoryStorage, Record, RecordAddress, Storage, SyncClient,
    SyncError,
};

/// A [`Fetch`] test double keyed by exact `(method, URL)`, recording every
/// request (body included) it received.
#[derive(Default)]
struct RecordingFetch {
    responses: HashMap<(String, String), (u16, Value)>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl RecordingFetch {
    fn respond_json(mut self, method: &str, url: &str, status: u16, body: Value) -> Self {
        self.responses
            .insert((method.to_string(), url.to_string()), (status, body));
        self
    }

    fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl Fetch for RecordingFetch {
    async fn fetch(&self, request: HttpRequest) -> syncables::Result<HttpResponse> {
        let key = (request.method.clone(), request.url.clone());
        self.requests.lock().unwrap().push(request.clone());
        match self.responses.get(&key) {
            Some((status, body)) => Ok(HttpResponse {
                status: *status,
                headers: Default::default(),
                body: serde_json::to_vec(body).unwrap(),
            }),
            None => Err(syncables::Error::Http(format!(
                "no mock response registered for {} {}",
                request.method, request.url
            ))),
        }
    }
}

/// A `contact` resource scoped under `administration_id`, the way real
/// Moneybird collections are (see `moneybird_fixture.rs`): a create
/// (`POST .../contacts.json`, `id` server-assigned via `addedFields`), an
/// update on `.../contacts/{id}.json` — `patch`-mode with merge semantics
/// when `update_method` is `"patch"`, default PUT semantics otherwise — and
/// a delete on the same item URL.
fn contact_document(update_method: &str) -> Value {
    let mut update_operation = json!({
        "x-crud": { "action": "update", "resource": "contact" }
    });
    if update_method == "patch" {
        update_operation["x-crud"]["mode"] = json!("patch");
        update_operation["x-crud"]["patchFormat"] = json!("merge");
    }
    let mut item_path = json!({
        "delete": {
            "x-crud": { "action": "delete", "resource": "contact", "removesFrom": "*" }
        }
    });
    item_path[update_method] = update_operation;

    json!({
        "openapi": "3.0.3",
        "info": { "title": "Moneybird", "version": "1" },
        "servers": [{ "url": "https://moneybird.example/api/v2" }],
        "paths": {
            "/{administration_id}/contacts.json": {
                "get": { "responses": { "200": { "content": { "application/json": { "schema": { "type": "array", "items": { "type": "object" } } } } } } },
                "post": {
                    "x-crud": {
                        "action": "create",
                        "resource": "contact",
                        "collection": "contacts",
                        "addedFields": { "id": {} }
                    }
                }
            },
            "/{administration_id}/contacts/{id}.json": item_path
        },
        "components": {
            "crudResources": {
                "contact": {
                    "identity": {
                        "urlTemplate": "/{administration_id}/contacts/{id}.json",
                        "bindings": { "id": { "field": "id" } }
                    },
                    "collections": {
                        "contacts": { "urlTemplate": "/{administration_id}/contacts.json" }
                    }
                }
            }
        }
    })
}

fn client(fetch: Arc<RecordingFetch>) -> SyncClient {
    SyncClient::new(
        ClientConfig {
            document: "unused".into(),
            overlays: vec![],
            credentials: Credentials::Anonymous,
            constants: BTreeMap::new(),
            ontology_base_url: "https://ontology.example/moneybird".to_string(),
        },
        fetch,
    )
    .unwrap()
}

fn administration_context() -> BTreeMap<String, String> {
    BTreeMap::from([("administration_id".to_string(), "admin-1".to_string())])
}

#[tokio::test]
async fn create_sends_a_post_and_merges_only_added_fields_into_the_stored_record() {
    let document: syncables::OpenApiDocument =
        serde_json::from_value(contact_document("put")).unwrap();
    let fetch = Arc::new(RecordingFetch::default().respond_json(
        "POST",
        "https://moneybird.example/api/v2/admin-1/contacts.json",
        201,
        // The server also echoes back `company_name` — proving the
        // client-sent value stays authoritative for anything not declared
        // under `addedFields`, unlike the server-assigned `id`.
        json!({ "id": "42", "company_name": "Server Co" }),
    ));
    let client = client(fetch.clone());

    let storage = InMemoryStorage::new();
    let mut fields = Map::new();
    fields.insert("company_name".to_string(), json!("Acme Inc"));
    let record = client
        .create_document(
            &document,
            "contact",
            "contacts",
            &administration_context(),
            fields,
            &storage,
        )
        .await
        .expect("create succeeds");

    assert_eq!(record.namespace, "admin-1");
    assert_eq!(record.id, "42");
    assert_eq!(record.value.get("id"), Some(&json!("42")));
    assert_eq!(record.value.get("company_name"), Some(&json!("Acme Inc")));

    let stored = storage
        .get("admin-1", "contact", "42")
        .await
        .unwrap()
        .expect("record present");
    assert_eq!(stored, record);

    let requests = fetch.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    let sent: Value = serde_json::from_slice(requests[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(sent, json!({ "company_name": "Acme Inc" }));
}

#[tokio::test]
async fn create_errors_when_no_create_operation_is_declared() {
    let mut document = contact_document("put");
    document["paths"]["/{administration_id}/contacts.json"]
        .as_object_mut()
        .unwrap()
        .remove("post");
    let document: syncables::OpenApiDocument = serde_json::from_value(document).unwrap();
    let client = client(Arc::new(RecordingFetch::default()));

    let storage = InMemoryStorage::new();
    let error = client
        .create_document(
            &document,
            "contact",
            "contacts",
            &administration_context(),
            Map::new(),
            &storage,
        )
        .await
        .expect_err("no create operation declared");
    assert!(matches!(error, SyncError::Document(message) if message.contains("create operation")));
}

#[tokio::test]
async fn update_sends_a_merge_patch_body_and_overlays_the_response() {
    let document: syncables::OpenApiDocument =
        serde_json::from_value(contact_document("patch")).unwrap();
    let fetch = Arc::new(RecordingFetch::default().respond_json(
        "PATCH",
        "https://moneybird.example/api/v2/admin-1/contacts/42.json",
        200,
        json!({ "company_name": "New name", "updated_at": "2026-01-01" }),
    ));
    let client = client(fetch.clone());

    let storage = InMemoryStorage::new();
    storage
        .put(&Record {
            namespace: "admin-1".to_string(),
            resource: "contact".to_string(),
            id: "42".to_string(),
            value: json!({ "id": "42", "company_name": "Old name", "tax_number": "NL123" })
                .as_object()
                .unwrap()
                .clone(),
        })
        .await
        .unwrap();

    let mut changes = Map::new();
    changes.insert("company_name".to_string(), json!("New name"));
    let context = administration_context();
    let record = client
        .update_document(
            &document,
            &RecordAddress {
                resource: "contact",
                namespace: "admin-1",
                id: "42",
                context: &context,
            },
            changes,
            &storage,
        )
        .await
        .expect("update succeeds");

    // A merge patch: only the change, not the whole locally-known record.
    let requests = fetch.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "PATCH");
    let sent: Value = serde_json::from_slice(requests[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(sent, json!({ "company_name": "New name" }));

    // Keeps what neither the change nor the response touched
    // (`tax_number`), takes the change (also confirmed by the response),
    // and picks up what only the response reported (`updated_at`).
    assert_eq!(record.value.get("tax_number"), Some(&json!("NL123")));
    assert_eq!(record.value.get("company_name"), Some(&json!("New name")));
    assert_eq!(record.value.get("updated_at"), Some(&json!("2026-01-01")));
}

#[tokio::test]
async fn update_defaults_to_put_semantics_with_the_full_record() {
    let document: syncables::OpenApiDocument =
        serde_json::from_value(contact_document("put")).unwrap();
    let fetch = Arc::new(RecordingFetch::default().respond_json(
        "PUT",
        "https://moneybird.example/api/v2/admin-1/contacts/42.json",
        200,
        json!({}),
    ));
    let client = client(fetch.clone());

    let storage = InMemoryStorage::new();
    storage
        .put(&Record {
            namespace: "admin-1".to_string(),
            resource: "contact".to_string(),
            id: "42".to_string(),
            value: json!({ "id": "42", "company_name": "Old name", "tax_number": "NL123" })
                .as_object()
                .unwrap()
                .clone(),
        })
        .await
        .unwrap();

    let mut changes = Map::new();
    changes.insert("company_name".to_string(), json!("New name"));
    let context = administration_context();
    client
        .update_document(
            &document,
            &RecordAddress {
                resource: "contact",
                namespace: "admin-1",
                id: "42",
                context: &context,
            },
            changes,
            &storage,
        )
        .await
        .expect("update succeeds");

    let requests = fetch.requests();
    assert_eq!(requests[0].method, "PUT");
    let sent: Value = serde_json::from_slice(requests[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(
        sent,
        json!({ "id": "42", "company_name": "New name", "tax_number": "NL123" })
    );
}

#[tokio::test]
async fn remove_sends_delete_and_removes_the_local_record() {
    let document: syncables::OpenApiDocument =
        serde_json::from_value(contact_document("put")).unwrap();
    let fetch = Arc::new(RecordingFetch::default().respond_json(
        "DELETE",
        "https://moneybird.example/api/v2/admin-1/contacts/42.json",
        204,
        json!(null),
    ));
    let client = client(fetch.clone());

    let storage = InMemoryStorage::new();
    storage
        .put(&Record {
            namespace: "admin-1".to_string(),
            resource: "contact".to_string(),
            id: "42".to_string(),
            value: json!({ "id": "42" }).as_object().unwrap().clone(),
        })
        .await
        .unwrap();

    let context = administration_context();
    client
        .remove_document(
            &document,
            &RecordAddress {
                resource: "contact",
                namespace: "admin-1",
                id: "42",
                context: &context,
            },
            &storage,
        )
        .await
        .expect("remove succeeds");

    assert_eq!(fetch.requests()[0].method, "DELETE");
    assert!(storage
        .get("admin-1", "contact", "42")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn remove_leaves_the_local_record_when_the_request_fails() {
    let document: syncables::OpenApiDocument =
        serde_json::from_value(contact_document("put")).unwrap();
    let fetch = Arc::new(RecordingFetch::default().respond_json(
        "DELETE",
        "https://moneybird.example/api/v2/admin-1/contacts/42.json",
        403,
        json!({}),
    ));
    let client = client(fetch.clone());

    let storage = InMemoryStorage::new();
    storage
        .put(&Record {
            namespace: "admin-1".to_string(),
            resource: "contact".to_string(),
            id: "42".to_string(),
            value: json!({ "id": "42" }).as_object().unwrap().clone(),
        })
        .await
        .unwrap();

    let context = administration_context();
    let error = client
        .remove_document(
            &document,
            &RecordAddress {
                resource: "contact",
                namespace: "admin-1",
                id: "42",
                context: &context,
            },
            &storage,
        )
        .await
        .expect_err("delete rejected");
    assert!(matches!(error, SyncError::Transport(message) if message.contains("403")));
    assert!(storage
        .get("admin-1", "contact", "42")
        .await
        .unwrap()
        .is_some());
}
