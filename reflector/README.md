# Reflector

This code is open source and was produced by Michiel de Jong, using Claude as a tool.
Michiel de Jong has signed off on all the code in this repo line-by-line (except for
the lockfiles, which were produced by npm and pnpm), and Michiel de Jong is the
publishing author in terms of copyright.
This work was [funded by NLNet](https://nlnet.nl/project/TUBS/).

A **local-first** app that syncs your data across multiple **systems of
record**. Reflector connects to a system of record — today the **Google
Calendar API** — reads everything it has for your account into a local copy
made of plain JSON files, and keeps that copy synced in the background.
That local-first copy can itself live in another system of record you
control: your own **[remoteStorage](https://remotestorage.io/)** account,
instead of files on this server. More systems of record can be added over
time.

As a **side feature**, you can download the whole local copy as a **ZIP** at
any time.

It is built on:

- **[localthought/syncables](https://github.com/localthought/syncables)** — the
  sync engine. Reflector hands it an OpenAPI document and it discovers the
  resources, walks pagination on a full read, keeps a local copy in a pluggable
  storage adapter, and applies local-first `create`/`update`/`delete` writes
  that retry against the server in the background.
- **[localthought/overlays](https://github.com/localthought/overlays)** — the
  Google Calendar [OpenAPI Overlays](https://spec.openapis.org/overlay/v1.0.0.html)
  from [issue #140](https://github.com/localthought/overlays/issues/140)
  (`pagination-overlay.yaml` + `crud-causality-overlay.yaml`), which define how
  a client paginates and does CRUD against the Calendar API. They are vendored
  under [`spec/overlays/`](spec/overlays) and applied to the vendored Calendar
  OpenAPI document at startup.

Scaffolded from
[node-typescript-boilerplate](https://github.com/michielbdejong/node-typescript-boilerplate).

## What it does

1. **Connect** a system of record via OAuth 2.0 — currently your Google
   account.
2. **Sync** — pull the full dataset (calendar list and every event on every
   calendar) into a local JSON copy under `data/`, and keep it synced:
   - while a sync is in flight, the header shows how many changes are in
     flight;
   - on success it shows **"synced"**;
   - on failure a change is **rolled back** to its pre-sync value and a
     warning toast is shown.
3. **Choose where the local copy lives** — on this server, or in your own
   remoteStorage account.
4. **Download ZIP** (side feature) — a `.zip` of the full local copy: one
   JSON file per record, grouped by calendar and resource.

## Running

Requires Node `>= 22.11 < 23`.

```sh
npm install          # installs the prebuilt `syncables` dependency from npm
npm run build
npm start            # http://localhost:3000
```

### Configuration

Set these before starting (a `.env` is not loaded automatically — export them or
use your process manager):

| Variable                     | Required | Default                              | Purpose                                                          |
| ---------------------------- | -------- | ------------------------------------ | --------------------------------------------------------------- |
| `OAUTH_CLIENT_ID`            | yes      | —                                    | OAuth client id                                                 |
| `OAUTH_CLIENT_SECRET`        | yes      | —                                    | OAuth client secret                                             |
| `OAUTH_REDIRECT_URI`         | no       | `${BASE_URL}/auth/callback`          | Must match the redirect URI on the OAuth client                 |
| `BASE_URL`                   | no       | `http://localhost:${PORT}`           | Public origin of this server                                    |
| `PORT`                       | no       | `3000`                               | Listen port                                                     |
| `DATA_DIR`                   | no       | `./data`                             | Where the local-first JSON copy is written (local-files storage) |
| `TOKEN_STORE_PATH`           | no       | `${DATA_DIR}/tokens.json`            | Where the OAuth access + refresh tokens are stored              |
| `REMOTESTORAGE_STORE_PATH`   | no       | `${DATA_DIR}/remotestorage.json`     | Where a connected remoteStorage account is persisted            |
| `REMOTESTORAGE_MODULE`       | no       | `reflector`                          | remoteStorage module (top-level directory) data is written under |
| `REMOTESTORAGE_CLIENT_ID`    | no       | `${BASE_URL}`                        | OAuth `client_id` presented to the remoteStorage provider       |
| `REMOTESTORAGE_REDIRECT_URI` | no       | `${BASE_URL}/remotestorage/callback` | remoteStorage OAuth redirect URI                                |
| `OPENAPI_PATH`               | no       | `spec/google-calendar-v3.openapi.yaml` | OpenAPI document the app is derived from — point it at another API to sync something other than Calendar |
| `OVERLAY_DIR`                | no       | `spec/overlays`                      | Directory of overlays (`auth`/`pagination`/`crud-causality`) applied to that document |

`OPENAPI_PATH` / `OVERLAY_DIR` are what make Reflector API-agnostic: swap in a
different document + overlays and the whole flow (OAuth or token auth, resource
discovery, pagination, CRUD) follows it, with no code change. For pointing two
endpoints at two systems at once, see
[Reflecting between two systems](#reflecting-between-two-systems-eg-two-github-issue-trackers)
below, which adds `OPENAPI_PATH_A` / `OPENAPI_PATH_B` (and their `OVERLAY_DIR_*`
counterparts).

The `OAUTH_*` names are generic; the historical `GOOGLE_CALENDAR_CLIENT_ID` /
`GOOGLE_CALENDAR_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` are still accepted as
fallbacks. Everything else about the API OAuth flow — endpoints, scopes, and the
API base — is read from the document's security scheme and `servers`, not from
env vars. (The `REMOTESTORAGE_*` values configure the separate OAuth flow to the
user's own remoteStorage provider, described below.)

In the [Google Cloud console](https://console.cloud.google.com/): create an
OAuth 2.0 Client (type “Web application”), enable the **Google Calendar API**,
and add `http://localhost:3000/auth/callback` as an authorized redirect URI.
The scopes requested are whatever the document's `oauth` security scheme
declares — for the vendored Calendar overlay that is `calendar`,
`userinfo.email`, and `openid`.

### Reflecting between two systems (e.g. two GitHub issue trackers)

Beyond syncing one system into a local copy, Reflector can **actively reflect
records between two endpoints** — A and B — mirroring changes each way. The
motivating case is two **GitHub issue trackers**: issues created on one are
copied to the other, open/closed state is kept in agreement, and comments are
copied across, so the two trackers stay in step.

> **Status.** The reflection engine is implemented and validated **live**
> against two real GitHub repositories — create, idempotent re-runs, open/closed
> state both ways, and comments — as well as in the test suite against a faithful
> in-memory GitHub. It covers the background loop, the hidden origin markers, the
> persisted id-map, and issue / open-closed-state / comment reflection
> ([#23](https://github.com/localthought/reflector/issues/23)–[#29](https://github.com/localthought/reflector/issues/29)),
> plus the GitHub-shape support in the sync engine
> ([localthought/syncables#4](https://github.com/localthought/syncables/issues/4)–[#6](https://github.com/localthought/syncables/issues/6),
> released in `syncables` 0.17.1 on npm, which this app depends on).

**Each endpoint is derived from its own document + overlays.** A and B do not
have to share a schema — you can point both at the GitHub Issues document, or at
two different systems entirely. Where their record shapes differ, reconciling
them is a later **Devonian** mapping step (out of scope for the base engine);
the config already keeps the two documents separate so that work has somewhere
to plug in.

| Variable             | Required | Default          | Purpose                                                                 |
| -------------------- | -------- | ---------------- | ----------------------------------------------------------------------- |
| `REFLECT_A_REPO`     | for A↔B  | —                | What endpoint A targets, e.g. a GitHub `owner/repo`. Reflection is enabled only when both A and B are set |
| `REFLECT_B_REPO`     | for A↔B  | —                | What endpoint B targets                                                 |
| `REFLECT_A_TOKEN`    | for A↔B  | —                | Endpoint A's API token (e.g. a GitHub PAT). Secret; sent as a bearer, no OAuth flow |
| `REFLECT_B_TOKEN`    | for A↔B  | —                | Endpoint B's API token                                                  |
| `OPENAPI_PATH_A`     | no       | `OPENAPI_PATH`   | OpenAPI document for endpoint A (falls back to the shared `OPENAPI_PATH`) |
| `OPENAPI_PATH_B`     | no       | `OPENAPI_PATH`   | OpenAPI document for endpoint B                                          |
| `OVERLAY_DIR_A`      | no       | `OVERLAY_DIR`    | Overlays for endpoint A (falls back to the shared `OVERLAY_DIR`)        |
| `OVERLAY_DIR_B`      | no       | `OVERLAY_DIR`    | Overlays for endpoint B                                                 |
| `REFLECT_DIRECTION`  | no       | `bidirectional`  | `bidirectional` (A↔B) or `a-to-b` (one-way)                             |
| `REFLECT_INTERVAL_MS`| no       | `60000`          | How often the background reflect loop runs                              |

**GitHub setup.** Point both endpoints at the GitHub Issues document and
overlays, and give each a token for its repo:

```sh
# The GitHub Issues document + overlays (vendored; see #23). The overlays
# themselves live in localthought/overlays under
# github.com/api.github.com/1.1.4 and are applied to the vendored document.
OPENAPI_PATH=spec/github-issues.openapi.yaml
OVERLAY_DIR=spec/overlays/github

REFLECT_A_REPO=octo/source     REFLECT_A_TOKEN=ghp_...
REFLECT_B_REPO=octo/mirror     REFLECT_B_TOKEN=ghp_...
REFLECT_DIRECTION=bidirectional
REFLECT_INTERVAL_MS=60000
```

The GitHub token is a **personal access token** (or installation token) with
`repo`/`issues` scope on the repositories involved — a static bearer, so there
is no OAuth redirect and no `OAUTH_*` client for this mode. Because GitHub
issues and comments have no metadata side-channel, each reflected record carries
a hidden HTML comment (`<!-- reflector:origin … -->`) in its body linking it back
to the original; that marker is how Reflector tells an original from a copy and
avoids reflecting a copy back again.

**Running it.** When both `REFLECT_*_REPO` are set the app starts a background
loop that reflects every `REFLECT_INTERVAL_MS`. You can also trigger a pass on
demand with `POST /api/reflect` (it returns a summary of what it created and the
state changes it propagated), and inspect the loop with `GET /api/reflect/status`.
In this mode the interactive Google "Connect" flow is disabled — a token-auth
instance has no OAuth client.

**Persistence.** Reflection keeps a `source↔target` id-map (plus the two tokens)
that **must survive restarts**. On a durable-disk host it lives under `DATA_DIR`;
on an ephemeral host (a Heroku dyno, DO App Platform) set `DATABASE_URL` so it is
kept in Postgres — the same requirement as [Multiple users](#multiple-users).

### Where tokens live

After the OAuth flow the access token and refresh token are persisted (owner-only
permissions, `0600`), so a connection survives a restart; the refresh token is
used to mint new access tokens automatically. The browser holds only an opaque,
httpOnly session cookie that is matched against the stored session. `data/` is
git-ignored.

### Multiple users

One hosted instance can serve many people at once. Each browser session is a
separate connected user, keyed by its opaque session cookie, with its **own**
OAuth tokens, its **own** local-first copy, and its **own** sync engine —
concurrent users never see or overwrite each other's data. A user's local-files
copy lives in a per-account directory (`${DATA_DIR}/copies/<account>`), and a
connected remoteStorage account is scoped to the single user who connected it.

Where those per-user records are persisted is pluggable:

- **Files** (default) — one owner-only JSON file per user under
  `${DATA_DIR}/users` (override with `USERS_DIR`). Needs a persistent disk.
- **Postgres** — set `DATABASE_URL` and users are stored in a `reflector_users`
  table instead (the table is created automatically). Use this on a host whose
  filesystem is ephemeral (a Heroku dyno, DO App Platform), where the file store
  would lose every connection on each restart/redeploy. On Heroku:
  `heroku addons:create heroku-postgresql:essential-0` sets `DATABASE_URL` for
  you.

Upgrading an instance that already ran the earlier single-user build: its
existing `tokens.json` (and `remotestorage.json`) is migrated into the file
store on first start, so the connection keeps working.

### Deploying to Heroku

The repo ships a `Procfile` (`web: npm start`) and an `app.json`. Heroku's Node
buildpack installs dependencies, runs `npm run build` (tsc → `build/`)
automatically, and starts the process from the `Procfile`; the Node version is
pinned by `engines.node` in `package.json`.

```sh
heroku git:remote -a reflector-prod          # point this repo at your app
heroku config:set \
  OAUTH_CLIENT_ID=... \
  OAUTH_CLIENT_SECRET=... \
  BASE_URL=https://reflector-prod.herokuapp.com   # your app's real URL
git push heroku main                          # build + release
```

In the [Google Cloud console](https://console.cloud.google.com/) add
`${BASE_URL}/auth/callback` as an authorized redirect URI on the OAuth client
(e.g. `https://reflector-prod.herokuapp.com/auth/callback`). `PORT` is injected
by Heroku and read automatically; `OAUTH_REDIRECT_URI` defaults to
`${BASE_URL}/auth/callback`, so setting `BASE_URL` is enough.

If `BASE_URL` isn't set, Reflector falls back to Heroku's
[dyno metadata](https://devcenter.heroku.com/articles/dyno-metadata)
(`HEROKU_APP_DEFAULT_DOMAIN_NAME`) when available, and to
`http://localhost:$PORT` otherwise — the latter is only useful for local dev,
so on Heroku either set `BASE_URL` explicitly (recommended, since the app's
real domain isn't always `<app-name>.herokuapp.com`) or enable dyno metadata:
`heroku labs:enable runtime-dyno-metadata -a reflector-prod`.

> **Heads up — ephemeral disk.** A Heroku dyno's filesystem is wiped on every
> restart and deploy, so anything under `DATA_DIR` (`data/`) does **not**
> persist. For durable connections set **`DATABASE_URL`** so users are stored in
> Postgres instead of on disk (`heroku addons:create heroku-postgresql:essential-0`);
> the local-files calendar copy is still on the ephemeral disk, so also connect a
> [remoteStorage](#multiple-users) account, or expect to re-sync after a restart.
> See [Storage and persistence across hosts](#storage-and-persistence-across-hosts).

### Deploying to DigitalOcean

**App Platform** (managed, git-push deploys) — the repo ships
[`.do/app.yaml`](.do/app.yaml):

```sh
doctl apps create --spec .do/app.yaml     # or paste it into the App Platform UI
```

Set `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` as encrypted env vars in the
app. `BASE_URL` is bound to the app's public URL (`${APP_URL}`) automatically,
so the OAuth redirect resolves without hardcoding the hostname; add
`${APP_URL}/auth/callback` as an authorized redirect URI on the OAuth client.
App Platform's filesystem is **ephemeral**, so attach a Dev Database and set
`DATABASE_URL` (see [Multiple users](#multiple-users)) to keep connections
across deploys.

**Droplet** (a plain VM) — the simplest durable option, because the disk
persists. Run the container (see below) with a mounted volume, or run the Node
process directly under `systemd` with `DATA_DIR` pointing at a real directory.
Users and the local copy then survive restarts with no database needed.

### Deploying with Docker

The [`Dockerfile`](Dockerfile) is a multi-stage build (compile → production
image) that runs as a non-root user and exposes `/app/data` as a volume:

```sh
docker build -t reflector .
docker run -p 3000:3000 \
  -e OAUTH_CLIENT_ID=... \
  -e OAUTH_CLIENT_SECRET=... \
  -e BASE_URL=https://reflector.example.com \
  -v reflector-data:/app/data \
  reflector
```

The `-v reflector-data:/app/data` volume persists everything under `data/`
(per-user records and the local copy) across container restarts — the durable,
disk-based option. On a container host with no persistent volume, set
`DATABASE_URL` instead (see [Multiple users](#multiple-users)). This image runs
on any container host (a Droplet, Fly.io, Render, Cloud Run, etc.).

### Storage and persistence across hosts

There are two things to persist: the **connected users** (their OAuth tokens and
session) and the **local-first copy** of the data. Where you deploy decides how
each behaves:

| Host                          | Disk        | Persistence without extra work                          |
| ----------------------------- | ----------- | ------------------------------------------------------- |
| Droplet / Docker-with-volume  | persistent  | ✅ users + local copy survive restarts                  |
| Heroku dyno / DO App Platform | ephemeral   | ❌ wiped each deploy/restart                             |

On an ephemeral host:

- **Users** → set `DATABASE_URL` to persist them in Postgres instead of on disk
  (see [Multiple users](#multiple-users)). Then connections survive restarts.
- **Local copy** → connect a [remoteStorage](#multiple-users) account so the
  data lives off-host in the user's own storage; otherwise the on-disk copy is
  lost on restart and a full read re-fetches it. (Moving the calendar copy
  itself into Postgres would mean a new syncables `StorageAdapter`; it isn't
  needed for durable connections and isn't done here.)

## Storage: local files or remoteStorage

By default the local-first copy is written to `DATA_DIR` as one JSON file per
record. But because syncables only ever talks to a pluggable
[`StorageAdapter`](https://github.com/localthought/syncables), Reflector lets
you swap that on-disk store for **your own
[remoteStorage](https://remotestorage.io/) account** — your data then lives in
your storage, not on this server. This is what lets Reflector treat
remoteStorage as another system of record alongside Google Calendar.

Use the **Storage** button in the top bar and enter your user address
(`you@storage.example`). Reflector then:

1. **discovers** your storage via [WebFinger](https://datatracker.ietf.org/doc/html/draft-dejong-remotestorage#section-10)
   (`src/remotestorage/webfinger.ts`) — the storage root plus its OAuth endpoint;
2. sends you to your provider's **consent screen** (OAuth 2.0 implicit grant,
   scope `reflector:rw`) and receives a bearer token back at
   `/remotestorage/callback` (the token arrives in the URL fragment, so a tiny
   page reads it and posts it to the server);
3. stores every record as a document at
   `<storage-root>/reflector/<calendar>/<resource>/<id>` via
   `RemoteStorageAdapter` (`src/remotestorage/adapter.ts`), mirroring the
   on-disk layout but over the remoteStorage HTTP protocol.

**Sync** after connecting (or disconnecting) to repopulate the copy in its new
home. The **ZIP download** works the same either way — it packages whatever
the active backend holds. Choose *Use local files* in the Storage dialog to
switch back. The bearer token is a secret and is persisted (owner-only)
alongside the Google tokens, outside the data set the ZIP packages.

## How it fits together

```
Browser SPA (public/)
      │  REST /api/*
      ▼
Express server (src/server) ── SyncEngine (src/sync/engine.ts)
                                     │
                                     ├── ResourceModel (src/sync/resources.ts)
                                     │      · discovers collections, hierarchy,
                                     │        and id rules from `crudResources`
                                     │
                                     ├── syncables ApiClient  (the sync engine)
                                     │      · full read (pagination)
                                     │      · local-first create/update/delete
                                     │      · background retry
                                     │
                                     ├── StorageBackend (src/sync/storage.ts)
                                     │      · FileStorageAdapter → JSON files on disk, or
                                     │      · RemoteStorageAdapter → the user's remoteStorage
                                     │      · either one enumerated → the ZIP
                                     │
                                     └── TokenManager (src/oauth/authed-fetch.ts)
                                            · injects the bearer token
                                            · fills {calendarId} in the path
                                            · retargets to the API base from the
                                              document's `servers`
                                            · refreshes on 401
```

**Nothing in `src/` is specific to Google or to the Calendar API.** The whole
flow is driven by the OpenAPI document and its overlays:

- the **OAuth flow** (`src/oauth/`) is derived from the document's `oauth2`
  security scheme — authorization/token/refresh URLs, scopes, the extra
  authorization-request parameters (`x-authorization-params`), and the userinfo
  endpoint (`x-userinfo-url`) — plus the API base from `servers` (see
  `deriveAuthProfile`). Only the OAuth *client id/secret* are deployment config.
- which **resources** exist, their URLs, how a nested collection's parent id is
  resolved, and how new ids are minted all come from the CRUD-causality
  overlay's `crudResources` (see `discoverResourceModel`). The engine walks that
  hierarchy generically; the calendar/event vocabulary lives only in the server
  layer that presents it.

The OpenAPI document is prepared once at startup (`src/sync/document.ts`):

1. load the vendored `spec/google-calendar-v3.openapi.yaml`;
2. apply the overlays in `spec/overlays/` — `auth-overlay.yaml` (OAuth security
   scheme), `pagination-overlay.yaml`, and `crud-causality-overlay.yaml`
   (`src/sync/overlay.ts` supports the overlays' bracketed
   `$.paths['/…'].get` targets, which the parser bundled with syncables does
   not);
3. adapt the overlays' `incrementalSync` pagination schemes into the `pageToken`
   shape the released syncables understands — keeping the `pageToken` /
   `nextPageToken` mechanics that drive the full read;
4. pin each list response's item array to the field the overlay's
   `envelope.itemsField` declares (Google's `Events` schema also has a
   `defaultReminders` array, which would otherwise be mistaken for the items).

Each nested collection client is given the same document narrowed to just that
collection's paths, and its own storage namespace (the parent context, e.g. the
calendar id), so sibling parents don't overwrite each other's records.

## Development

```sh
npm run build          # tsc to build/
npm test               # vitest unit + integration tests
npm run lint           # eslint
npm run prettier:check # formatting
```

Tests include an end-to-end `SyncEngine` test that runs the real syncables
engine and the real overlays against an in-memory stand-in for the Google
Calendar API, covering paginated full read, local-first create/update/delete,
sync-status tracking, and rollback on failure.

### The `syncables` dependency

`syncables` is installed from the npm registry (a pinned version) and ships
prebuilt, so no build step runs on install. `scripts/postinstall.mjs` remains
only as a fallback that builds it from source if an installed copy ever lacks a
prebuilt `build/` (e.g. a source checkout); against the published package it is
a no-op.

## Generative AI use

Reflector is developed collaboratively with **Claude Code** (Anthropic), an
agentic coding assistant: a human directs the architecture and reviews,
edits, and tests the changes it proposes before they're committed.

As an NLnet-funded project, this follows
[NLnet's Generative AI policy](https://nlnet.nl/foundation/policies/generativeAI/):

- Commits produced with AI assistance carry a `Claude-Session: <url>`
  trailer identifying the session that produced them.
- [`docs/ai-logs/`](docs/ai-logs) holds prompt/output disclosure logs for
  sessions going forward, redacted for secrets and personal information, per
  the policy's terms for a project that was already ongoing before the
  policy took effect (no retroactive backfill of every past session; known
  historical session links are indexed as pending in
  [`docs/ai-logs/pending-historical-sessions.md`](docs/ai-logs/pending-historical-sessions.md)).
- AI-drafted content is reviewed and edited by a human before being
  committed; it is not represented as unassisted human work.

## License

Apache-2.0
