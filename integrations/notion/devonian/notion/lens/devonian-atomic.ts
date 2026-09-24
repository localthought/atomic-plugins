// @wc-ignore-file
/**
 * The browser-safe part of the npm `devonian` package (0.6.1, pinned in
 * ../../../package.json): its native Atomic Data API, `src/atomic/`.
 *
 * Not `import ... from 'devonian'`: the package root also exports
 * `DevonianClient` and `DevonianTable`, which import `node:events` and
 * Automerge, so the drive-plugin bundle cannot include it, and its other
 * sources do not typecheck under this folder's tsconfig. devonian 0.6.1's
 * `exports` has no subpath for `src/atomic/`, so these reach the files by
 * path inside node_modules. They are the same four files as this repo's
 * `devonian/src/atomic/` at the time of writing.
 */
export * from '../../../node_modules/devonian/src/atomic/Resource.js';
export * from '../../../node_modules/devonian/src/atomic/Store.js';
export * from '../../../node_modules/devonian/src/atomic/IdentityMap.js';
export * from '../../../node_modules/devonian/src/atomic/Lens.js';
