// @wc-ignore-file
/**
 * Build-time stand-in for `@tomic/lib` in the drive-plugin bundle only, as in
 * timesheets/app. The Notion lens imports one runtime value, `Datatype`, for
 * these three members. Bundling the whole library into a module stored as a
 * string on a resource is not worth three URLs. Typecheck and tests use the
 * real library; build.test.ts pins these values to it.
 */
export const Datatype = {
  STRING: 'https://atomicdata.dev/datatypes/string',
  FLOAT: 'https://atomicdata.dev/datatypes/float',
  BOOLEAN: 'https://atomicdata.dev/datatypes/boolean',
} as const;
