# Google Calendar ↔ Atomic calendar

A two-way sync for one Google Calendar and one ordinary Atomic calendar table.
Provider code (`adapter.ts`) stays here, independent of `devonian`: the
`devonian/platform-lenses/google-calendar/` package is a separate, generic
Devonian lens (used by the LocalThought/Devonian browser-connector flow
described in [`../README.md`](../README.md#building-a-localthought-reflectorsyncablesdevonian-connector));
this package is the atomic-server sandbox-plugin equivalent, modeled on
[`../issue-tracker/adapter.ts`](../issue-tracker/adapter.ts).

## Mapping

| Google Calendar | Atomic |
|---|---|
| `summary` | Card title |
| `description` (missing becomes empty text) | Description |
| `location` (missing becomes empty text) | Location |
| All-day `start.date` / `end.date` | Start / End (plain `YYYY-MM-DD`) |
| Timed `start.dateTime` / `end.dateTime` | Start / End (offset-qualified) |

Editing title, description, location, start or end locally patches only that
field back to Google, conditioned on the event's ETag; a change to the event
in Google since the last preview fails the write instead of overwriting it.
Recurring events (a series master or any of its instances) and cancelled
events are skipped on import, never partially mapped. Attendees, reminders,
conferencing data and event deletion are outside this first scope. A missing
or inaccessible event is a conflict, not permission to delete the local card.

## Verification

```sh
./browser/node_modules/.bin/vitest run --config integrations/calendar/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/calendar/tsconfig.json
```

These check `adapter.ts`'s pagination, recurring/cancelled exclusion, all-day
and timed interval validation, and edit-patch minimality.

API reference: https://developers.google.com/calendar/api/v3/reference/events
