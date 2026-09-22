// @wc-ignore-file
/**
 * Playwright config for the per-plugin e2e specs that live under
 * `integrations/<lane>/e2e/` (see `integrations/PARALLEL_LANES.md`).
 *
 * atomic-server's own `browser/e2e/playwright.config.ts` declares no
 * `testDir`, so it defaults to `browser/e2e` and will never discover a spec
 * outside that tree — positional args are filters, not paths. This config
 * reuses every one of its settings (timeouts, storageState, projects,
 * retries, workers) and only repoints `testDir` at `integrations/`.
 *
 * `tsconfig` is what makes the moved specs' bare `@playwright/test` and
 * `@tomic/lib` imports resolve: those packages are deps of the `@tomic/e2e`
 * workspace package, so they sit in `browser/e2e/node_modules/` and are not
 * reachable by node's upward lookup from `integrations/<lane>/e2e/`.
 * Keeping the imports bare (rather than rewriting them to deep relative
 * paths) keeps the specs a near-verbatim copy of their upstream originals,
 * so re-syncing after an upstream change stays a readable diff.
 */
import base from '../../browser/e2e/playwright.config';

export default {
  ...base,
  testDir: new URL('..', import.meta.url).pathname,
  testMatch: '*/e2e/*.spec.ts',
  tsconfig: new URL('../tsconfig.e2e.json', import.meta.url).pathname,
};
