# Google Calendar ↔ Atomic calendar

Imports one Google calendar's single (non-recurring) events into an Atomic
table, and sends edits of five fields back to Google after you review them.

## Supported path: the Calendar drive app

There is one supported way to run this plugin: the **drive app** in
[`app/`](app/). It runs in the host's null-origin plugin frame and reaches
Google only through the host's integration-proxy relay (`store.proxy`,
atomic-server#1657), for platform `google-calendar`. The frame names a
connection id, never a credential. The same shape as the Pets and Notion
drive apps.

1. **Install.** Not yet through the catalog: there is no catalog install flow
   for drive apps (#94). Today the e2e installs it test-side, as the Pets and
   Notion specs do. It makes a new App and replaces its entry point's source
   with `node integrations/calendar/app/build.mjs`'s bundle (`dist/ui.js`,
   about 40 KB).
2. **Connect.** "Connect Google Calendar" asks the host to show its consent
   bar. On Connect, the page goes to the integration-proxy and comes back
   with a connection the page holds.
3. **Choose a calendar.** The app lists `users/me/calendarList` and imports
   the one you choose (the primary one is preselected). The choice is stored
   on the app's table. A table never switches calendars; use a second app for
   a second calendar. Read-only calendars are labelled, and Google refuses
   edits to them.
4. **Import / Refresh.** A full, paged scan of the calendar's events (see
   _Scope_). New events become rows; Google-side edits update rows that were
   not edited here.
5. **Review and send.** A row edited here is listed with its changed fields
   (`Title: before → after`). Nothing is sent until you press "Send N changes
   to Google".

### What backs the catalog entry today

`catalog.json`'s `devonian-google-calendar` entry describes this drive app.
Two other runtimes live in this folder, and neither is reachable from the
pinned host (`2f403624e`):

- `adapter.ts` is also written as a **sandbox-plugin** adapter (`manifest()`
  with a `secret:google-calendar` placeholder). The drive app reuses its
  `preview`/`planEdit`/`applyEdit` unchanged, through `app/relay.ts`. But
  there is no `plugin.js` or `package.json` here, so the sandbox runtime has
  no bundle to run, and nothing certifies one.
- [`devonian/google-calendar/`](devonian/google-calendar/) is the Devonian
  lens of the LocalThought setup dialog flow. The pinned host's Integrations
  page draws no card for this entry and has no LocalThought dialog: its
  catalog entries only gate the "Show experimental plugins" toggle. Evidence
  gathered against that flow does not certify the drive app.

## Mapping

| Google Calendar                            | Atomic column                                   |
| ------------------------------------------ | ----------------------------------------------- |
| `summary`                                  | Name                                            |
| `description` (missing becomes empty text) | Description                                     |
| `location` (missing becomes empty text)    | Location                                        |
| All-day `start.date` / `end.date`          | Start / End (plain `YYYY-MM-DD`; End exclusive) |
| Timed `start.dateTime` / `end.dateTime`    | Start / End (offset-qualified)                  |
| whether `start.date` is set                | All day                                         |
| —                                          | Day: the date part of Start, for calendar views |

Start and End are stored as the exact strings Google sent. They are never
converted to numbers or to `Date` for storage. Day is a `date` column so the
host table's own Calendar view can place rows. It is derived on import and
never read back, so move an event by editing Start and End.

Each row also carries its binding, outside the table's columns: the Google
event id, the ETag last read, and the sync baseline. The baseline is JSON of
the five fields as both sides last agreed. It is what lets a refresh tell a
local edit from a Google edit.

## Scope and policies

Declared, not live-verified (see _Verification_):

- **Bounded import.** Full scans only, never a date window. Pages of 250
  (`maxResults=250`, `singleEvents=false`, `showDeleted=true`), up to 100
  pages, which is 25,000 events. Past that the import fails with "Pilot
  supports at most 25,000 events per scan" and writes nothing. A partial scan
  is never taken for the whole calendar.
- **Recurrence.** Series masters and all their instances are not imported,
  and the status line counts them ("Not imported: N recurring, M
  cancelled"). No partial mapping of a recurring event.
- **Cancellation.** A cancelled event that was never imported is only
  counted. For an imported event, cancellation in Google is a _conflict_:
  "Event cancelled, recurring or inaccessible; no deletion inferred". The
  local row stays. Nothing is ever deleted on either side.
- **Two-way edits.** Title, description, location, start and end, including
  all-day ↔ timed. Three-way reconciliation against the baseline
  (`adapter.ts` → `reconcileRecord`):
  - A Google edit to a field not edited here updates the row.
  - A local edit to a field Google did not change is offered for review.
  - The same field changed on both sides is a conflict. Neither side is
    overwritten.
  - A local value that can't be sent (an empty title, an interval that isn't
    valid) is held back and listed. Neither side changes.
  - Rows made in the table (no Google event id) are counted, never sent:
    creating events is not supported.
- **Conditional writes.** Each approved edit is one `PATCH` of only the
  changed fields, with `If-Match` set to the ETag that same preview read. A
  `412` marks only that event "Changed in Google since this preview; not
  sent", and it is reviewed again after a refresh. The baseline advances only
  for events Google confirmed.
- **Uncertain writes.** `store.proxy.request` can throw after the frame
  sent a write, for example when the response is lost, so the app cannot
  know whether Google applied the change. It reports "Unknown whether Google
  applied it" and stops sending the rest of the batch. It does not retry.
  Since #54 phase 2 nothing is spent by a lost response (there are no
  connection codes), so the next refresh works on the same connection and
  shows what Google has: if the change landed, the event simply agrees. A
  refusal by the proxy itself (`{ error }` with a proxy code, such as
  `not_delegated`) was not sent to Google; the app says "Connect again"
  when the connection is gone or no longer this app's.
- **Notifications.** Writes use `sendUpdates=none` (`adapter.ts`, and the
  Devonian write-back in `devonian/google-calendar/sync.ts`), so guests are
  not emailed about edits made through the app. The review sheet says so;
  notify guests from Google if an edit should reach them. This settles
  design #89, §11 decision 3. `app/sync.test.ts`, `adapter.test.ts` and
  `devonian/google-calendar/sync.test.ts` assert the query parameter.
- **Out of scope** (separate work, per #101): creating and deleting events,
  editing recurring events, attendees, reminders, conferencing data, and
  multi-calendar product design.

## Proxy catalog

The operations the app uses, confirmed against the composed `google-calendar`
catalog document. The overlays in
[`../../overlays/googleapis.com/google-calendar/v3/`](../../overlays/googleapis.com/google-calendar/v3/)
are byte-identical to the ones GitHub Pages publishes, and the proxy fetches
those at runtime. The checked-in composition is
`integration-proxy/tests/identity-catalog/google-calendar-composed.yaml`.
Server base: `https://www.googleapis.com/calendar/v3`, so relay paths keep
`/calendar/v3`.

| Relay call                                              | Catalog operation (scope)                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /calendar/v3/users/me/calendarList`                | `calendarList.list` (`calendar.calendarlist.readonly`)                                           |
| `GET /calendar/v3/calendars/{calendarId}/events`        | `events.list` (`calendar.events`)                                                                |
| `PATCH /calendar/v3/calendars/{calendarId}/events/{id}` | `events.patch` (`calendar.events`), `412` declared, `sendUpdates` enum `all\|externalOnly\|none` |

`integration-proxy/src/identity_catalog_tests.rs`
(`composed_google_calendar_permits_the_calendar_app_operations`) checks
exactly these calls, with their query strings, through `Catalog::allows`,
`required_headers` and `validate_request`. `If-Match` is not a catalog
question: `proxy.rs` `upstream_request` forwards it for any allowed
operation, and `browser_cors()` allows it in and exposes `ETag` out. The
Heroku deployment (`localthought/integration-proxy`) is a wrapper around
this crate at `ontola/atomic-plugins@494eb8a`, which already has both.
Whether that deployment has Google OAuth configured for `google-calendar`
has not been checked here.

## Host requirements

- `store.proxy` with `ifMatch` (atomic-server#1657). The pin, `2f403624e`,
  has it: view-client.js passes `ifMatch` through, and the page sends it as
  `If-Match`. Without `store.proxy` the app says the host can't reach the
  proxy and fetches nothing.
- **Read-your-writes after an app save** (atomic-server#1690, in the pin).
  An app's `save` is committed by the server (`/app-write`); before #1690
  the page kept serving its old copy of the row to the app's next `get`.
  This app reconciles against the baseline it saved, so on an older host the
  refresh after a successful send reports a false conflict.
- After an uncertain request, the page keeps the spent connection listed
  (`proxyConnections.list` still returns it). The app falls back past it to
  the newest working connection. A host that pruned it would be simpler.

## Verification

From the repository root, with the AGENTS.md layout (`browser/` linked to
the pinned atomic-server checkout):

```sh
./browser/node_modules/.bin/vitest run --config integrations/calendar/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/calendar/tsconfig.json
node integrations/tooling/run-lane.mjs calendar                 # typecheck, unit, e2e
node integrations/tooling/run-lane.mjs calendar --tier e2e
node --test integrations/localthought/mock-proxy.test.mjs
(cd integration-proxy && cargo test --lib composed_google_calendar_permits)
```

- **Unit** (`app/sync.test.ts`, `adapter.test.ts`): the whole drive-app path
  against the stateful fixture in
  [`fixtures/google-calendar/scenario.mjs`](fixtures/google-calendar/scenario.mjs),
  through a fake `store.proxy` that behaves like the host's frame client and
  the proxy: a lost response spends nothing, a revoked delegation answers
  `403 not_delegated`. Covered: calendar list and selection; the
  paged import with its page cap; all-day and timed rows; recurring and
  cancelled skips; refresh; review; `If-Match` on send; `412`; both-changed
  conflicts; a lost response followed by a reconnect; cancellation after
  import; local-only and invalid rows. `app/build.test.ts` checks that the
  bundle is one ES module with no storage, `fetch` or credential of its own.
- **Host e2e** (`e2e/calendar.spec.ts`, lane `calendar`, tier `e2e`): the
  same path in the real plugin frame on the pinned host, with the mock
  integration proxy. It connects through the consent bar, chooses a
  calendar, imports and checks the rows, then refreshes after a Google-side
  edit made through the mock's test drivers
  (`POST /fixture/google-calendar/…`). It then sends a reviewed edit
  (checking the fixture received that `If-Match`), sends into a `412`, and
  loses a `PATCH` response (Playwright lets the request reach the mock, then
  aborts the response), reconnects, and checks that the preview agrees.
- **Live: not verified.** No run against a real Google account exists for
  this path. Evidence from the retired LocalThought/Devonian flow does not
  count for it. To verify, with authorized credentials and a disposable
  calendar: deploy or point the host at an integration-proxy with Google
  OAuth configured for `google-calendar`, install the app as above, create
  one all-day event, one timed event, one weekly series and one cancelled
  event, then run the e2e's steps by hand and record the outcomes. The one
  step that can't be forced against Google is the lost response.

API reference: https://developers.google.com/calendar/api/v3/reference/events
