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

1. **Install.** From the catalog: entry `calendar` (experimental; published but disabled pending launch: the catalog entry carries the module and its integrity with `enabled: false`, so the Integrations page does not offer it yet; the lanes' dev-server serves it enabled (`DEV_SERVER_ENABLE_APPS`), which is how the e2e installs it). Once enabled it is listed under the
   Integrations page's **Drive apps**. The host downloads
   `apps/calendar/<version>/ui.js` (`app/build.mjs`'s bundle, minified,
   103,857 bytes for 0.1.0) from GitHub Pages and refuses it unless it
   matches the entry's integrity hash (see
   [Publishing a drive app](../README.md#publishing-a-drive-app)). The e2e
   installs it that way, from the committed module the lane's dev-server
   serves. A release bumps `app/package.json` and the catalog's `version`,
   then runs `node integrations/tooling/apps.mjs write calendar`.
2. **Connect.** "Connect Google Calendar" asks the host to show its consent
   bar. On Connect, the page goes to the integration-proxy and comes back
   with a connection the page holds.
3. **Choose a calendar.** The app lists `users/me/calendarList` and imports
   the one you choose (the primary one is preselected). The choice, and the
   calendar's name, colour, access role and the account's address, are
   stored on the app's table. A table never switches calendars; use a second
   app for a second calendar. Read-only calendars are tagged, and their
   events never offer Edit.
4. **Sync now.** A full, paged scan of the calendar's events (see _Scope_),
   on open and on "Sync now". New events become rows; Google-side edits
   update rows that were not edited here. Reads never write to Google.
5. **Look and edit.** Agenda (the default below 720px) and Week (3, 5 or 7
   days by width, with a sidebar from 900px). An event opens in a drawer;
   Edit changes exactly the five mapped fields and saves to the row only
   ("Saved here · not sent to Google yet"). "Open in Google Calendar" asks
   the host to open the event's Google page. Rows edited in the host's table
   show up the same way after the next sync.
6. **Review and send.** "Review N changes" lists each changed field
   (before → after), with Discard per event. Nothing is sent until you press
   "Send N changes"; each row then reports Sent, Changed in Google (a `412`,
   with Review again), or Unknown whether Google applied it.
7. **Conflicts.** A field changed both here and in Google is left as is
   until you pick "Keep mine" or "Use Google's" per field; a kept value goes
   to the review list, never straight to Google. An event gone from Google
   can be kept as a local event or, after an in-page confirmation, removed
   here. Nothing is ever deleted in Google.

The UI follows [`design/`](design/) (#89); see _Design decisions_ below for
where it differs from the mockups.

### What backs the catalog entry today

`catalog.json`'s `calendar` entry (called `devonian-google-calendar`, with
`requires-api-plugins`, before the drive app was published) describes this
drive app and installs it. Two other runtimes live in this folder, and
neither is reachable from the pinned host:

- `adapter.ts` is also written as a **sandbox-plugin** adapter (`manifest()`
  with a `secret:google-calendar` placeholder). The drive app reuses its
  `preview`/`planEdit`/`applyEdit` unchanged, through `app/relay.ts`. But
  there is no `plugin.js` or certified `package.json` here (`app/package.json`
  only records the drive app's version), so the sandbox runtime has no
  bundle to run, and nothing certifies one.
- [`devonian/google-calendar/`](devonian/google-calendar/) is the Devonian
  lens of the LocalThought setup dialog flow. The pinned host has no
  LocalThought dialog. Evidence gathered against that flow does not certify
  the drive app.

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

- **Unit, views** (`app/view.test.ts`, jsdom; `app/controller.test.ts`,
  `app/events.test.ts`, `app/contrast.test.ts`): every screen of the design
  against the fake store, the banner copy for each provider status, agenda
  grouping and week packing (exclusive all-day ends, midnight crossings,
  viewer zone), local edits stored as offset-qualified strings, and the
  event tints' contrast for Google's 24 classic calendar colours.
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
  integration proxy. Each test installs the app from the catalog's Drive
  apps section (the committed `apps/calendar/<version>/ui.js`, served by the
  lane's dev-server). It connects through the consent bar, chooses a
  calendar, imports and checks the rows, then refreshes after a Google-side
  edit made through the mock's test drivers
  (`POST /fixture/google-calendar/…`). It then sends a reviewed edit
  (checking the fixture received that `If-Match`), sends into a `412`, and
  loses a `PATCH` response (Playwright lets the request reach the mock, then
  aborts the response), syncs again, and checks that the preview agrees. A
  second test renders the imported calendar in 360, 720 and 1200px frames
  under the host's light and dark themes: no sideways scroll, no axe
  violations, and the theme switch restyles the frame without a reload.
  Screenshots are attached to the Playwright report.
- **Live: not verified.** No run against a real Google account exists for
  this path. Evidence from the retired LocalThought/Devonian flow does not
  count for it. To verify, with authorized credentials and a disposable
  calendar: deploy or point the host at an integration-proxy with Google
  OAuth configured for `google-calendar`, install the app as above, create
  one all-day event, one timed event, one weekly series and one cancelled
  event, then run the e2e's steps by hand and record the outcomes. The one
  step that can't be forced against Google is the lost response.

## Design decisions

Where the implementation of [`design/`](design/) had to choose:

- **One calendar per app.** The picker (5.4) uses radio buttons, not the
  mockup's checkboxes: the table model binds one calendar per table (#101).
  The header shows that calendar's chip; it toggles visibility only.
  "Choose calendars" in the connection menu is disabled with that
  explanation. Multi-calendar import would need a per-row calendar id and
  one preview per calendar.
- **Month** (§11 decision 1) hands off: "Month ↗" (and `m`) opens this
  app's table in the host with `store.openResource`, where the table's own
  Calendar view shows the month. The app draws no month grid.
- **Outlook and Apple** are shown as "Not available yet" (§11 decision 2).
- **"Open in Google Calendar"** uses `store.openExternal`: the frame has no
  popup rights, so the host shows the destination and asks first. The link
  is Google's `htmlLink`, kept on each row on import (`google-link`,
  display only). The drawer shows the event's own UTC offset (from the
  stored string), not a named time zone, since `timeZone` is not imported.
- **Disconnect** in the connection menu calls `store.proxy.disconnect`: only
  this app's delegation goes; the connection (other apps may use it) and
  the rows stay.
- **Host operations are feature-detected.** `openExternal`, `openResource`,
  `proxy.disconnect` and `getTheme`/`onThemeChange` arrived at pin
  007869464; on an older host their controls are not shown, and dark mode
  is read from the luminance of `--t-color-bg-body`.
- **Last view is not remembered.** The null-origin frame has no usable
  `localStorage`, and the build test forbids storage; the default view is
  chosen by width on every open.
- **Week scroll** starts at 08:00 when now is within 08:00–18:00, otherwise
  one hour before now.
- **Theme.** `data-pl-theme` follows `store.getTheme()` and
  `store.onThemeChange()`; `--pl-pos` reads the host's `--t-color-success`.
- **Banner actions.** 403 and 404 offer Retry (there is no other calendar
  to choose in this app); after an uncertain write the action is Sync now.
- **Colour.** The week time line mixes `--pl-text` into `--pl-muted`, and
  pill text is mixed a quarter towards `--pl-text`: the plain tokens fall
  under 4.5:1 on their tinted backgrounds.
- **Shared chrome** (`app/ui/`) stays in this plugin; moving it to a shared
  kit is the maintainer's decision.

API reference: https://developers.google.com/calendar/api/v3/reference/events
