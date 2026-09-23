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

## Done — Clockify: nothing left to move

`browser/e2e/tests/plugins.spec.ts` used to hold two Clockify tests besides
its six generic editor/sandbox tests, and upstream also had a separate
`browser/e2e/tests/clockify-import.spec.ts`. atomic-server `4bab16ee6`
(feat/plugin-debug) deleted both, together with the Clockify LocalThought
UI they drove, including the `[data-integration=clockify]` card.
`.atomic-server-ref` (`50cf5151c`) includes that commit. So there is nothing
left to move (#44), and `plugins.spec.ts` now holds only generic tests. The
`e2e-plugin-system` job runs them.

The `timesheets` lane stays at `typecheck` and `unit`. A new timesheets e2e
tier needs a new entry point. The most likely one is #20's timesheets drive
app, once atomic-server#1624 (a capability for the app frame) and an install
flow exist.

`integrations/tooling/lanes.test.mjs` checks that every declared e2e spec
exists. Nothing checks that a lane spec is not also still running upstream.
