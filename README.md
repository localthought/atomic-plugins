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
