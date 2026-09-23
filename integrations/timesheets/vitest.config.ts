export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // devonian/ is a sibling package in this repo, not an installed
      // dependency: nothing links it into a node_modules reachable from here,
      // so its bare specifier does not resolve. Same shape as the `vitest`
      // alias above, and mirrored by `paths` in tsconfig.json.
      'devonian/platform-lenses/clockify': new URL(
        '../../devonian/platform-lenses/clockify/index.ts',
        import.meta.url,
      ).pathname,
      // devonian declares @tomic/lib as a peer dependency, which is only
      // installed inside its own workspace. Reached from here it resolves to
      // the symlinked atomic-server checkout, the same source every other
      // package under integrations/ imports by relative path.
      '@tomic/lib': new URL('../../browser/lib/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: { include: ['*.test.ts', 'app/*.test.ts'] },
};
