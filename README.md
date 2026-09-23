# atomic-plugins

This repo is now the source of truth for all atomic plugins.
https://github.com/ontola/atomic-server/tree/develop/integrations is
deprecated.

- `integrations/` — `ontola/atomic-server`'s former `integrations/` folder.
- `devonian/` — the `devonian` npm package (bidirectional lenses for data
  portability), migrated in from the standalone `localthought/devonian`
  repo with its history intact.
- `reflector/` — the sync-engine/plugin-runtime layer above syncables,
  migrated in from the standalone `localthought/reflector` repo with its
  history intact.
- `syncables/` — the `syncables` npm package (OpenAPI-driven mock server and
  sync client), migrated in from the standalone `localthought/syncables`
  repo with its history intact.
- `overlays/` — OpenAPI Overlays for real providers and the `catalog.json`
  that `integration-proxy/` composes, migrated in from the standalone
  `localthought/overlays` repo with its history intact, and published by
  GitHub Pages at https://ontola.github.io/atomic-plugins/overlays/.

See [AGENTS.md](AGENTS.md) for how to work in each.

## Plugins

Every plugin below is **experimental**: its capabilities are declared, not
verified, until they have current live evidence (see
[`integrations/README.md`](integrations/README.md#one-certification-command)).
The descriptions come from [`integrations/catalog.json`](integrations/catalog.json),
except GitHub issues, which has no catalog entry.

Screenshots are tracked in
[#49](https://github.com/ontola/atomic-plugins/issues/49). None is taken yet:
at the pinned atomic-server commit (`.atomic-server-ref`, `50cf5151`) no plugin
here can be shown working. atomic-server
[`4bab16ee`](https://github.com/ontola/atomic-server/commit/4bab16ee) removed
its hardcoded cards and setup dialogs for bundled plugins (including the Bank
statements upload), so the Integrations page lists only raw integration-proxy
platforms, and those setup dialogs stop at "Rebuild the WASM bundle and reload
Atomic" until LocalThought setup moves onto reflector
([#52](https://github.com/ontola/atomic-plugins/issues/52)).

| Plugin | What it does | Code | Screenshot |
| --- | --- | --- | --- |
| 🏦 **Bank statements** | Import bank transactions from MT940 and camt.053 statement exports. Exact amounts, dates, account references and original descriptions; up to 500 transactions per file. No bank token. | [`integrations/money/`](integrations/money/) | coming — needs a file-upload entry point in atomic-server |
| 🗓️ **Google Calendar** (Devonian) | Import single (non-recurring) Google Calendar events into calendar views, and preview edits to send back. | [`integrations/calendar/`](integrations/calendar/) (lens in [`devonian/google-calendar/`](integrations/calendar/devonian/google-calendar/)) | coming — [#52](https://github.com/ontola/atomic-plugins/issues/52), [#51](https://github.com/ontola/atomic-plugins/pull/51) |
| ✅ **Todoist** (Devonian) | Bring Todoist projects and active tasks into a local issue tracker. Read only. | [`integrations/issue-tracker/`](integrations/issue-tracker/) | coming — [#46](https://github.com/ontola/atomic-plugins/issues/46) |
| 🐙 **GitHub issues** (Devonian lens) | Maps GitHub issues and comments to and from Atomic issue-tracker resources. No catalog card; no host UI since atomic-server#1612. | [`integrations/issue-tracker/`](integrations/issue-tracker/) (lens in [`devonian/github-issues/`](integrations/issue-tracker/devonian/github-issues/)) | coming — [#9](https://github.com/ontola/atomic-plugins/issues/9) |
| ⏱️ **Clockify** | Bring completed Clockify time entries (past 7 or 30 days) into a Time Tracker. Import only. | [`integrations/timesheets/`](integrations/timesheets/) | coming — [#20](https://github.com/ontola/atomic-plugins/issues/20) |
| 🐦 **Moneybird** | Import a Moneybird administration's bookkeeping records into typed tables. Read only. | catalog entry only; no package in this repo yet | coming — no code or fixture here yet |
| 📓 **Notion** | Sync supported row fields, property names and table or board views of a Notion database. Hidden (`enabled: false`). | [`integrations/notion/`](integrations/notion/) | coming — [#68](https://github.com/ontola/atomic-plugins/issues/68), [#8](https://github.com/ontola/atomic-plugins/issues/8) |
| 🐾 **Pets** | A trivial demo: imports five static pets into a Pets table. No account or network call. | [`integrations/pets/`](integrations/pets/) | coming — [#52](https://github.com/ontola/atomic-plugins/issues/52) |

Images will go in `docs/screenshots/<plugin>.png`, taken at 1280×800 in the
light theme against the pinned atomic-server commit, with synthetic data only.
