# Google Calendar platform modules

`lens/` contains passive display/recurrence projections and reverse field mapping.

This folder lives in the calendar plugin folder (it was
`devonian/platform-lenses/google-calendar/` in the `devonian` package up to
0.6.1, exported as `devonian/platform-lenses/google-calendar{,/sync,/recurrence,/lens}`).
It does not import Devonian. It imports `@tomic/lib` from the host; in this
repo `../../vitest.config.ts` and `../../tsconfig.json` point that at the
linked atomic-server checkout's `browser/lib/src`. Its tests (`import.test.ts`,
`lens/lens.test.ts`) run in the calendar lane:

```sh
node integrations/tooling/run-lane.mjs calendar
```

- `calendarProjection` adds Atomic calendar display properties.
- `calendarRecurrenceProjection` preserves a recurrence payload for Atomic views.
- `planCalendarValues` computes supported Google field changes from supplied
  local, baseline, and remote values without fetching or writing anything.

The projection helpers use the consuming application's compatible `@tomic/lib`
calendar helpers. They preserve provider fields; recurrence display is not a
reverse synchronization of Google recurrence rules.

`sync.ts` retains membership/identity checks, remote reads, ETags, and checkpoint
handling. `import.ts` retains query configuration. The old projection, recurrence,
and types modules re-export the moved modules so existing imports keep working.
