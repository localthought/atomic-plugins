# Calendar plugin — frontend design

Status: design proposal for issue #89. Nothing here is implemented yet; the
mockups in [`mockups.html`](mockups.html) are static and the implementation
work is split into [`issues.md`](issues.md). Where this document says a
capability "is declared", it means the adapter or lens code supports it in
unit tests; none of it has current live evidence against Google (see
[`../../README.md`](../../README.md#one-certification-command)).

## 1. Where the plugin is today

| Piece                       | What exists                                                                                                                                                                                                                                                                                                                                                                                    | What the user sees                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `adapter.ts`                | Sandbox-shape preview/edit for **one** Google calendar: full paged scan (250 per page, fails loudly above 100 pages = 25,000 events), maps title/description/location/start/end, skips recurring (series and instances) and cancelled events, reconciles against a baseline, patches only changed fields with `If-Match` (ETag), treats 412 as "changed since preview", never infers deletion. | Nothing of its own.                                                                                                        |
| `devonian/google-calendar/` | Lens + `calendarProjection` adding `atomic-calendar-day`, `-end-day` (exclusive), `-all-day`, `-notes`; `calendarRecurrenceProjection` for display-only recurrence; `planCalendarValues` for reverse field mapping.                                                                                                                                                                            | The host's generic table page, including its month `CalendarView` (`browser/data-browser/src/chunks/TablePage/Calendar/`). |
| Catalog                     | `devonian-google-calendar`, experimental, "Connect through LocalThought, then use Sync now".                                                                                                                                                                                                                                                                                                   | A catalog card and the generic LocalThought connect flow.                                                                  |
| iframe app                  | **None.** There is no `integrations/calendar/app/`, no `plugin.js`, no `view()`.                                                                                                                                                                                                                                                                                                               | —                                                                                                                          |

Platforms named in the issue:

- **Google Calendar** — the only one with adapter code, overlays in
  `localthought/overlays/googleapis.com/google-calendar/` and an OAuth
  registration path in integration-proxy (`OAUTH_GOOGLE_CALENDAR_*`).
- **Outlook Calendar** — nothing exists: no Microsoft Graph overlay, no proxy
  OAuth app. The chrome is designed to hold it (connection bar, calendar
  list), but it is out of scope now.
- **Apple Calendar** — iCloud exposes CalDAV with an app-specific password,
  not OAuth. That does not fit the proxy's "connection id, never a credential"
  model as written. Out of scope now; needs a decision (see §11).

## 2. Users and core jobs

The user is an Atomic Data Browser user who keeps their real calendar in
Google and wants it next to their own data: linking events to projects,
timesheets or notes, and editing a few fields without switching apps.

Ranked jobs, with the competitor pattern each one borrows:

1. **See what's coming up** — today and the next days, at a glance.
   Borrowed: Fantastical's agenda list under a compact day strip
   (DayTicker); Google Calendar's "Schedule" view.
2. **See a week's shape** — where the free time is. Borrowed: Notion
   Calendar (ex-Cron) and Google Calendar's time-grid week with an all-day
   row and a "now" line.
3. **Fix an event** — retitle, move, add a location or notes, and be sure the
   change reached Google. Borrowed: Notion Calendar's side panel (not a modal)
   for event detail. Our addition is an explicit _review before send_ step,
   because the adapter's write contract requires approval ("Nothing is sent
   until approved" in the manifest).
4. **Trust the sync** — know when it last ran, what was skipped and why, and
   resolve disagreements without losing data. Competitors don't need this
   (they are the source of truth); it is where this plugin must be clearer
   than they are.
5. **Pick which calendars come in** — Google's left-rail checkbox list with
   colour swatches.

Explicit non-jobs for now: scheduling with others (attendees, availability
sharing, conferencing links), reminders/notifications, natural-language quick
add, drag-to-reschedule. They are listed under §10 "Later".

## 3. Shared visual language (with sibling plugin designs)

Adopted from the Money design plan (also adopted by Timesheets) so the
plugins read as one family. Calendar adds nothing to the shared chrome.

- **Tokens.** Components use only `--pl-*`, each mapped to the host variables
  the iframe receives via the `__atomic_style` message
  (`browser/data-browser/src/views/PluginView/useCreateThemeVars.ts` in
  atomic-server), with a literal fallback for when the host sends nothing:

  | Token          | Host variable          | Light fallback | Dark fallback |
  | -------------- | ---------------------- | -------------- | ------------- |
  | `--pl-bg`      | `--t-color-bg-body`    | `#ffffff`      | `#15171a`     |
  | `--pl-surface` | `--t-color-bg-1`       | `#f5f6f8`      | `#1d2024`     |
  | `--pl-border`  | `--t-color-bg-2`       | `#e3e6ea`      | `#2c3036`     |
  | `--pl-text`    | `--t-color-text`       | `#1b1e22`      | `#e8eaed`     |
  | `--pl-muted`   | `--t-color-text-light` | `#626a73`      | `#9aa2ab`     |
  | `--pl-accent`  | `--t-color-main`       | `#1a6ef5`      | `#6ea3ff`     |
  | `--pl-neg`     | `--t-color-alert`      | `#c62828`      | `#ff7b72`     |
  | `--pl-warn`    | `--t-color-warning`    | `#9a6200`      | `#e3b341`     |
  | `--pl-pos`     | _(none in host)_       | `#1f7a45`      | `#56c98a`     |

  Radius `var(--t-radius, 8px)`, font `var(--t-font-family, system-ui)`.
  The host re-sends its variables when the user switches theme, so the plugin
  follows the host's light/dark setting without its own toggle; the
  `prefers-color-scheme` fallbacks only matter outside the host (unit tests,
  standalone preview). `--pl-pos` is the one token the host lacks; adding a
  `--t-color-success` upstream would be a small atomic-server PR, not a
  blocker.

- **Header row** `[icon + "Calendar" | source chips | status pill | primary action]`.
  For Calendar the source chips are the _visible calendars_, each a colour
  swatch + name, toggling visibility (not sync). Primary action is
  "Review N changes" when local edits are pending, otherwise "Sync now".
- **Connection bar** under the header: provider mark, account label,
  "Last synced 4 min ago", overflow menu (Choose calendars, Reconnect,
  Disconnect).
- **Status pill** states: `Synced 4 min ago` (muted), `Syncing…` (accent,
  with an indeterminate 2px bar along the connection bar's bottom edge),
  `3 to review` (accent), `2 conflicts` (warn), `Error` (neg),
  `Reconnect needed` (neg). Text always accompanies colour.
- **Empty** = centred icon, one sentence, one primary button.
- **Error** = inline banner at the top of the content area: cause in plain
  words, one recovery action, a "Details" disclosure with the raw provider
  status and message. Banners never replace content that is still valid.

## 4. Information architecture

```
Calendar (iframe)
├── Header row + connection bar           (always, once connected)
├── Sidebar (≥ 900px only)
│   ├── mini month (navigates the main view)
│   ├── My calendars: swatch, name, visibility checkbox, "Read-only" tag
│   └── Sync notes: "14 recurring events not shown · Why?"
├── Main view   [Agenda | Week | Month]  + ‹ Today › + date title
│   ├── Agenda: day-grouped list, sticky day headers, all-day first
│   ├── Week:   7-day time grid (3/5-day when narrow), all-day row, now line
│   └── Month:  see §11 decision 1 — own grid, or hand off to host table view
├── Event panel (right drawer ≥ 720px; full-screen sheet below)
│   └── view mode → Edit → local save (marked "Not sent yet")
├── Review sheet: pending changes → Send to Google
└── Conflicts panel: per-event, per-field choice
```

Default view: Agenda below 720px, Week at and above. The last choice is
remembered per viewer in `localStorage`, wrapped in try/catch (a convenience
only; the app renders correctly without it).

## 5. Key screens and states

Each is drawn in `mockups.html` under the same number.

### 5.1 No proxy

Host lacks `store.proxy`. Empty-state card: "This Atomic Server can't reach
calendars on your behalf yet, so nothing was fetched." No button.

### 5.2 First run — not connected

Card inside the iframe: three provider rows (Google active; Outlook and Apple
disabled with "Not available yet" — or hidden, see §11 decision 2). One line
of what happens: "Events are copied into this table. Nothing is sent to Google
until you review it." Primary "Connect Google Calendar" calls
`proxy.connect({ platform: 'google-calendar' })`; the host's consent bar takes
over and the page navigates away on Connect.

### 5.3 Connecting

Same card, button replaced by "Waiting for you to confirm in the bar above…"
and a Cancel link. Returns to 5.2 when `connect()` resolves `cancelled`.

### 5.4 Choose calendars (first connect, and from the menu)

List from Google's `calendarList`: swatch, name, access role. Checkboxes;
primary calendar pre-checked. Calendars whose `accessRole` is `reader` or
`freeBusyReader` carry a "Read-only" tag and their events never offer Edit.
Footer: "Import 2 calendars". Honest limit up front: "Recurring events aren't
imported yet."

### 5.5 First import (syncing, empty table)

Header visible, status pill `Syncing…`, content area shows an Agenda skeleton
plus a progress line per calendar: "Work — 750 events read (page 3)". Pages
are 250 events; the 25,000-event cap is mentioned only when it is hit.

### 5.6 Empty (connected, nothing in range)

"No events this week." with "Jump to next event" if one exists later, else
nothing extra.

### 5.7 Populated — Week (≥ 720px)

Sidebar (≥ 900px) + time grid, 08:00–18:00 visible, scrollable 00:00–24:00,
initial scroll to one hour before now. All-day row above the grid; multi-day
all-day events span columns using the exclusive `atomic-calendar-end-day`
(`isAllDayOnDate`). Overlapping timed events split the column width
(column packing); below 44px wide they collapse into a "+2" button. Event
block: calendar tint over `--pl-surface` with a 3px swatch edge, title
semibold, time muted; blocks under 30 minutes show title only. Events with
local unsent edits show a dashed edge and an accent dot; events in conflict
show a `--pl-warn` "!" badge.

### 5.8 Populated — Agenda (360–719px)

Week strip (7 day chips, dots for days with events) above a day-grouped list.
Each row: time column (`10:00` / `11:00` stacked, or "All day"), swatch,
title, location on a second line. Today's header is sticky and labelled
"Today". Rows are ≥ 48px tall.

### 5.9 Event detail and edit

Drawer. View mode: title, date/time line in the viewer's zone (the event's own
zone as a secondary line when it differs: "16:00–17:00 in New York"),
location, description, calendar, "Open in Google Calendar" link (the event's
`htmlLink`, which would need to be kept on import — see gap 7). Edit mode:
exactly the fields the adapter maps — title, all-day switch, start, end,
location, description. Nothing else is editable, and the drawer says so:
"Guests, reminders and video links are edited in Google Calendar."

Validation mirrors `validate()` in `adapter.ts`, rephrased: empty title →
"Add a title"; end ≤ start → "End must be after start". All-day uses date
inputs, timed uses date + time; the UTC offset is attached from the viewer's
zone and is never a field. Saving stores locally and the drawer footer reads
"Saved here · not sent to Google yet — Review changes".

### 5.10 Review changes (two-way write)

Sheet listing each pending event with per-field before/after
(`Location: Room 4 → Room 2`), from `preview()` + `planEdit()`. One primary
"Send 3 changes to Google". Per-event "Discard" returns the local value to
the baseline. On send, each event row shows sending / sent / failed. A 412
marks that row "Changed in Google since you reviewed — Review again" and does
not block the others.

### 5.11 Conflicts

From `preview().conflicts`. One card per event:

- _Both changed_ — field rows with two options, "Keep mine" / "Use Google's",
  none preselected; "Resolve" is enabled when every field has a choice.
- _Missing in Google_ (cancelled, now recurring, or inaccessible) — "This
  event is no longer in Google Calendar. Your copy here was not deleted."
  Actions: "Keep as local event" / "Remove local copy" (the only delete path,
  and it is local).
- _Missing or rebound local row_ — shown with "Open row in table"; no
  automatic fix.

### 5.12 Error and reconnect

Banners, mapped from the proxy response status:

| Status            | Banner                                                                        | Action           |
| ----------------- | ----------------------------------------------------------------------------- | ---------------- |
| 401               | "Google access has expired."                                                  | Reconnect        |
| 403               | "Google refused access to _Work_. You may have lost access to this calendar." | Choose calendars |
| 404 on a calendar | "Calendar _Team offsite_ no longer exists or isn't shared with you."          | Remove from list |
| 429               | "Google is limiting requests. Retrying in 40 s." (from `retry-after`)         | Retry now        |
| 5xx / network     | "Couldn't reach Google."                                                      | Retry            |
| > 25,000 events   | "_Work_ has more than 25,000 events, so the import stopped."                  | —                |

Every error adds "Nothing here was changed", matching the adapter's guarantee
that no checkpoint advances on a failed read.

## 6. Interactions

- Keyboard (when focus is in the iframe and not in a text field): `t` today,
  `←`/`→` or `j`/`k` previous/next period, `a`/`w`/`m` agenda/week/month,
  `Enter` opens the focused event, `e` edits it, `Esc` closes the drawer or
  sheet, `?` lists shortcuts. Letters match Notion Calendar and Google
  Calendar where they overlap (`t`, `w`, `m`).
- Clicking an event opens the drawer; at ≥ 720px the grid stays visible
  behind it.
- Sync (read) runs on open when connected and on "Sync now". It never writes.
  Writes happen only from the Review sheet.
- The status pill is a button: it opens Review when there are pending edits,
  Conflicts when there are conflicts, and the banner's Details on error.

## 7. Accessibility

- The Week grid is not an ARIA grid; each day column is a `<section>`
  labelled "Tuesday 24 September" containing a list of event buttons. Each
  event button's accessible name is complete: "Design review, 10:00 to 11:00,
  Room 4, Work calendar". A visually hidden "Switch to agenda view" link is the
  first focusable element of Week.
- Calendar colour is never the only signal: the calendar name is in the
  accessible name and in the chips.
- Tint fills are 14% (light) / 22% (dark) of the swatch over the surface so
  `--pl-text` stays at or above 4.5:1 on them with Google's default palette;
  this must be checked in the e2e contrast test, not assumed for custom
  colours.
- Drawer and sheets are `role="dialog"` with `aria-modal` below 720px, focus
  moved to the heading and returned to the invoking event on close.
- `role="status"` on the status pill text; banners use `role="alert"` only for
  401/403 (action required), otherwise `role="status"`.
- Targets ≥ 44×44px below 720px; focus ring `2px solid var(--pl-accent)` with
  2px offset; `prefers-reduced-motion` disables the drawer slide and the
  progress-bar animation.

## 8. Responsive (iframe 360–1200px)

| Width   | Layout                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| 360–559 | Agenda default; Week shows 3 days; calendar chips collapse into a "2 calendars" button; drawer is full-screen. |
| 560–719 | Agenda default; Week shows 5 days.                                                                             |
| 720–899 | Week (7 days) default, no sidebar; drawer 360px overlays the right of the grid.                                |
| ≥ 900   | Sidebar 232px + Week; drawer 380px overlays.                                                                   |

The iframe never scrolls horizontally; only the week grid body scrolls
vertically.

## 9. Light and dark

All colour comes from `--pl-*` (§3). Calendar swatches are Google's own
calendar `backgroundColor` values, used as-is for the 3px edge and mixed into
the surface for the fill (14% light, 22% dark). The mockups show Week in both
themes.

## 10. Scope

**Now (the issues in `issues.md`):** iframe app scaffold and state machine;
shared chrome; Google connect via the proxy; calendar picker; import through
the proxy with the existing paging and exclusions; Agenda and Week views;
event drawer with edit of the five mapped fields; Review-and-send; Conflicts;
error/reconnect mapping; keyboard and accessibility pass; responsive/theme
e2e screenshots.

**Later:** create event (the manifest declares `create_event`, but no create
path exists in `adapter.ts`'s preview/apply flow); recurring events shown
read-only via `calendarRecurrenceProjection`; recurring edits;
drag-to-move/resize; natural-language quick add; attendees and RSVP;
incremental sync with Google's `syncToken` instead of full scans; Outlook
Calendar (Graph overlay + proxy OAuth app); Apple Calendar.

## 11. Gaps vs today, and decisions needed

Gaps (each is covered by an issue):

1. No iframe app exists; everything above is new code under
   `integrations/calendar/app/`.
2. `adapter.ts` reads through the sandbox `Host.read` with a
   `secret:google-calendar` header; the iframe must go through
   `store.proxy.request` with a connection id instead (the Notion
   `app/transport.ts` shape).
3. `adapter.ts` handles one `calendarId`; the picker implies several. The
   design runs `preview()` once per selected calendar and merges results.
4. No `calendarList` call exists yet (needed for the picker, names, colours
   and access roles).
5. `applyEdit` sends `sendUpdates=all`, which e-mails guests on every patch.
   Attendees are not imported, so the UI cannot warn. See decision 3.
6. `proxy.connections()` returns only `connectionId` and `platform`, so the
   connection bar can't show the account e-mail without an extra call
   (e.g. the primary calendar's id, which is the e-mail address).
7. `project()` drops `htmlLink`, `timeZone` and calendar colour; "Open in
   Google Calendar" and the event's own zone need them kept.
8. **Writes are blocked on the relay.** The proxy request type
   (`HostProxyRequest`: platform, connectionId, path, method, query, body)
   carries no request headers, so the iframe cannot send `If-Match`. Reads
   and the whole read-only UI can ship now; Review-and-send needs an
   allowlisted `ifMatch` field in atomic-server's view-client and the proxy
   first. The app must refuse to send rather than PATCH unconditionally.

Decisions for the maintainer:

1. **Month view** — draw a Month grid in the plugin, or make "Month" open the
   host table's existing `CalendarView`? The design assumes the plugin draws
   Agenda and Week, and Month hands off, to avoid two month grids.
2. **Outlook and Apple on first run** — show them disabled ("Not available
   yet") or hide them until they work? The mockup shows them disabled.
3. **`sendUpdates=all`** — keep, or switch to `none` until attendees are
   imported and the Review sheet can say "Guests will be notified".
4. **Apple Calendar** — accept an app-specific password held by the proxy (a
   new credential kind), limit Apple to read-only `.ics` subscription URLs,
   or drop it from the plugin's scope.
