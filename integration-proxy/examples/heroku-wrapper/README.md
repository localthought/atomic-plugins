# Heroku wrapper template for `localthought/integration-proxy`

These files are the whole of what `localthought/integration-proxy` needs once
it stops carrying its own copy of the proxy source: a one-line `main.rs` that
calls [`atomic_integration_proxy::run`](../../src/lib.rs), a `Cargo.toml` that
depends on the published crate by semver, and the Heroku config. They are not
built as part of this package (they are excluded from the published crate);
CI compiles them against the in-repo library so the public API they rely on
cannot silently break.

| File | Purpose |
| --- | --- |
| `Cargo.toml` | Package/binary named `auth-proxy`, depending on `atomic-integration-proxy = "0.2"`. |
| `src/main.rs` | `atomic_integration_proxy::run().await`. |
| `Procfile` | `web: target/release/auth-proxy` — identical to the current production Procfile. |
| `rust-toolchain` | `stable`. Read by the `emk/rust` Heroku buildpack (it `cat`s a plain `rust-toolchain` file; it does not read `rust-toolchain.toml`). |
| `.gitignore` | `/target`, `.env`. |

## Switching `localthought/integration-proxy` over

Not yet done; these are the steps. They assume the app uses the
[`emk/rust`](https://github.com/emk/heroku-buildpack-rust) buildpack, which
runs `cargo build --release` and builds with `stable` unless `rust-toolchain`
or a `RustConfig` `VERSION` says otherwise. Check with
`heroku buildpacks -a <app>` first; this has not been verified against the
production app.

1. Publish `atomic-integration-proxy` to crates.io (see
   [Publishing](../../README.md#publishing-the-crate)).
2. In a branch of `localthought/integration-proxy`, delete `src/`, `static/`,
   `tests/`, `rustfmt.toml` and the old `Cargo.toml`/`Cargo.lock`; copy in
   this directory's `Cargo.toml`, `src/main.rs`, `Procfile`, `rust-toolchain`
   and `.gitignore`. Keep `.env.example`, `LICENSE`, and replace `README.md`,
   `SECURITY.md`, `AGENTS.md`, `TESTING_COVERAGE.md` with a pointer to
   `ontola/atomic-plugins/integration-proxy/`.
3. Run `cargo generate-lockfile && cargo build --release` and commit the
   resulting `Cargo.lock` — Heroku builds from it, so the exact crate
   version deployed is whatever the lockfile pins.
4. Replace its CI with a `cargo build --locked` (the tests now run in
   `ontola/atomic-plugins`).
5. Deploy. The crate reads the same environment variables as the 0.1 code,
   except for the issue #54 changes listed in
   [Deploying 0.2](../../README.md#deploying-02-issue-54-flag-day): `BASE_URL`
   must be exactly the public origin, `APP_AUTH_*` and `SERVER_SECRET` are no
   longer read, and `REVOKED_SUBJECTS` now lists agent ids. 0.2 is a flag day
   for clients too. One more visible difference: log lines are tagged
   `atomic_integration_proxy` instead of `auth_proxy`, so a `RUST_LOG` such as
   `auth_proxy=debug` has to become `atomic_integration_proxy=debug`.

To deploy a later proxy change: publish a new crate version, then in
`localthought/integration-proxy` run
`cargo update -p atomic-integration-proxy`, commit `Cargo.lock`, and push.
A new minor version before 1.0 (0.1 to 0.2) is semver-incompatible: bump the
requirement in its `Cargo.toml` too (`atomic-integration-proxy = "0.2"`), or
`cargo update` stays on 0.1.

## Building this template locally against the in-repo crate

Before the crate is on crates.io (or to test unreleased changes):

```sh
cd integration-proxy/examples/heroku-wrapper
cargo build --config 'patch.crates-io.atomic-integration-proxy.path="../.."'
rm Cargo.lock   # generated against the local path; don't commit it here
```
