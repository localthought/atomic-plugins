//! Managing connections, delegations and runtimes (issue #54, sections 2
//! and 6). Every call is signed (Atomic v2) by the owner.
//!
//! | route | effect |
//! |---|---|
//! | `GET /connections` | the signer's connections, delegations and runtimes |
//! | `DELETE /connections/{id}` | deletes the connection and its delegations |
//! | `POST /connections/{id}/agents` `{agent, label?}` | delegates the connection to an app agent |
//! | `DELETE /connections/{id}/agents/{agent}` | removes that delegation |
//! | `POST /runtimes` `{app, agent, label?}` | registers a node's app agent as a runtime of installation `app` |
//! | `DELETE /runtimes/{agent}` | removes that runtime |
//!
//! Agent ids in bodies and paths may use any accepted spelling; they are
//! stored and returned canonical (`atomic:agent:<base64url>`). Changes take
//! effect on the next proxied request.
use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::{agent_id, api_error::ApiError, security::Security, AppState};

const MAX_LABEL: usize = 200;

struct Signed<'a> {
    security: &'a Security,
    signer: agent_id::AgentId,
}

async fn signed<'a>(
    state: &'a AppState,
    method: &Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Signed<'a>, ApiError> {
    let security = state.security.as_ref().ok_or(ApiError::Unavailable)?;
    let signer =
        crate::signature::authenticate(state, security, method, uri, headers, body).await?;
    crate::check_access(state, &signer).await?;
    Ok(Signed { security, signer })
}

/// Loads a connection and checks the signer owns it.
async fn owned(signed: &Signed<'_>, connection_id: &str) -> Result<(), ApiError> {
    if connection_id.len() != 43 {
        return Err(ApiError::UnknownConnection);
    }
    let record = signed
        .security
        .load_connection(connection_id)
        .await
        .map_err(|_| ApiError::Unavailable)?
        .ok_or(ApiError::UnknownConnection)?;
    if record.owner != signed.signer.as_str() {
        return Err(ApiError::NotOwner);
    }
    Ok(())
}

fn agent(id: &str) -> Result<agent_id::AgentId, ApiError> {
    agent_id::parse(id).ok_or(ApiError::BadRequest("agent must be an atomic:agent id"))
}

fn label(label: Option<String>) -> Result<Option<String>, ApiError> {
    match label {
        Some(label) if label.chars().count() > MAX_LABEL => {
            Err(ApiError::BadRequest("label is longer than 200 characters"))
        }
        other => Ok(other),
    }
}

fn respond(result: Result<Response, ApiError>) -> Response {
    let mut response = result.unwrap_or_else(IntoResponse::into_response);
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    response
}

/// `GET /connections`
pub async fn list(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    respond(
        async {
            let signed = signed(&state, &method, &uri, &headers, &body).await?;
            let (connections, runtimes) = signed
                .security
                .list_for_owner(signed.signer.as_str())
                .await
                .map_err(|_| ApiError::Unavailable)?;
            Ok(Json(serde_json::json!({
                "owner": signed.signer.as_str(),
                "connections": connections,
                "runtimes": runtimes,
            }))
            .into_response())
        }
        .await,
    )
}

/// `DELETE /connections/{id}`
pub async fn delete(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    respond(
        async {
            let signed = signed(&state, &method, &uri, &headers, &body).await?;
            owned(&signed, &connection_id).await?;
            signed
                .security
                .delete_connection(&connection_id, signed.signer.as_str())
                .await
                .map_err(|_| ApiError::Unavailable)?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegationBody {
    agent: String,
    #[serde(default)]
    label: Option<String>,
}

/// `POST /connections/{id}/agents`
pub async fn add_agent(
    State(state): State<AppState>,
    Path(connection_id): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    respond(
        async {
            let signed = signed(&state, &method, &uri, &headers, &body).await?;
            owned(&signed, &connection_id).await?;
            let request: DelegationBody = serde_json::from_slice(&body)
                .map_err(|_| ApiError::BadRequest("body must be {\"agent\", \"label\"?}"))?;
            let delegate = agent(&request.agent)?;
            let label = label(request.label)?;
            signed
                .security
                .put_delegation(&connection_id, delegate.as_str(), label.as_deref())
                .await
                .map_err(|_| ApiError::Unavailable)?;
            Ok(Json(serde_json::json!({
                "connection_id": connection_id,
                "agent": delegate.as_str(),
                "label": label,
            }))
            .into_response())
        }
        .await,
    )
}

/// `DELETE /connections/{id}/agents/{agent}`
pub async fn remove_agent(
    State(state): State<AppState>,
    Path((connection_id, delegate)): Path<(String, String)>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    respond(
        async {
            let signed = signed(&state, &method, &uri, &headers, &body).await?;
            owned(&signed, &connection_id).await?;
            let delegate = agent(&delegate)?;
            signed
                .security
                .delete_delegation(&connection_id, delegate.as_str())
                .await
                .map_err(|_| ApiError::Unavailable)?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBody {
    app: String,
    agent: String,
    #[serde(default)]
    label: Option<String>,
}

/// `POST /runtimes`
pub async fn add_runtime(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    respond(
        async {
            let signed = signed(&state, &method, &uri, &headers, &body).await?;
            let request: RuntimeBody = serde_json::from_slice(&body).map_err(|_| {
                ApiError::BadRequest("body must be {\"app\", \"agent\", \"label\"?}")
            })?;
            let app = agent(&request.app)?;
            let runtime = agent(&request.agent)?;
            if runtime == app || runtime == signed.signer {
                return Err(ApiError::BadRequest(
                    "a runtime must be its own agent, not the app or the owner",
                ));
            }
            let label = label(request.label)?;
            signed
                .security
                .put_runtime(
                    signed.signer.as_str(),
                    runtime.as_str(),
                    app.as_str(),
                    label.as_deref(),
                )
                .await
                .map_err(|_| ApiError::Unavailable)?;
            Ok(Json(serde_json::json!({
                "app": app.as_str(),
                "agent": runtime.as_str(),
                "label": label,
            }))
            .into_response())
        }
        .await,
    )
}

/// `DELETE /runtimes/{agent}`
pub async fn remove_runtime(
    State(state): State<AppState>,
    Path(runtime): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    respond(
        async {
            let signed = signed(&state, &method, &uri, &headers, &body).await?;
            let runtime = agent(&runtime)?;
            signed
                .security
                .delete_runtime(signed.signer.as_str(), runtime.as_str())
                .await
                .map_err(|_| ApiError::Unavailable)?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use crate::agent_id::test_signer::Agent;
    use crate::test_support::{body_json, security, signed_request, state};
    use axum::http::StatusCode;
    use tower::ServiceExt;

    #[tokio::test]
    async fn management_routes_require_a_signature() {
        let s = state(None);
        for (method, path) in [
            ("GET", "/connections".to_string()),
            ("DELETE", format!("/connections/{}", "a".repeat(43))),
            ("POST", format!("/connections/{}/agents", "a".repeat(43))),
            ("POST", "/runtimes".to_string()),
        ] {
            let response = crate::router(s.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(&path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            // Without a database the proxy cannot spend the proof, but it
            // never answers 2xx either way.
            assert!(
                matches!(
                    response.status(),
                    StatusCode::UNAUTHORIZED | StatusCode::SERVICE_UNAVAILABLE
                ),
                "{method} {path}: {}",
                response.status()
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_only_the_owner_manages_a_connection() {
        let security = security().await;
        let s = state(Some(security.clone()));
        let owner = Agent::new(51);
        let stranger = Agent::new(52);
        let app = Agent::new(53);
        let node = Agent::new(54);
        let id = security
            .create_connection("clockify", &owner.id(), b"{}")
            .await
            .unwrap();
        let send = |agent: &Agent, method: &str, path: String, body: serde_json::Value| {
            let body = if body.is_null() {
                vec![]
            } else {
                body.to_string().into_bytes()
            };
            let request = signed_request(&s, agent, method, &path, body);
            let router = crate::router(s.clone());
            async move { router.oneshot(request).await.unwrap() }
        };

        // A stranger can neither delegate nor delete.
        let response = send(
            &stranger,
            "POST",
            format!("/connections/{id}/agents"),
            serde_json::json!({"agent": stranger.id()}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(body_json(response).await["error"], "not_owner");
        let response = send(
            &stranger,
            "DELETE",
            format!("/connections/{id}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        // A delegate cannot delegate further.
        security.put_delegation(&id, &app.id(), None).await.unwrap();
        let response = send(
            &app,
            "POST",
            format!("/connections/{id}/agents"),
            serde_json::json!({"agent": stranger.id()}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // The owner delegates, with a legacy spelling that comes back canonical.
        let response = send(
            &owner,
            "POST",
            format!("/connections/{id}/agents"),
            serde_json::json!({"agent": app.legacy_id(), "label": "Calendar plugin"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["agent"], app.id());
        // Bad input.
        for body in [
            serde_json::json!({"agent": "https://example.com/agent"}),
            serde_json::json!({"agent": app.id(), "label": "x".repeat(201)}),
            serde_json::json!({"agent": app.id(), "extra": true}),
            serde_json::json!({}),
        ] {
            let response = send(
                &owner,
                "POST",
                format!("/connections/{id}/agents"),
                body.clone(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
        }
        // Register a runtime of the app.
        let response = send(
            &owner,
            "POST",
            "/runtimes".into(),
            serde_json::json!({"app": app.id(), "agent": node.legacy_id(), "label": "hosted.example"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let response = send(
            &owner,
            "POST",
            "/runtimes".into(),
            serde_json::json!({"app": app.id(), "agent": app.id()}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        // The list shows what the management UI needs, and no credentials.
        let response = send(
            &owner,
            "GET",
            "/connections".into(),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let listed = body_json(response).await;
        assert_eq!(listed["owner"], owner.id());
        let connection = listed["connections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["connection_id"] == id)
            .unwrap();
        assert_eq!(connection["platform"], "clockify");
        assert_eq!(connection["delegations"][0]["agent"], app.id());
        assert_eq!(connection["delegations"][0]["label"], "Calendar plugin");
        assert!(connection.get("envelope").is_none() && connection.get("credential").is_none());
        assert_eq!(listed["runtimes"][0]["agent"], node.id());
        assert_eq!(listed["runtimes"][0]["app"], app.id());
        // Someone else's list does not include it.
        let response = send(
            &stranger,
            "GET",
            "/connections".into(),
            serde_json::Value::Null,
        )
        .await;
        assert!(body_json(response).await["connections"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["connection_id"] != id));

        // Remove the runtime and the delegation (path agent in legacy spelling,
        // percent-encoded).
        let encoded =
            url::form_urlencoded::byte_serialize(node.legacy_id().as_bytes()).collect::<String>();
        let response = send(
            &owner,
            "DELETE",
            format!("/runtimes/{encoded}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(!security
            .delete_runtime(&owner.id(), &node.id())
            .await
            .unwrap());
        let response = send(
            &owner,
            "DELETE",
            format!("/connections/{id}/agents/{}", app.id()),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(!security.is_delegated(&id, &app.id()).await.unwrap());

        // Delete the connection.
        let response = send(
            &owner,
            "DELETE",
            format!("/connections/{id}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(security.load_connection(&id).await.unwrap().is_none());
        let response = send(
            &owner,
            "DELETE",
            format!("/connections/{id}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(response).await["error"], "unknown_connection");
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_management_signature_cannot_be_replayed_with_a_different_body() {
        // Issue #54's motivating attack against v1: a captured
        // `POST /connections/{id}/agents {agent}` resent with the attacker's
        // agent. Under v2 the body is signed and every proof is single-use.
        let security = security().await;
        let s = state(Some(security.clone()));
        let owner = Agent::new(55);
        let app = Agent::new(56);
        let attacker = Agent::new(57);
        let id = security
            .create_connection("clockify", &owner.id(), b"{}")
            .await
            .unwrap();
        let path = format!("/connections/{id}/agents");
        let captured = signed_request(
            &s,
            &owner,
            "POST",
            &path,
            serde_json::json!({"agent": app.id()})
                .to_string()
                .into_bytes(),
        );
        let mut swapped = crate::test_support::clone_request(&captured);
        *swapped.body_mut() =
            axum::body::Body::from(serde_json::json!({"agent": attacker.id()}).to_string());
        let replay = crate::test_support::clone_request(&captured);
        let response = crate::router(s.clone()).oneshot(swapped).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(response).await["error"], "bad_signature");
        assert_eq!(
            crate::router(s.clone())
                .oneshot(captured)
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let response = crate::router(s.clone()).oneshot(replay).await.unwrap();
        assert_eq!(body_json(response).await["error"], "replayed");
        assert!(!security.is_delegated(&id, &attacker.id()).await.unwrap());
    }
}
