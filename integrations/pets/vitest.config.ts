export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // The app bundles this repo's syncables/src, not an npm copy; mirrored
      // by `paths` in tsconfig.json and the alias in app/build.mjs.
      'syncables/browser': new URL(
        '../../syncables/src/browser.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: { include: ['*.test.ts', 'app/*.test.ts'] },
};
