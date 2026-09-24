# LocalThought: the shared mock proxy and what is left of the old flow

This folder holds:

- **`mock-proxy.mjs`**, the local-only integration proxy every e2e lane
  runs (`integrations/tooling/serve.mjs` starts it on the lane's
  `mockProxy` port). Never deploy it.
- **`mock-proxy-auth.mjs`**, its copy of the real proxy's 0.2
  authentication checks, plus a test signer.
- **`no-credentials-in-graph.test.mjs`**, the text scan that keeps
  credentials out of shipped plugin source and the graph.
- `plugin.ts`/`schema.ts`, the generic sandbox mapper and platform schema
  from the retired runtime (below); `issue-tracker/` still imports
  `schema.ts`.

Current provider integrations are drive apps; see
[`../README.md`](../README.md#building-a-localthought-reflectorsyncablesdevonian-connector)
and [`../READINESS.md`](../READINESS.md).

## The mock proxy

It speaks the protocol of `integration-proxy` 0.2 (ontola/atomic-plugins#54,
[`../../integration-proxy/`](../../integration-proxy/)) on every route a
client uses, and checks every signature the way the real proxy does, so a
host that signs wrongly fails the e2e:

| Route                                                                                                                                                                    | What the mock does                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /connect?platform&redirect_uri&code_challenge&code_challenge_method=S256`                                                                                           | Consent page. No login and no `user_id`; the retired `user_id`/`credentials` parameters are refused. `redirect_uri` must be the lane's own `/app/integrations` (stricter than the real proxy). An API-key platform (a catalog document with an `apiKey` security scheme: `clockify`) shows an "API key" field and "Connect Clockify"; others show "Use LocalThought to sync {title} with this destination", as `integration-proxy/src/templates.rs` does. |
| `POST /connect/authorize`                                                                                                                                                | The consent form. Stands in for the provider's OAuth and returns `redirect_uri?connection_code=<handoff>` (single use, 5 min), or `?error=access_denied` on Cancel.                                                                                                                                                                                                                                                                                       |
| `POST /connect/redeem`                                                                                                                                                   | Signed (v2). `{code, code_verifier}`; the signer becomes the owner. Answers `{connection_id, platform, owner}`.                                                                                                                                                                                                                                                                                                                                           |
| `GET /connections`, `DELETE /connections/{id}`, `POST /connections/{id}/agents`, `DELETE /connections/{id}/agents/{agent}`, `POST /runtimes`, `DELETE /runtimes/{agent}` | Signed (v2) management, owner only, with the real proxy's response shapes.                                                                                                                                                                                                                                                                                                                                                                                |
| `ANY /proxy/{connection_id}/{platform}/{path}`                                                                                                                           | A frame's `Authorization: Capability <payload>.<sig>` plus a v2 signature by the capability's `cnf` key; or a request signed by the owner, a delegated app, or a registered runtime of a delegated app. Then the platform's fixture answers.                                                                                                                                                                                                              |
| `GET /catalog`, `/catalog/<platform>.yaml`, `.selection.json`                                                                                                            | The fixtures' catalog documents.                                                                                                                                                                                                                                                                                                                                                                                                                          |

Checks, in the real proxy's order and with its `{error, message}` codes
(`integration-proxy/src/api_error.rs`): v2 request signatures (headers
`x-atomic-agent`, `x-atomic-public-key`, `x-atomic-timestamp`,
`x-atomic-signature`, `x-atomic-signature-version: 2`; message
`atomic-request-v2\nMETHOD\nURL\ntimestamp\nsha256(body)`; ±5 min; each
signed request accepted once), agent ids (`atomic:agent:` or
`did:ad:agent:`, either base64 alphabet; stored as
`atomic:agent:<base64url>`), and capabilities (owner signature over
`integration-proxy-capability-v2\n` + the JSON claims, exact claim set,
`aud` = the mock's origin, `exp` at most 900 s ahead, connection and
platform against the route, the `app`'s delegation, then the request
signature by `cnf`).

**The signed URL.** Signatures cover the full URL, so every client must
use exactly the mock's origin, `MOCK_PROXY_BASE_URL` (the real proxy's
`BASE_URL`). `serve.mjs` sets it, `INTEGRATION_PROXY_URL` (the browser's
proxy setting) and `ATOMIC_INTEGRATION_PROXY_URL` (the server's) to the
same `http://127.0.0.1:<port>`. A request signed for `localhost` instead
fails with `bad_signature`.

**What it does not have:** Postgres (state is in memory, per process),
real OAuth, sealed credentials (it holds none; a pasted API key is checked
for being non-empty and dropped), the 90-day idle sweep, the refresh lease,
and the SaaS access policy (every agent is admitted).

**Shared vectors.** `mock-proxy.test.mjs` verifies the golden v2 request
vectors (`integration-proxy/tests/fixtures/atomic-request-v2-vectors.json`,
a copy of atomic-server's `lib/src/authentication_v2_vectors.json`) and
atomic-server's pinned capability vector against `mock-proxy-auth.mjs`, and
re-derives each vector's signature with the test signer.

**Test-side routes** (no signature; the mock only listens locally):

- `POST /__fixture/<platform>`: a fixture's `control(command)` (Clockify's
  failure injection and data changes).
- `POST /fixture/<platform>/<driver>`: one of the drivers a fixture lists
  (`drivers`), with a JSON array of arguments.
- `GET /__mock/connections`: every connection with its owner, delegations
  and `last_used_at`, and every runtime. No credential: the mock holds
  none.
- `POST /__mock/revoke` `{connection_id, agent?}`: drops one delegation, or
  the whole connection, as the owner would from another device.

Fixtures live in their plugin folders; see
[`fixtures/index.mjs`](fixtures/index.mjs). They still see provider paths
under `/proxy/<platform>/…`: the mock strips the connection id first.

Run it alone, and its tests:

```sh
MOCK_PROXY_PORT=19091 MOCK_FRONTEND_ORIGIN=http://localhost:6748 node integrations/localthought/mock-proxy.mjs
node --test integrations/localthought/mock-proxy.test.mjs integrations/localthought/no-credentials-in-graph.test.mjs
```

## Deleted in #54 phase 2

`browser.ts` (`BrowserIntegrations`: catalog discovery, OAuth/PKCE and the
rotating-code proxy call), `settings.ts` (the proxy-origin setting and
per-origin connection keys), their tests and `browser-smoke.mjs`. They
spoke the proxy's retired connection codes (`Authorization: Bearer`,
`X-Connection-Code`), and nothing imported them: atomic-server's
`helpers/proxyConnections.ts` replaced them. The sections below describe
the runtime they belonged to, as history.

## Historical server-flow verification

The server-owned tenant-secret flow described by the historical notes below is
superseded by the browser redirect and PKCE flow. Live verification of the new
LocalThought login, selected-platform consent and one-time redemption is checked
separately after matching deployments and recorded in PR/release verification.
The fixture tests below do not claim live-provider verification.

Live verification on 2026-09-09 succeeded against proxy Heroku release v38
(`5960ae43`): OAuth returned to AtomicServer, Syncables fetched 29 issue/PR
records from `localthought/integration-proxy` and queried all 29 comment
collections (empty), and the reviewed records were applied and displayed in
the local AtomicServer table with generated platform properties.

Proxy fixes [#28](https://github.com/localthought/integration-proxy/pull/28)
and [#29](https://github.com/localthought/integration-proxy/pull/29) add the
required GitHub User-Agent and preserve query parameters and Link headers.
This live repository fit on one issues page; multi-page traversal is covered
by the mock and Rust tests. Google Calendar was also live-verified against proxy v39 after
[PR #30](https://github.com/localthought/integration-proxy/pull/30) fixed matching
OpenAPI server base paths. OAuth returned successfully, and a UTC range from
2026-09-09 through 2026-10-09 (exclusive) imported 22 calendar-list entries and
32 events after review. Event contents are not included in these test notes.
An unbounded fetch successfully traversed multiple pages but exceeded the
5,000-record preview limit; the UI now defaults to the next 30 days. Date
bounds and recurrence expansion are passed to Syncables as collection query
settings. That historical verification exercised the earlier manual snapshot importer.

## Calendar view

This section describes the retired LocalThought import, which also imported
recurring series, expanded instances and cancellations. The pinned host no
longer offers that setup-dialog flow, and evidence below does not certify the
supported Calendar path: the drive app in
[`../calendar/README.md`](../calendar/README.md), which skips recurring and
cancelled events. The lens in `../calendar/devonian/google-calendar/` still
carries recurrence query and projection helpers from the old flow.

Google event imports now install a Calendar view alongside the source table.
The projected date uses the day in Google's supplied start offset (or the
unchanged all-day date), so mixed all-day/timed events share one DATE column.
The original Start and End objects retain timezones and exclusive end values.
All-day events display on every covered day, excluding the end date, and are
marked All day. Their DATE projection does not shift with the viewing timezone.
Timed events still display on their start day only. Refresh existing imports
to install the new exclusive end-date projection. Additional notes identify recurring events, attendees,
reminders and conferencing when those fields are returned by the catalog.
Recurring instances are expanded by the existing bounded provider fetch.

Open the installed folder or its Calendar table to refresh automatically.
Existing source identities and import baselines prevent duplicates and preserve
Atomic-only fields and local edits. Cancellation records are retained with a
note; absence from a bounded fetch never deletes an Atomic resource. Google
may omit cancelled events from list results, so this is not a deletion feed.
Removed optional provider fields are not cleared by the shared snapshot importer.

### Reviewed two-way event edits

From the installed folder or table, use **Preview edits for
Google** and **Apply edits to Google**. Name/Summary, Description, Location,
Start and End on existing imported events sync back to their original calendar
and event ID, including individual recurring instances. Incoming Google changes refresh automatically when the folder or table opens.

Preview compares the import baseline with a fresh Google event. Conflicts block
preview. Apply checks local values still match the review and sends only changed
fields with `If-Match`; a changed Google ETag blocks the write. Successful writes
checkpoint the baseline. After a lost checkpoint, preview acknowledges matching
Google values without another PATCH. Uncertain transport requires reconnection.
Partial batches retain completed checkpoints and must be previewed again.
Writes are sent with `sendUpdates=none`: guests are not emailed about edits
made through the app. Notify them from Google if an edit should reach them.

New events, deletion, recurrence rules, guests/RSVP, reminders and conferencing
remain managed in Google. Change Start/End together for timed/all-day conversions;
projected Calendar day/all-day columns are display fields refreshed on import.
Atomic-only fields are preserved. Outbound editing of existing events remains manual. Inbound refresh runs in
the browser; this is not a complete Calendar mirror.

**Deployment requirement:** `integration-proxy`'s CORS/`If-Match` forwarding
and the `calendar.events`/`calendar.calendarlist.readonly` OAuth scopes are
already generic, already-shipped behavior there — not gated behind any patch
in this repo. What was still missing was narrower: the composed
`google-calendar` catalog `integration-proxy` loads (from
`localthought/overlays`, now this repo's [`overlays/`](../../overlays/))
only ever declared `GET` operations, so a `PATCH`
never reached Google no matter what the proxy or scope allowed. That catalog
gap is closed by
[overlays#168](https://github.com/localthought/overlays/pull/168) (adds the
one write operation this lens sends — a partial event update, matching
`applyCalendarEdit`'s `summary`/`description`/`location`/`start`/`end` fields
and `If-Match`) and
[integration-proxy#76](https://github.com/localthought/integration-proxy/pull/76)
(bumps the deployed `DEFAULT_CATALOG_PATH` pin to it). overlays#168 also
migrates the underlying base document: `ontola/openapi-directory` removed the
hand-written, read-only `google-calendar/v3` subset the earlier
[overlays#166](https://github.com/localthought/overlays/pull/166) was built
against, replacing it with a regenerated, full `calendar/v3` document
converted from Google's own Discovery document. Both PRs need merging and
the service needs restarting to pick up the new pin before any write reaches
Google. Reconnect existing Google accounts if the wider `calendar.events`
scope wasn't already exercised in this deployment; Calendar reconnection
retains the original installation identity and imported tables. No production
deployment or live account writes have been performed as part of this work.

## Todoist tasks lens

The `devonian-todoist` catalog entry connects the proxy's `todoist` platform
through the same generic flow, with a read-only Devonian lens
(`../issue-tracker/todoist.ts`) on the way in. The proxy's Todoist catalog only grants
`data:read`, so the lens has no write direction and the folder's Sync panel
has no "preview edits" step: closing, editing or creating an issue locally
is never sent to Todoist.

Syncables names a record after `title`, `summary` or `name`; a Todoist task
has none of those, so the lens names each row after its `content`. It adds
three projected columns beside the provider's own fields: `done` (from
`checked`), `due-day` (from `due.date` or the day of `due.datetime`) and
`priority-label` (Normal / Medium / High / Urgent). The tasks table opens in
the Issues view, split open/closed by `done`, with the plain table one tab
over; the same `due-day` column also works as a Calendar view's date.
Todoist's `/tasks` lists active tasks only, so `done` is true only when
Todoist itself reports a task checked. What happens to a task that stops
appearing (`presence`, `last-seen`, `reconcileTodoistTasks`) is described in
[`../issue-tracker/README.md`](../issue-tracker/README.md#todoist-tasks-that-stop-appearing);
no host calls it yet (nor, at the pinned atomic-server, the projection).

Installation records the lens as `extension: 'tasks'` and identity suffix
`:devonian-tasks`. A Todoist folder installed from the raw proxy card
(`proxy:todoist`, `extension: 'none'`) stays a plain import; the lens is
never implied for an existing installation. `../issue-tracker/todoist.test.ts` covers the
projection; the OAuth connection itself is checked manually against the live
proxy, as for the other platforms.

## Browser-only Calendar regression

`browser/e2e/tests/google-calendar-import.spec.mts` starts the shared mock
integration-proxy with a synthetic Google Calendar. The test selects Calendar,
completes the mock PKCE consent and redemption, and exercises real browser
credential rotation, one-request access validation, WASM pagination, local schema
installation, automatic OPFS application, and Calendar rendering. It holds the
initial import until the installed folder is open, refreshes changed provider
data on reopening without a button, and checks that native identities and
Atomic-only notes and local title edits survive reload. A browser clock verifies
the five-minute timer. It also verifies failed refreshes preserve
records and reopening recovers. Both expanded instances and retained recurring
series are covered.
AtomicServer HTTP and all WebSockets are blocked throughout; only GET requests
are permitted for provider data. The configured LocalThought origin is forwarded
to the isolated HTTP fixture, so no live provider credentials or data are used.

Run with a dev frontend built from this branch and its matching WASM bundle:

```sh
FRONTEND_URL=http://127.0.0.1:6747 SERVER_URL=http://127.0.0.1:19999 \
  browser/e2e/node_modules/.bin/playwright test \
  --config browser/e2e/playwright.config.ts \
  browser/e2e/tests/google-calendar-import.spec.mts --project chromium
```

If the frontend uses `VITE_INTEGRATION_PROXY_URL`, pass the same value to the
test process. The test forwards that origin to its own fixture. Live Google
OAuth on the browser path still depends on the proxy CORS deployment described
above; this fixture test does not claim live-provider verification.

Verification: the focused LocalThought fixture and frontend checks cover the
redirect, PKCE, rotation and import paths. Live LocalThought login, consent,
redemption and Google write verification remain pending.

Each OAuth authorization creates a separate import installation. The proxy does
not provide a verified provider account identity, so reconnecting (even to the
same account to change scopes) creates new tables instead of reusing a previous
account’s tables. Repeated imports using the same connection reuse its tables.
