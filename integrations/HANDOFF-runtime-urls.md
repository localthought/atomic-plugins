# Handoff: make the plugin-catalog and integration-proxy URLs runtime-configurable

**For:** `ontola/atomic-server`, branch `feat/plugin-debug`.
**Why this repo cares:** `integrations/PARALLEL_LANES.md` gives every plugin
its own CI lane and its own port block. Three of the four test tiers are
already port-parameterized. The **e2e tier is not**, because the two URLs
below are baked into the SPA bundle at build time — so a binary built for one
lane's ports cannot serve another's, and parallel local e2e needs either a
per-lane rebuild or a lockfile. Fixing this is what removes that asymmetry.

Everything below was read at the pinned commit `02cac45c`
(`.atomic-server-ref`). Re-check against `feat/plugin-debug` HEAD before
starting; these files were changing.

## What already exists (do not rebuild it)

Both URLs are **already runtime-overridable through `localStorage`**. The
build-time `VITE_*` vars only supply the _default_:

|                    | catalog URL                                                            | proxy URL                                                                            |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| helper             | `browser/data-browser/src/helpers/pluginCatalogUrl.ts`                 | `browser/data-browser/src/helpers/integrationProxy.ts`                               |
| build-time default | `VITE_PLUGIN_CATALOG_URL` → `defaultPluginCatalogUrl`                  | `VITE_INTEGRATION_PROXY_URL` → `defaultIntegrationProxy`                             |
| fallback           | `https://ontola.github.io/atomic-plugins/integrations/catalog.json`    | `DEFAULT_PROXY` = `https://localthought.io` (`integrations/localthought/browser.ts`) |
| localStorage key   | `plugin-catalog-url`                                                   | `integration-proxy-url` (`proxySettingKey`, `integrations/localthought/settings.ts`) |
| setter             | `setPluginCatalogUrl()`                                                | `setIntegrationProxy()` → `saveProxy()`                                              |
| reader             | `getPluginCatalogUrl()` / `usePluginCatalogUrl()`                      | `getIntegrationProxy()` / `useIntegrationProxy()`                                    |
| validator          | `validateCatalogUrl()` — https, or http on `localhost`/`127.0.0.1`     | `proxyOrigin()` — same rule, plus **origin-only** (`u.origin !== value` throws)      |
| settings UI        | `browser/data-browser/src/components/Settings/IntegrationSettings.tsx` | same                                                                                 |

So the feature is not missing. What is missing is a way to **set those keys
before the first fetch**, without a human in the settings screen and without
rebuilding.

## The actual problem

`ci.yml` in `ontola/atomic-plugins` bakes the values instead, and then has to
assert the bake worked:

```yaml
env:
  VITE_PLUGIN_CATALOG_URL: http://localhost:9880/integrations/catalog.json
  VITE_INTEGRATION_PROXY_URL: http://127.0.0.1:19090
run: cargo build --profile e2e -p atomic-server --no-default-features --features wasm-plugins
```

followed by a step that greps `browser/data-browser/dist` for both strings and
fails the build if either is absent. `build.rs` runs the Vite build
unconditionally, so changing either value is a full frontend rebuild plus a
relink.

The downstream symptom is in `plugins.spec.ts` — the Pets test has to
intercept the baked literal to reach a proxy at a different address:

```ts
if (process.env.ATOMIC_SERVICE_URL)
  await page.route('http://127.0.0.1:19090/**', async route => { ... });
```

That `page.route` rewrite is the workaround this task deletes. (That test now
lives at `integrations/pets/e2e/pets.spec.ts` in `ontola/atomic-plugins`.)

## What to build

**A pre-load seeding path for both keys.** Concretely, one of:

1. **Preferred — Playwright `storageState`.** `browser/e2e/playwright.config.ts`
   already seeds `viewTransitionsDisabled` per origin, derived from
   `FRONTEND_URL`/`SERVER_URL`. Add `plugin-catalog-url` and
   `integration-proxy-url` to that same `origins[].localStorage` list, read
   from env. No production code changes at all; `VITE_*` stops being on the
   e2e critical path. **Check first** whether either helper reads its key
   before the page's `storageState` is applied — `storageState` is applied at
   context creation, so it should be visible to the first script, but the
   catalog fetch's exact timing relative to hydration needs confirming.
2. **Fallback — a `window.__ATOMIC_RUNTIME_CONFIG__` shim** read by both
   helpers ahead of `localStorage`, injected via `page.addInitScript`. Use
   this only if (1) turns out to race.

Do **not** add a query-parameter override. Both values are fetch targets for
authenticated flows; a URL parameter makes them settable by any link.

### Constraints the implementation must respect

- **Keep both validators.** `validateCatalogUrl` and `proxyOrigin` are the
  reason a hostile catalog URL can't be planted. A seeded value must go
  through the same check, not around it.
- **`proxyOrigin` rejects anything but a bare origin** (`u.origin !== value`),
  so the proxy value is `http://127.0.0.1:19042`, never with a path. The
  catalog value _is_ a full path (`.../integrations/catalog.json`). They are
  not symmetric; don't unify them.
- **The `localhost`/`127.0.0.1` allowlist blocks the dagger origins.** Both
  validators permit plain http only on those two hostnames. atomic-server's
  own dagger pipeline uses `http://atomic:9883` and `http://atomic.localhost:9883`.
  `*.localhost` will fail `['localhost','127.0.0.1'].includes(u.hostname)`.
  Decide deliberately whether to widen to `.localhost` suffixes or leave
  dagger on the baked path — and say which in the PR.

### Done when

- [ ] An unmodified `--profile e2e` binary, built with **no** `VITE_PLUGIN_CATALOG_URL`
      or `VITE_INTEGRATION_PROXY_URL`, runs the Integrations-page e2e suite
      green against a catalog and proxy on arbitrary ports.
- [ ] The `page.route('http://127.0.0.1:19090/**', …)` rewrite is deleted from
      the Pets test, and `ATOMIC_SERVICE_URL` is no longer needed by it.
- [ ] A unit test covers: seeded value wins over `VITE_*` default; an invalid
      seeded value falls back to the default rather than throwing; the
      settings-UI setter still round-trips.
- [ ] `IntegrationSettings.tsx` still shows the effective value, seeded or not.

### What lands back here afterwards

In `ontola/atomic-plugins`, once this ships and `.atomic-server-ref` is bumped:

- Drop the two `VITE_*` vars and the whole **"Verify the built frontend uses
  this repo's catalog and proxy URLs"** step from `ci.yml`.
- Delete §3's _"The build-time constraint on ports"_ caveat in
  `integrations/PARALLEL_LANES.md`; the e2e tier becomes port-parameterized
  like the other three, and the local `flock` guard goes away.

## Unrelated but needed on the same branch

`plugins.spec.ts` has been split in `ontola/atomic-plugins`: the Pets test
moved to `integrations/pets/e2e/pets.spec.ts` and the Notion test to
`integrations/notion/e2e/notion.spec.ts`. The six remaining tests are generic
plugin editor/sandbox coverage and belong upstream. **Delete those two tests
from `browser/e2e/tests/plugins.spec.ts`** in the same commit that the pin is
bumped to, or they run twice. `newPlugin()` and `setSource()` stay — the six
remaining tests use them; neither moved test did.
