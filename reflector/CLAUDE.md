# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The repo uses **pnpm** (`packageManager` pins `pnpm@10.33.0`; there is no `package-lock.json`, so `npm ci` will not work — CI runs pnpm).

```sh
pnpm install            # also builds the `syncables` dependency (postinstall)
pnpm build               # tsc -> build/
pnpm dev                  # build + start
pnpm start                 # NODE_OPTIONS=--enable-source-maps node build/src/main.js
pnpm test                   # vitest run unit --config __tests__/vitest.config.ts
pnpm test:harness            # vitest run harness -- the reflection test harness (see harness/)
pnpm test:coverage            # unit tests with v8 coverage
pnpm lint                      # eslint .
pnpm prettier:check             # prettier --check
pnpm prettier                    # prettier --write
```

Run a single test file: `pnpm exec vitest run __tests__/unit/engine.test.ts --config __tests__/vitest.config.ts`
Run tests matching a name: `pnpm exec vitest run --config __tests__/vitest.config.ts -t "pattern"`

Node `>= 22.11 < 23` is required (see `engines` in package.json). Requires `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` to actually run the server locally (see README's Configuration table).

### The `syncables` dependency

`syncables` (`syncables@0.16.0`, the sync engine) is installed from the npm registry. `scripts/postinstall.mjs` builds it from source on install if the installed copy lacks a prebuilt `build/` (a no-op when it is already built). If you install with `--ignore-scripts`, build it manually:

```sh
cd node_modules/syncables && npm install && npm run build:release
```

## Architecture

Reflector is **not Google-Calendar-specific in `src/`**. The entire sync flow — OAuth, resource discovery, pagination, CRUD — is derived generically at startup from an OpenAPI document plus OpenAPI Overlays; only the server layer knows it's presenting calendars/events.

```
Browser SPA (public/)
      │  REST /api/*
      ▼
Express server (src/server) ── SyncEngine (src/sync/engine.ts)
                                     │
                                     ├── ResourceModel (src/sync/resources.ts)
                                     │      discovers collections/hierarchy/id rules from crudResources
                                     │
                                     ├── syncables ApiClient (external dep — the actual sync engine)
                                     │      full read w/ pagination, local-first create/update/delete,
                                     │      background retry
                                     │
                                     ├── StorageBackend (src/sync/storage.ts)
                                     │      FileStorageAdapter (JSON on disk) or
                                     │      RemoteStorageAdapter (user's remoteStorage) — either is
                                     │      what the ZIP download enumerates
                                     │
                                     └── TokenManager (src/oauth/authed-fetch.ts)
                                            injects bearer token, fills {calendarId} in the path,
                                            retargets to the API base from the document's `servers`,
                                            refreshes on 401
```

### Document preparation (`src/sync/document.ts`), run once at startup

1. Load the vendored `spec/google-calendar-v3.openapi.yaml`.
2. Apply overlays from `spec/overlays/`: `auth-overlay.yaml` (OAuth security scheme), `pagination-overlay.yaml`, `crud-causality-overlay.yaml`. `src/sync/overlay.ts` implements support for the overlays' bracketed `$.paths['/…'].get` targets — the parser bundled with `syncables` doesn't handle that syntax.
3. Adapt the overlays' `incrementalSync` pagination scheme into the `pageToken` shape the released `syncables` understands.
4. Pin each list response's item array to the field declared in the overlay's `envelope.itemsField` (e.g. Google's `Events` schema also has a `defaultReminders` array that would otherwise be mistaken for the items).

Each nested collection client gets the document narrowed to just that collection's paths, plus its own storage namespace (the parent context, e.g. calendar id) — so sibling parents don't clobber each other's records.

### OAuth is document-derived (`src/oauth/`)

`deriveAuthProfile` reads authorization/token/refresh URLs, scopes, extra `x-authorization-params`, the userinfo endpoint (`x-userinfo-url`), and the API base (`servers`) straight from the document's `oauth2` security scheme. Only the client id/secret are deployment config (`OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET`, with `GOOGLE_CALENDAR_CLIENT_ID`/`GOOGLE_CALENDAR_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` accepted as legacy fallbacks).

### Resource discovery is document-derived (`src/sync/resources.ts`)

Which resources exist, their URLs, how a nested collection's parent id resolves, and how new ids are minted all come from the CRUD-causality overlay's `crudResources`. `discoverResourceModel` walks that hierarchy generically.

### Multi-user model

Each browser session is a separate connected user (opaque httpOnly session cookie), with its own OAuth tokens, its own local-first copy (`${DATA_DIR}/copies/<account>`), and its own `SyncEngine` — concurrent users never see or overwrite each other's data. A connected remoteStorage account is scoped to the single user who connected it.

Per-user record persistence is pluggable (`src/server/user-store.ts` vs `src/server/user-store-postgres.ts`):
- **Files** (default) — one owner-only JSON file per user under `${DATA_DIR}/users` (`USERS_DIR` to override). Needs a persistent disk.
- **Postgres** — set `DATABASE_URL`; users go into an auto-created `reflector_users` table instead. Needed on hosts with ephemeral disks (Heroku dyno, DO App Platform).

An instance upgraded from the earlier single-user build migrates its existing `tokens.json`/`remotestorage.json` into the file store on first start.

### remoteStorage as an alternate system of record

By default the local-first copy is plain JSON files under `DATA_DIR`. Since `syncables` only ever talks to a pluggable `StorageAdapter`, that can be swapped for the user's own [remoteStorage](https://remotestorage.io/) account instead:

1. discover the storage via WebFinger (`src/remotestorage/webfinger.ts`) — storage root + OAuth endpoint;
2. OAuth 2.0 implicit grant (scope `reflector:rw`) to the provider's consent screen, token returned at `/remotestorage/callback` (arrives in the URL fragment; a tiny page reads it and posts it to the server);
3. every record is stored as a document at `<storage-root>/reflector/<calendar>/<resource>/<id>` via `RemoteStorageAdapter` (`src/remotestorage/adapter.ts`), mirroring the on-disk layout over the remoteStorage HTTP protocol.

The bearer token is persisted owner-only alongside the Google tokens, outside the data set the ZIP packages. A resync is needed after switching backends to repopulate the copy in its new home.

## Testing

`pnpm test` runs `vitest run unit`, which covers only `__tests__/unit/**` (not `spec/`, which holds the vendored OpenAPI document and overlays, not tests). Notably `__tests__/unit/engine.test.ts` runs the real `syncables` engine and the real overlays against an in-memory stand-in for the Google Calendar API — covering paginated full read, local-first create/update/delete, sync-status tracking, and rollback on failure. Prefer extending that style of test (real engine + real overlays + fake HTTP) over mocking `syncables` internals when testing sync behavior.

### Reflection harness (`harness/`, run with `pnpm test:harness`)

A separate, opt-in suite (`harness/**/*.test.ts`) for testing Reflector's job of *reflecting* changes from one system of record to another. It is deliberately **not** part of `pnpm test` so the unit suite stays the fast, primary gate; it runs as its own CI step and pre-release. `harness/README.md` is the full guide. In short:

- Roles are kept strictly separate so nothing grades its own homework: a **Driver** writes changes, a **StubReflector** / **BidirectionalReflector** stands in for the system under test, a **Reviewer** observes the result, and a SUT-independent **oracle** judges correctness.
- Driver and reviewer are thin custom code over the raw `syncables` client (not the app's `SyncEngine`), with an in-memory `FakePlatform` standing in for a real remote system. These are the two seams to swap for a live run: `FakePlatform` → a real platform + credentials, and `StubReflector.reflectNow()` → a trigger to the real SUT.
- Scenarios cover the failure modes: wrong content (`mismatch`), not-in-time (`timeout`), ping-pong loops (`looped`, via origin-marker echo suppression), and cross-shape mapping (a differently-shaped target platform validated by a mapping-aware oracle).

When extending it, keep the roles and the oracle independent of the reflector's own mapping — that separation is what makes the harness able to catch a broken reflection rather than rubber-stamp it.

## Generative AI disclosure (NLnet policy)

This project is NLnet-funded and follows [NLnet's Generative AI policy](https://nlnet.nl/foundation/policies/generativeAI/). If you (an AI coding assistant) make a commit here, keep it compliant:

- **Commit trailer.** Every commit produced with AI assistance carries a `Claude-Session: <url>` trailer (see the git commit instructions this session was given, or match the existing convention in `git log`).
- **Session log.** For any session that produces a commit, add or update a file under [`docs/ai-logs/sessions/`](docs/ai-logs/sessions) named `YYYY-MM-DD-<short-slug>.md`, following the format of existing entries there: session URL, model name/version, the substantive human prompts and substantive assistant outputs (not the harness's internal system prompt or tool-call plumbing — see [`docs/ai-logs/README.md`](docs/ai-logs/README.md) for what's in/out of scope).
- **Redact before committing.** Review the log for credentials, personal information (emails, etc.), and other session-identifying detail that isn't needed to understand what was asked and produced; mark redactions inline as `[redacted]` rather than deleting silently.
- **No retroactive backfill required.** Per the policy's exception for already-ongoing projects, don't try to reconstruct historical sessions that predate `docs/ai-logs/` — if you find an old `Claude-Session:` link with no matching log, add it to [`docs/ai-logs/pending-historical-sessions.md`](docs/ai-logs/pending-historical-sessions.md) instead of fabricating a transcript.
- **Keep the README in sync.** If how AI is used on this project changes in a way that makes the README's "Generative AI use" section inaccurate, update that section too.
- **Don't present AI output as unassisted human work,** and don't skip human review/testing before committing — both are conditions of the policy, not just house style.
