# syntax=docker/dockerfile:1.7
#
# The pinned atomic-server's e2e binary, as a container image:
# ghcr.io/ontola/atomic-server-e2e:<full atomic-server SHA>.
#
# The build context is an ontola/atomic-server checkout at that SHA, not
# this repo. This file sits outside the context and is passed with -f;
# Dockerfile.dockerignore next to it applies instead of the checkout's own
# .dockerignore, so the checkout's target/, node_modules and .git (about 10 GB
# in a used checkout) never reach the daemon:
#
#   docker build \
#     -f integrations/tooling/atomic-server-e2e/Dockerfile \
#     -t ghcr.io/ontola/atomic-server-e2e:"$(cat .atomic-server-ref)" \
#     /path/to/atomic-server-checkout
#
# It builds exactly what ci.yml's `build-server` job builds from source, with
# the same steps and flags. Keep the two in step. The comments on those steps
# in ci.yml explain each one; they are not repeated here.
#
#   1. The browser WASM bundle (wasm-pack, --no-opt) goes into
#      browser/data-browser/public/wasm/.
#   2. `cargo build --profile e2e -p atomic-server --no-default-features
#      --features wasm-plugins`, with SKIP_WASM_BUILD=1 and VITE_E2E=true.
#      build.rs builds and embeds the data-browser frontend, and
#      build_plugin_runtime.rs embeds the wasm32-wasip2 plugin runtime.
#
# The final image holds that one binary and nothing else from the checkout.
# The lanes need nothing else from the build at runtime. What they do need
# from atomic-server (browser/ with its node_modules, @tomic/lib's dist,
# Playwright and its specs) is platform-specific JavaScript that each lane job
# still installs from its own checkout, locally and in CI.
#
# The binary is linked against the builder's glibc, 2.36 (bookworm). ci.yml
# copies it out of the image and runs it on ubuntu-latest (24.04, glibc 2.39),
# which is newer, so that works. Don't move the builder to a newer distro than
# the runners without checking this.

ARG RUST_IMAGE=rust:1-bookworm
ARG NODE_IMAGE=node:22-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM ${RUST_IMAGE} AS builder
ARG PNPM_VERSION=10.15.1
# Caps rustc parallelism for hosts with little memory per core. Docker
# Desktop's default VM (8 GB, 10 cores) runs out of memory linking wasmtime at
# full parallelism. Empty means cargo's default, one job per core.
ARG CARGO_BUILD_JOBS=

# libclang is for bindgen in rquickjs-sys, which the wasm32-wasip2 plugin
# runtime builds. ubuntu-latest runners have it preinstalled; this image
# doesn't. Without it, build_plugin_runtime.rs fails, and
# ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME below makes that fail the build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libclang-dev clang \
  && rm -rf /var/lib/apt/lists/*

# node, npm and corepack. COPY merges into /usr/local, so the rust image's
# /usr/local/cargo and /usr/local/rustup stay.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && npm install --global "pnpm@${PNPM_VERSION}" \
  && node --version && pnpm --version

WORKDIR /src

# The pinned toolchain first, from rust-toolchain.toml alone, so the layer
# (about 1 GB) is reused across SHAs that pin the same toolchain.
COPY rust-toolchain.toml ./
RUN rustup show active-toolchain \
  && rustup target add wasm32-wasip2 wasm32-unknown-unknown \
  && rustup target list --installed | grep -qx wasm32-wasip2

COPY . .

# HUSKY=0 skips browser/'s `prepare: husky`, which has no .git to hook into.
# pnpm's store is a cache mount. It speeds up local rebuilds and isn't part
# of the image.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  cd browser && HUSKY=0 pnpm install --frozen-lockfile

RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/src/target \
  set -eu \
  && if [ -n "${CARGO_BUILD_JOBS}" ]; then export CARGO_BUILD_JOBS; else unset CARGO_BUILD_JOBS; fi \
  && sh .dagger/scripts/install-wasm-pack.sh /usr/local/bin \
  && cd wasm \
  && CARGO_ENCODED_RUSTFLAGS="$(printf '%s\037%s' --cfg 'getrandom_backend="wasm_js"')" \
    wasm-pack build --target web --out-dir pkg --no-opt \
  && mkdir -p ../browser/data-browser/public/wasm \
  && cp pkg/atomic_wasm.js pkg/atomic_wasm_bg.wasm ../browser/data-browser/public/wasm/

# target/ is a cache mount, so the binary is copied out in the same step:
# nothing written under a cache mount survives into the layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/src/target \
  set -eu \
  && if [ -n "${CARGO_BUILD_JOBS}" ]; then export CARGO_BUILD_JOBS; else unset CARGO_BUILD_JOBS; fi \
  && SKIP_WASM_BUILD=1 VITE_E2E=true ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME=true HUSKY=0 \
    cargo build --profile e2e -p atomic-server --no-default-features --features wasm-plugins \
  && install -D -m 755 target/e2e/atomic-server /out/atomic-server

FROM ${RUNTIME_IMAGE}
ARG ATOMIC_SERVER_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/ontola/atomic-plugins" \
  org.opencontainers.image.description="ontola/atomic-server e2e build (profile e2e, --features wasm-plugins, VITE_E2E) for atomic-plugins' lanes" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.revision="${ATOMIC_SERVER_SHA}" \
  dev.atomicdata.atomic-server.sha="${ATOMIC_SERVER_SHA}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/atomic-server /usr/local/bin/atomic-server
# atomic-server's default ATOMIC_IP is `::`. In a container with IPv6 turned
# off that bind fails, and a published port needs a non-loopback bind anyway.
ENV ATOMIC_IP=0.0.0.0 \
  ATOMIC_DATA_DIR=/data/data \
  ATOMIC_CONFIG_DIR=/data/config \
  ATOMIC_CACHE_DIR=/data/cache
VOLUME /data
EXPOSE 9883
ENTRYPOINT ["/usr/local/bin/atomic-server"]
