//! The `integration-proxy` binary: a thin wrapper around the library.
//! Deployment wrappers (see `examples/heroku-wrapper/`) are the same one line.

#[tokio::main]
async fn main() -> std::process::ExitCode {
    atomic_integration_proxy::run().await
}
