export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // Same as integrations/timesheets/vitest.config.ts: the lens in
      // devonian/notion/ imports devonian's @tomic/lib peer, which resolves to
      // the atomic-server checkout's source.
      '@tomic/lib': new URL('../../browser/lib/src/index.ts', import.meta.url)
        .pathname,
      // This repo's syncables source until `syncables/browser` is on npm.
      // Mirrored in tsconfig.json and app/build.mjs.
      'syncables/browser': new URL(
        '../../syncables/src/browser.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: [
      '*.test.ts',
      'app/*.test.ts',
      'host/*.test.ts',
      'devonian/**/*.test.ts',
    ],
  },
};
