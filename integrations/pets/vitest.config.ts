export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // `syncables/browser` resolves from this folder's node_modules: the npm
      // release pinned in package.json (`pnpm install` here).
    },
  },
  test: { include: ['*.test.ts', 'app/*.test.ts'] },
};
