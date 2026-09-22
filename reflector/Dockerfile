# syntax=docker/dockerfile:1

# --- Build stage: install all deps and compile TypeScript to build/ ---
FROM node:22.12-slim AS build
WORKDIR /app
# Enable pnpm via Corepack, pinned by package.json's "packageManager" field.
# Refresh Corepack first so it trusts the signing keys for recent pnpm releases.
RUN npm install -g corepack@latest && corepack enable
# Copy manifests (and scripts/, which the postinstall hook needs) first so the
# dependency layer is cached independently of source changes. pnpm-workspace.yaml
# carries the onlyBuiltDependencies allowlist, so it must be present at install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# --- Runtime stage: production deps + compiled output only ---
FROM node:22.12-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    NODE_OPTIONS=--enable-source-maps
RUN npm install -g corepack@latest && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
# Production deps only. syncables ships prebuilt, so the postinstall build is a
# no-op here; skip lifecycle scripts to keep the runtime image lean.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Compiled app plus the runtime assets it reads relative to the repo root.
COPY --from=build /app/build ./build
COPY spec ./spec
COPY public ./public

# Persist the local-first copy and OAuth tokens on a mounted volume so they
# survive container restarts (unlike a Heroku dyno's ephemeral disk).
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 3000
# Run node directly (mirroring the "start" script's --enable-source-maps) so the
# runtime image needs neither npm nor pnpm on the container's PATH.
CMD ["node", "build/src/main.js"]
