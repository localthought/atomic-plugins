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
- `integration-proxy/` — the Rust OAuth/API proxy (LocalThought) that drive
  apps reach through atomic-server's host relay. See its own
  [README](integration-proxy/README.md) and [AGENTS.md](integration-proxy/AGENTS.md).

See [AGENTS.md](AGENTS.md) for how to work in each.

## Plugins

Every plugin below is **experimental**: its capabilities are declared, not
verified, until they have current live evidence (see
[`integrations/README.md`](integrations/README.md#one-certification-command)).
[`integrations/READINESS.md`](integrations/READINESS.md) is the per-plugin
matrix: which runtime the current code uses, how it is installed on the
pinned atomic-server (`.atomic-server-ref`, `bae5cdbe3`), its scope, and
which evidence is unit, host E2E, live or historical.

In short, at that pin: the Pets and Notion drive apps import through the
host's integration-proxy relay and pass a host E2E against a mock proxy, but
no host UI installs them from the catalog yet
([#94](https://github.com/ontola/atomic-plugins/issues/94)). The other
plugins have no reachable entry point at the pin; each has a linked issue.
The one-line descriptions below come from
[`integrations/catalog.json`](integrations/catalog.json), except GitHub
issues, which has no catalog entry.

Screenshots are tracked in
[#49](https://github.com/ontola/atomic-plugins/issues/49). None is taken yet.

| Plugin | What it does (catalog copy) | Current runtime | Code | Blocker |
| --- | --- | --- | --- | --- |
| 🐾 **Pets** | A trivial demo: imports five static pets into a Pets table. No account or network call. | Drive app over the host relay (read from a mock `pets` platform); the static no-network demo is a separate sandbox bundle | [`integrations/pets/`](integrations/pets/) | [#94](https://github.com/ontola/atomic-plugins/issues/94) |
| 📓 **Notion** | Sync supported row fields, property names and table or board views of a Notion database. Hidden (`enabled: false`). | Read-only drive app over the host relay; the two-way sandbox pilot has no host UI | [`integrations/notion/`](integrations/notion/) | [#94](https://github.com/ontola/atomic-plugins/issues/94), [#97](https://github.com/ontola/atomic-plugins/issues/97), [#8](https://github.com/ontola/atomic-plugins/issues/8) |
| ⏱️ **Clockify** | Bring completed Clockify time entries (past 7 or 30 days) into a Time Tracker. Import only. | Drive app, no connect/setup step yet | [`integrations/timesheets/`](integrations/timesheets/) | [#96](https://github.com/ontola/atomic-plugins/issues/96) |
| 🏦 **Bank statements** | Import bank transactions from MT940 and camt.053 statement exports; up to 500 transactions per file. No bank token. | Sandbox bundle; no upload entry point at the pin | [`integrations/money/`](integrations/money/) | [#95](https://github.com/ontola/atomic-plugins/issues/95) |
| 🗓️ **Google Calendar** (Devonian) | Import single (non-recurring) Google Calendar events into calendar views, and preview edits to send back. | Mapping and lens libraries, no host | [`integrations/calendar/`](integrations/calendar/) | [#101](https://github.com/ontola/atomic-plugins/issues/101) |
| ✅ **Todoist** (Devonian) | Bring Todoist projects and active tasks into a local issue tracker. Read only. | Projection library, no host | [`integrations/issue-tracker/`](integrations/issue-tracker/) | [#99](https://github.com/ontola/atomic-plugins/issues/99) |
| 🐙 **GitHub issues** (Devonian lens) | Maps GitHub issues and comments to and from Atomic issue-tracker resources. No catalog card. | Lens and bridge libraries, no host since atomic-server#1612 | [`integrations/issue-tracker/devonian/github-issues/`](integrations/issue-tracker/devonian/github-issues/) | [#100](https://github.com/ontola/atomic-plugins/issues/100) |
| 🐦 **Moneybird** | Import a Moneybird administration's bookkeeping records into typed tables. Read only. | Catalog entry and overlay only; no package here | — | [#102](https://github.com/ontola/atomic-plugins/issues/102) |

Images will go in `docs/screenshots/<plugin>.png`, taken at 1280×800 in the
light theme against the pinned atomic-server commit, with synthetic data only.
