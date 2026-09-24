export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // Same as integrations/timesheets/vitest.config.ts: the lens in
      // devonian/notion/, and the npm `devonian` it imports, use @tomic/lib
      // (devonian's optional peer, not installed here), which resolves to the
      // atomic-server checkout's source. `syncables` and `devonian` resolve
      // from this folder's node_modules (npm; `pnpm install` here).
      '@tomic/lib': new URL('../../browser/lib/src/index.ts', import.meta.url)
        .pathname,
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
