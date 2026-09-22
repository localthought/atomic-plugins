# Handoff: finish moving the integration e2e specs out of atomic-server

**For:** `ontola/atomic-server`, branch `feat/plugin-debug`.

## Done — runtime-configurable catalog and proxy URLs

`atomic-server#1621` landed on `feat/plugin-debug` and
`.atomic-server-ref` now pins it (`057e2b67`). It did what this file
originally asked for, and a little more:

- `browser/e2e/playwright.config.ts` seeds the `plugin-catalog-url` and
  `integration-proxy-url` localStorage keys through `storageState`, from
  `PLUGIN_CATALOG_URL` / `INTEGRATION_PROXY_URL` (the `VITE_*` spellings are
  accepted under those names too). No production shim was needed — a probe
  confirmed `storageState` is readable by the first script on the page — and
  no query-parameter override was added, which was the right call: both values
  are fetch targets for authenticated flows.
- Both validators stay on the path a seeded value takes, and a bad seed fails
  loudly instead of falling back and letting the suite report the product
  broken.
- `validateCatalogUrl` now shares `isLoopbackHost` with `proxyOrigin`, so the
  whole `.localhost` TLD is accepted (RFC 6761). Dagger's other origin,
  `http://atomic:9883`, is still not loopback and stays rejected.
- Two robustness fixes the seeding exposed: `getIntegrationProxy()` no longer
  throws out of a render on a stored value that stopped validating, and a
  `VITE_*` default that would never validate no longer poisons every read
  including the Settings screen that could have fixed it.

What that bought this repo, in the same commit that bumped the pin:

- every lane's e2e tier uses its own derived port block, so nothing is
  serialized behind a lockfile any more;
- `lanes.json` lost its `canonicalPorts` block;
- `ci.yml`'s `build-server` job no longer passes the two `VITE_*` URLs, and the
  step that grepped `data-browser/dist` to prove the bake had worked is gone.

`atomic-server#1621` also deleted the Pets and Notion tests from
`browser/e2e/tests/plugins.spec.ts`; they are lanes here now
(`integrations/pets/e2e/pets.spec.ts`, `integrations/notion/e2e/notion.spec.ts`).

## Remaining: the two Clockify tests

`browser/e2e/tests/plugins.spec.ts` still holds eight tests. Six drive the
generic plugin editor and sandbox and belong upstream. Two do not:

- `Clockify discovers named workspaces and surfaces preview transport errors`
- `Clockify applies linked entries through the real sandbox and skips repeats`

Both are Clockify-specific, so they belong to this repo's `timesheets` lane.
Until they move, `ci.yml`'s `e2e-plugin-system` job runs the whole file, which
means Clockify e2e coverage runs on **every** PR that touches anything under
`integrations/`, rather than only when `integrations/timesheets/**` changed.
That is the gating this whole lane scheme exists to provide, and timesheets is
the one plugin not getting it.

### To finish

1. Delete those two `test(...)` blocks from
   `browser/e2e/tests/plugins.spec.ts`. Keep `newPlugin()` and `setSource()` —
   the six remaining tests use them, and neither Clockify test does.
2. In `ontola/atomic-plugins`, add the pair as
   `integrations/timesheets/e2e/timesheets.spec.ts` (the same shape as the
   pets and notion specs: `../../../browser/e2e/tests/...` for the utils,
   bare `@playwright/test` and `@tomic/lib`, which
   `integrations/tsconfig.e2e.json` maps), and give the `timesheets` lane in
   `integrations/lanes.json` an `e2e` tier naming it.
3. Bump `.atomic-server-ref`. Do the deletion and the bump in one change, or
   the two tests run twice — once upstream, once in the lane.

`integrations/tooling/lanes.test.mjs` checks that every declared e2e spec
exists, so step 2's wiring is covered; nothing checks for the _duplicate_, so
step 3's ordering is on whoever does it.
