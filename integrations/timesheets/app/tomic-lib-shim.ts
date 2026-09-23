// @wc-ignore-file
/**
 * Build-time stand-in for `@tomic/lib` in the drive-plugin bundle only.
 *
 * The Clockify lens imports one runtime value from `@tomic/lib`:
 * `Datatype.TIMESTAMP`. Bundling the whole library into a module stored as a
 * string on a resource would make it most of the module's size, so
 * `build.mjs` aliases `@tomic/lib` here. Typecheck and tests still use the
 * real library; `build.test.ts` pins these values to it.
 */
export const Datatype = {
  TIMESTAMP: 'https://atomicdata.dev/datatypes/timestamp',
} as const;
