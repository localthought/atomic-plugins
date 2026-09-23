const at = (relative: string) => new URL(relative, import.meta.url).pathname;

export default {
  root: at('.'),
  resolve: {
    alias: {
      vitest: at('../../browser/node_modules/vitest/dist/index.js'),
      // The Devonian GitHub issues lens in devonian/github-issues/ imports the
      // `devonian` package. devonian/ is a sibling package in this repo, not an
      // installed dependency, so its bare specifier is aliased to its source,
      // the same way timesheets aliased its lens. devonian's own dependencies
      // must be installed (`pnpm install` in devonian/; ci.yml's lane job
      // does it).
      devonian: at('../../devonian/src/main.ts'),
      // devonian's @tomic/lib peer, and the host modules the lens was written
      // against (its consumer used to supply them), resolve to the symlinked
      // atomic-server checkout, like every other import under integrations/.
      '@tomic/lib': at('../../browser/lib/src/index.ts'),
      '@integration-host/import-records': at(
        '../../browser/lib/src/import-records.ts',
      ),
      '@integration-host/loro-loader': at(
        '../../browser/lib/src/loro-loader.ts',
      ),
      '@integration-host/plugin-connection': at(
        '../../browser/lib/src/plugin-connection.ts',
      ),
      '@integration-host/plugin-reconcile': at(
        '../../browser/lib/src/plugin-reconcile.ts',
      ),
      '@integration-host/plugin-manifest': at(
        '../../browser/lib/src/plugin-manifest.ts',
      ),
      '@integration-host/integration-automation': at(
        '../../browser/data-browser/src/chunks/PluginRuns/integrationAutomation.ts',
      ),
    },
  },
  test: {
    include: ['*.test.ts', 'devonian/**/*.test.{ts,mjs}'],
  },
};
