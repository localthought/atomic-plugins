# A minimal image of the published `atomic-integration-proxy` crate; see
# SELF_HOSTING.md. It builds the version named by PROXY_VERSION from
# crates.io with the crate's own Cargo.lock (--locked), not this checkout's
# source, so the build context is irrelevant:
#
#   docker build -t atomic-integration-proxy \
#     --build-arg PROXY_VERSION=0.2.0 integration-proxy/
#
# Configuration is environment variables only; nothing is read from disk
# unless CATALOG_PATH names a local file (mount it).
ARG PROXY_VERSION=0.2.0

FROM rust:1-bookworm AS build
ARG PROXY_VERSION
RUN cargo install atomic-integration-proxy --version "=${PROXY_VERSION}" --locked --root /out

FROM debian:bookworm-slim
# libssl3: the PostgreSQL client uses native-tls (OpenSSL on Linux).
# ca-certificates: provider APIs, the catalog, and a TLS PostgreSQL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin integration-proxy
COPY --from=build /out/bin/integration-proxy /usr/local/bin/integration-proxy
USER integration-proxy
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/integration-proxy"]
