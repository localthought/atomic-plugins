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

// `testDir` and `tsconfig` are resolved by Playwright relative to this file,
// so they are plain relative paths. They were built with
// `new URL(..., import.meta.url)` at first, which threw `Cannot use
// 'import.meta' outside a module`: Playwright loads a config through
// `requireOrImport`, and with no `"type": "module"` in any package.json above
// this directory — this repo has no root package.json at all — that lands in
// the CJS branch.
export default {
  ...base,
  testDir: '..',
  testMatch: '*/e2e/*.spec.ts',
  tsconfig: '../tsconfig.e2e.json',
};
