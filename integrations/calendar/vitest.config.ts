export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // The Google Calendar lens in devonian/google-calendar/ is written
      // against devonian's @tomic/lib peer dependency, which is only installed
      // inside devonian's own workspace. Reached from here it resolves to the
      // symlinked atomic-server checkout, the same source every other package
      // under integrations/ imports by relative path. Mirrored by `paths` in
      // tsconfig.json.
      '@tomic/lib': new URL('../../browser/lib/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: { include: ['*.test.ts', 'devonian/**/*.test.ts'] },
};
