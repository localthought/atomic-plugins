export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // Same as integrations/timesheets/vitest.config.ts: devonian/ is a
      // sibling package, not an installed dependency, and its @tomic/lib peer
      // resolves to the atomic-server checkout's source.
      'devonian/platform-lenses/notion': new URL(
        '../../devonian/platform-lenses/notion/index.ts',
        import.meta.url,
      ).pathname,
      '@tomic/lib': new URL('../../browser/lib/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: { include: ['*.test.ts'] },
};
