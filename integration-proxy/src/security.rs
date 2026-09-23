use std::{collections::HashSet, pin::Pin, sync::Arc, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use tokio::sync::RwLock;
use tokio_postgres::Client;

type ConnectionDriver =
    Pin<Box<dyn std::future::Future<Output = Result<(), tokio_postgres::Error>> + Send>>;

async fn connect_once(database_url: &str) -> Result<(Client, ConnectionDriver), String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    let tls = postgres_native_tls::MakeTlsConnector::new(tls);
    let (client, connection) = tokio_postgres::connect(database_url, tls)
        .await
        .map_err(|e| e.to_string())?;
    Ok((client, Box::pin(connection)))
}

/// Drives the active connection to completion, then keeps reconnecting with
/// exponential backoff and swapping the shared client in on success, so a
/// dropped connection recovers without restarting the process.
fn spawn_reconnect_supervisor(
    database_url: String,
    current: Arc<RwLock<Arc<Client>>>,
    mut connection: ConnectionDriver,
) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = connection.await {
                tracing::error!(%error, "postgres connection failed; reconnecting");
            } else {
                tracing::warn!("postgres connection closed; reconnecting");
            }
            let mut backoff = Duration::from_secs(1);
            loop {
                match connect_once(&database_url).await {
                    Ok((client, new_connection)) => {
                        *current.write().await = Arc::new(client);
                        connection = new_connection;
                        break;
                    }
                    Err(error) => {
                        tracing::error!(%error, ?backoff, "postgres reconnect attempt failed; retrying");
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                    }
                }
            }
        }
    });
}

/// Days an unused connection code, and so the credential sealed in it, stays
/// redeemable. This was ten minutes, which destroyed a user's refresh token
/// whenever their client stopped syncing for that long (issue #42). Long
/// enough to survive a weekend or holiday; short enough that abandoned
/// grants are still swept.
pub const CONNECTION_CODE_IDLE_DAYS: i32 = 30;

/// Days a persistent connection (issue #40) survives without a proxied
/// request. Longer than [`CONNECTION_CODE_IDLE_DAYS`]: a connection is the
/// grant itself, and a caller that authenticates by signature holds no code
/// that could expire first. Measured from `last_used_at`, which is bumped only
/// after a request has authenticated, so knowing a connection id is not
/// enough to keep one alive.
pub const CONNECTION_IDLE_DAYS: i32 = 90;

/// How long one caller may hold a connection's refresh lease before another
/// may take it over. Longer than a provider token request should take, short
/// enough that a crashed holder does not wedge the connection.
const REFRESH_LEASE_SECONDS: f64 = 30.0;

/// A persistent connection row, with its credential opened.
pub struct ConnectionRecord {
    pub platform: String,
    pub user_id: String,
    /// The serialized `StoredCredential`; interpreted by `proxy.rs`.
    pub credential: Vec<u8>,
}

fn connection_aad(connection_id: &str) -> Vec<u8> {
    // Bound to the row, so one row's envelope cannot be pasted into another.
    format!("connection-record-v1:{connection_id}").into_bytes()
}

pub struct OAuthState {
    pub provider: String,
    pub redirect_uri: String,
    pub tenant_id: String,
    pub user_id: String,
    pub verifier: String,
    pub context: Option<String>,
}

#[derive(Clone)]
pub struct Security {
    database: Arc<RwLock<Arc<Client>>>,
    encryption_key: [u8; 32],
    revoked_subjects: HashSet<String>,
}

impl Security {
    pub async fn connect(
        database_url: &str,
        encryption_key: &str,
        revoked_subjects: Vec<String>,
    ) -> Result<Self, String> {
        let key = URL_SAFE_NO_PAD
            .decode(encryption_key)
            .map_err(|_| "ENCRYPTION_KEY must be base64url")?;
        let encryption_key: [u8; 32] = key
            .try_into()
            .map_err(|_| "ENCRYPTION_KEY must decode to exactly 32 bytes")?;
        // Schema setup needs a transaction, which requires exclusive (&mut)
        // access to a Client — incompatible with the shared, reconnectable
        // client below. Run it on its own short-lived connection first.
        {
            let (mut setup, setup_connection) = connect_once(database_url).await?;
            let driver = tokio::spawn(setup_connection);
            let transaction = setup.transaction().await.map_err(|e| e.to_string())?;
            transaction
                .query_one(
                    "SELECT pg_advisory_xact_lock($1)",
                    &[&7_316_186_474_691_124_077_i64],
                )
                .await
                .map_err(|e| e.to_string())?;
            transaction.batch_execute("CREATE TABLE IF NOT EXISTS used_challenges (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL); CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, provider TEXT NOT NULL, redirect_uri TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, verifier TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL); CREATE TABLE IF NOT EXISTS connection_codes (code TEXT PRIMARY KEY, envelope TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL); ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS context TEXT; CREATE TABLE IF NOT EXISTS connection_handoffs (code TEXT PRIMARY KEY, challenge TEXT NOT NULL, envelope TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL); CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON oauth_states (expires_at); CREATE INDEX IF NOT EXISTS connection_codes_expires_at_idx ON connection_codes (expires_at); CREATE INDEX IF NOT EXISTS used_challenges_expires_at_idx ON used_challenges (expires_at); CREATE INDEX IF NOT EXISTS connection_handoffs_expires_at_idx ON connection_handoffs (expires_at); CREATE TABLE IF NOT EXISTS connections (connection_id TEXT PRIMARY KEY, platform TEXT NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, envelope TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), refresh_lease_until TIMESTAMPTZ); CREATE INDEX IF NOT EXISTS connections_last_used_at_idx ON connections (last_used_at)").await.map_err(|e| e.to_string())?;
            transaction.commit().await.map_err(|e| e.to_string())?;
            drop(setup);
            let _ = driver.await;
        }

        let (client, connection) = connect_once(database_url).await?;
        let database = Arc::new(RwLock::new(Arc::new(client)));
        spawn_reconnect_supervisor(database_url.to_string(), database.clone(), connection);
        Ok(Self {
            database,
            encryption_key,
            revoked_subjects: revoked_subjects.into_iter().collect(),
        })
    }

    /// The client currently backing this connection. Held only for the
    /// duration of one query: a reconnect replaces the shared client without
    /// invalidating a client already in hand.
    async fn client(&self) -> Arc<Client> {
        self.database.read().await.clone()
    }

    /// Lightweight readiness probe for callers (health checks, startup
    /// diagnostics) that want to know whether the database is currently
    /// reachable without triggering the normal error-mapping of a query.
    pub async fn is_ready(&self) -> bool {
        self.client().await.simple_query("SELECT 1").await.is_ok()
    }

    pub fn is_revoked(&self, tenant_id: &str, user_id: &str) -> bool {
        self.revoked_subjects.contains(tenant_id) || self.revoked_subjects.contains(user_id)
    }

    /// Atomically records a nonce. A duplicate nonce is a replay.
    pub async fn consume_nonce(&self, nonce: &str) -> Result<bool, String> {
        let database = self.client().await;
        database
            .execute("DELETE FROM used_challenges WHERE expires_at <= NOW()", &[])
            .await
            .map_err(|e| e.to_string())?;
        let rows = database.execute("INSERT INTO used_challenges (nonce, expires_at) VALUES ($1, NOW() + INTERVAL '10 minutes') ON CONFLICT DO NOTHING", &[&nonce]).await.map_err(|e| e.to_string())?;
        Ok(rows == 1)
    }

    #[allow(dead_code)] // consumed by the OAuth credential flow added after provider registration
    pub fn seal(&self, plaintext: &[u8], associated_data: &[u8]) -> Result<String, String> {
        let cipher = XChaCha20Poly1305::new((&self.encryption_key).into());
        let mut nonce = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: associated_data,
                },
            )
            .map_err(|_| "encryption failed")?;
        Ok(format!(
            "v1.{}.{}",
            URL_SAFE_NO_PAD.encode(nonce),
            URL_SAFE_NO_PAD.encode(ciphertext)
        ))
    }

    #[allow(dead_code)] // consumed by the OAuth credential flow added after provider registration
    pub fn open(&self, envelope: &str, associated_data: &[u8]) -> Option<Vec<u8>> {
        let (version, value) = envelope.split_once('.')?;
        if version != "v1" {
            return None;
        }
        let (nonce, ciphertext) = value.split_once('.')?;
        let nonce = URL_SAFE_NO_PAD.decode(nonce).ok()?;
        let ciphertext = URL_SAFE_NO_PAD.decode(ciphertext).ok()?;
        if nonce.len() != 24 {
            return None;
        }
        XChaCha20Poly1305::new((&self.encryption_key).into())
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: associated_data,
                },
            )
            .ok()
    }

    pub async fn store_oauth_state(&self, state: &str, value: &OAuthState) -> Result<(), String> {
        let database = self.client().await;
        database
            .execute("DELETE FROM oauth_states WHERE expires_at <= NOW()", &[])
            .await
            .map_err(|e| e.to_string())?;
        database.execute("INSERT INTO oauth_states (state, provider, redirect_uri, tenant_id, user_id, verifier, context, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + INTERVAL '10 minutes')", &[&state, &value.provider, &value.redirect_uri, &value.tenant_id, &value.user_id, &value.verifier, &value.context]).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn take_oauth_state(&self, state: &str) -> Result<Option<OAuthState>, String> {
        let row = self.client().await.query_opt("DELETE FROM oauth_states WHERE state = $1 AND expires_at > NOW() RETURNING provider, redirect_uri, tenant_id, user_id, verifier, context", &[&state]).await.map_err(|e| e.to_string())?;
        Ok(row.map(|r| OAuthState {
            provider: r.get(0),
            redirect_uri: r.get(1),
            tenant_id: r.get(2),
            user_id: r.get(3),
            verifier: r.get(4),
            context: r.get(5),
        }))
    }

    pub async fn store_handoff(
        &self,
        code: &str,
        challenge: &str,
        envelope: &str,
    ) -> Result<(), String> {
        let database = self.client().await;
        database
            .execute(
                "DELETE FROM connection_handoffs WHERE expires_at <= NOW()",
                &[],
            )
            .await
            .map_err(|e| e.to_string())?;
        database.execute("INSERT INTO connection_handoffs (code, challenge, envelope, expires_at) VALUES ($1,$2,$3,NOW() + INTERVAL '5 minutes')", &[&code, &challenge, &envelope]).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Validate PKCE and consume atomically; a wrong verifier cannot burn a valid code.
    pub async fn take_handoff(
        &self,
        code: &str,
        challenge: &str,
    ) -> Result<Option<String>, String> {
        self.client().await.query_opt("DELETE FROM connection_handoffs WHERE code = $1 AND challenge = $2 AND expires_at > NOW() RETURNING envelope", &[&code, &challenge]).await.map_err(|e| e.to_string()).map(|row| row.map(|r| r.get(0)))
    }

    /// Stores a single-use connection code. Its row is the only server-side
    /// copy of the sealed credential, including any OAuth refresh token, so
    /// its lifetime is the grant's lifetime: it must outlast ordinary client
    /// idleness, not just a provider's five-minute Retry-After. `forward`
    /// stores a fresh successor on every proxied request, so this is an idle
    /// timeout measured from last use. OAuth handoffs keep their separate
    /// five-minute lifetime.
    pub async fn store_connection_code(&self, code: &str, envelope: &str) -> Result<(), String> {
        let database = self.client().await;
        database
            .execute(
                "DELETE FROM connection_codes WHERE expires_at <= NOW()",
                &[],
            )
            .await
            .map_err(|e| e.to_string())?;
        database.execute("INSERT INTO connection_codes (code, envelope, expires_at) VALUES ($1,$2,NOW() + make_interval(days => $3))", &[&code, &envelope, &CONNECTION_CODE_IDLE_DAYS]).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn take_connection_code(&self, code: &str) -> Result<Option<String>, String> {
        self.client().await.query_opt("DELETE FROM connection_codes WHERE code = $1 AND expires_at > NOW() RETURNING envelope", &[&code]).await.map_err(|e| e.to_string()).map(|row| row.map(|r| r.get(0)))
    }

    /// Creates a persistent connection holding `credential` (a serialized
    /// `StoredCredential`) and returns its new random id. The row, not any
    /// code, is the credential's only server-side copy from here on.
    pub async fn create_connection(
        &self,
        platform: &str,
        tenant_id: &str,
        user_id: &str,
        credential: &[u8],
    ) -> Result<String, String> {
        let connection_id = crate::connect::random();
        let envelope = self.seal(credential, &connection_aad(&connection_id))?;
        let database = self.client().await;
        database
            .execute(
                "DELETE FROM connections WHERE last_used_at <= NOW() - make_interval(days => $1)",
                &[&CONNECTION_IDLE_DAYS],
            )
            .await
            .map_err(|e| e.to_string())?;
        database
            .execute(
                "INSERT INTO connections (connection_id, platform, tenant_id, user_id, envelope) VALUES ($1,$2,$3,$4,$5)",
                &[&connection_id, &platform, &tenant_id, &user_id, &envelope],
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(connection_id)
    }

    /// Reads a live connection without marking it used; the caller has not
    /// authenticated yet. `None` for an unknown, idle-expired or tampered row.
    pub async fn load_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionRecord>, String> {
        let row = self
            .client()
            .await
            .query_opt(
                "SELECT platform, user_id, envelope FROM connections WHERE connection_id = $1 AND last_used_at > NOW() - make_interval(days => $2)",
                &[&connection_id, &CONNECTION_IDLE_DAYS],
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(row.and_then(|row| {
            let envelope: String = row.get(2);
            Some(ConnectionRecord {
                platform: row.get(0),
                user_id: row.get(1),
                credential: self.open(&envelope, &connection_aad(connection_id))?,
            })
        }))
    }

    /// Records an authenticated use, restarting the idle clock.
    pub async fn touch_connection(&self, connection_id: &str) -> Result<(), String> {
        self.client()
            .await
            .execute(
                "UPDATE connections SET last_used_at = NOW() WHERE connection_id = $1",
                &[&connection_id],
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Claims the right to refresh this connection's OAuth token. At most one
    /// caller holds it at a time, across processes: two concurrent refreshes
    /// would both spend the same refresh token, and a provider that rotates
    /// refresh tokens (or detects reuse) would then revoke the grant. A
    /// caller that does not get the lease re-reads the row instead.
    pub async fn claim_refresh_lease(&self, connection_id: &str) -> Result<bool, String> {
        self.client()
            .await
            .execute(
                "UPDATE connections SET refresh_lease_until = NOW() + make_interval(secs => $2) WHERE connection_id = $1 AND (refresh_lease_until IS NULL OR refresh_lease_until <= NOW())",
                &[&connection_id, &REFRESH_LEASE_SECONDS],
            )
            .await
            .map(|rows| rows == 1)
            .map_err(|e| e.to_string())
    }

    /// Stores a refreshed credential and releases the refresh lease.
    pub async fn store_refreshed_connection(
        &self,
        connection_id: &str,
        credential: &[u8],
    ) -> Result<(), String> {
        let envelope = self.seal(credential, &connection_aad(connection_id))?;
        self.client()
            .await
            .execute(
                "UPDATE connections SET envelope = $2, refresh_lease_until = NULL WHERE connection_id = $1",
                &[&connection_id, &envelope],
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Releases the refresh lease after a failed refresh, leaving the stored
    /// credential as it was.
    pub async fn release_refresh_lease(&self, connection_id: &str) -> Result<(), String> {
        self.client()
            .await
            .execute(
                "UPDATE connections SET refresh_lease_until = NULL WHERE connection_id = $1",
                &[&connection_id],
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Barrier;

    const TEST_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn concurrent_connections_initialize_a_fresh_schema() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database");
        let (admin, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .expect("connect to test database");
        tokio::spawn(async move {
            connection.await.expect("test database connection");
        });

        let schema = format!("security_connect_{:016x}", rand::random::<u64>());
        admin
            .batch_execute(&format!("CREATE SCHEMA \"{schema}\""))
            .await
            .expect("create test schema");
        let mut scoped_url = url::Url::parse(&database_url).expect("parse TEST_DATABASE_URL");
        scoped_url
            .query_pairs_mut()
            .append_pair("options", &format!("-csearch_path={schema}"));
        let scoped_url = scoped_url.to_string();
        let barrier = Arc::new(Barrier::new(8));
        let mut connections = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let barrier = barrier.clone();
            let scoped_url = scoped_url.clone();
            connections.spawn(async move {
                barrier.wait().await;
                Security::connect(&scoped_url, TEST_KEY, vec![]).await
            });
        }

        let mut initialized = Vec::new();
        let mut errors = Vec::new();
        while let Some(result) = connections.join_next().await {
            match result.expect("initializer task") {
                Ok(security) => initialized.push(security),
                Err(error) => errors.push(error),
            }
        }
        drop(initialized);
        admin
            .batch_execute(&format!("DROP SCHEMA \"{schema}\" CASCADE"))
            .await
            .expect("drop test schema");

        assert!(
            errors.is_empty(),
            "concurrent schema initialization failed: {errors:?}"
        );
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn recovers_after_the_database_connection_is_dropped() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database");
        let tag = format!("security_reconnect_{:016x}", rand::random::<u64>());
        let mut tagged_url = url::Url::parse(&database_url).expect("parse TEST_DATABASE_URL");
        tagged_url
            .query_pairs_mut()
            .append_pair("application_name", &tag);
        let security = Security::connect(tagged_url.as_ref(), TEST_KEY, vec![])
            .await
            .expect("initial connection");
        assert!(security.is_ready().await);

        let (admin, admin_connection) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
                .await
                .expect("admin connection");
        tokio::spawn(async move {
            admin_connection.await.expect("admin connection driver");
        });
        let terminated = admin
            .execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
                &[&tag],
            )
            .await
            .expect("terminate the security connection's backend");
        assert!(
            terminated > 0,
            "expected to terminate at least one backend for {tag}"
        );

        let mut healed = false;
        for _ in 0..50 {
            if security.is_ready().await {
                healed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(healed, "connection did not recover after being terminated");

        // A real write, not just the readiness probe, proves the reconnected
        // client is fully usable and schema state survived the reconnect.
        assert!(security
            .consume_nonce(&format!("post-reconnect-{tag}"))
            .await
            .expect("query after reconnect"));
    }

    /// Simulates `idle` passing for one stored code by moving its expiry
    /// back, then stores another code so the expired-row sweep runs.
    async fn age_connection_code(
        security: &Security,
        admin: &tokio_postgres::Client,
        code: &str,
        idle: &str,
    ) {
        let aged = admin
            .execute(
                &format!(
                    "UPDATE connection_codes SET expires_at = expires_at - INTERVAL '{idle}' WHERE code = $1"
                ),
                &[&code],
            )
            .await
            .expect("age connection code");
        assert_eq!(aged, 1, "expected to age exactly one connection code");
        security
            .store_connection_code(&format!("{code}-sweep"), "unused-envelope")
            .await
            .expect("store a code, which sweeps expired rows");
    }

    // Issue #42: the connection_codes row is the only copy of the sealed
    // refresh token, so a client idle for longer than a lunch break must
    // still be able to redeem its code.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn connection_code_survives_an_idle_client() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database");
        let security = Security::connect(&database_url, TEST_KEY, vec![])
            .await
            .expect("connect");
        let (admin, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .expect("admin connection");
        tokio::spawn(async move {
            connection.await.expect("admin connection driver");
        });
        let code = format!("idle-{:016x}", rand::random::<u64>());
        security
            .store_connection_code(&code, "sealed-envelope")
            .await
            .unwrap();

        let remaining_days: f64 = admin
            .query_one(
                "SELECT EXTRACT(EPOCH FROM expires_at - NOW())::float8 / 86400 FROM connection_codes WHERE code = $1",
                &[&code],
            )
            .await
            .unwrap()
            .get(0);
        assert!(
            (f64::from(CONNECTION_CODE_IDLE_DAYS) - 1.0..=f64::from(CONNECTION_CODE_IDLE_DAYS))
                .contains(&remaining_days),
            "expected a {CONNECTION_CODE_IDLE_DAYS}-day idle lifetime, got {remaining_days} days"
        );

        // Idle for a day: well past the previous ten-minute expiry.
        age_connection_code(&security, &admin, &code, "1 day").await;
        assert_eq!(
            security
                .take_connection_code(&code)
                .await
                .unwrap()
                .as_deref(),
            Some("sealed-envelope")
        );
        // Still single-use.
        assert!(security
            .take_connection_code(&code)
            .await
            .unwrap()
            .is_none());
        assert!(security
            .take_connection_code(&format!("{code}-sweep"))
            .await
            .unwrap()
            .is_some());
    }

    // Abandoned grants are still cleaned up once the idle lifetime passes.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn connection_code_is_swept_after_the_idle_lifetime() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database");
        let security = Security::connect(&database_url, TEST_KEY, vec![])
            .await
            .expect("connect");
        let (admin, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
            .await
            .expect("admin connection");
        tokio::spawn(async move {
            connection.await.expect("admin connection driver");
        });
        let code = format!("abandoned-{:016x}", rand::random::<u64>());
        security
            .store_connection_code(&code, "sealed-envelope")
            .await
            .unwrap();

        age_connection_code(
            &security,
            &admin,
            &code,
            &format!("{CONNECTION_CODE_IDLE_DAYS} days 1 second"),
        )
        .await;
        let remaining: i64 = admin
            .query_one(
                "SELECT COUNT(*) FROM connection_codes WHERE code = $1",
                &[&code],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(remaining, 0, "expired code row was not swept");
        assert!(security
            .take_connection_code(&code)
            .await
            .unwrap()
            .is_none());
        security
            .take_connection_code(&format!("{code}-sweep"))
            .await
            .unwrap();
    }
}
