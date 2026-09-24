// @wc-ignore-file
/**
 * Build-time stand-in for `@tomic/lib` in the drive-plugin bundle only, as in
 * notion/app and timesheets/app (a copy of notion's `Datatype` and
 * `validateDatatype`, plus the URL constants the GitHub lens reads).
 *
 * - devonian's Atomic Data API (`devonian/atomic`) imports `Datatype` and
 *   `validateDatatype`; the Bridge's internal store only uses string,
 *   markdown and resourceArray properties.
 * - `ports.mjs` and `target.mjs` import `core` and `dataBrowser` for property
 *   and class URLs only.
 *
 * Bundling the whole library into a module stored as a string on a resource
 * is not worth it. Typecheck and tests use the real library; build.test.ts
 * pins every value here to it.
 */
export const Datatype = {
  ATOMIC_URL: 'https://atomicdata.dev/datatypes/atomicURL',
  BOOLEAN: 'https://atomicdata.dev/datatypes/boolean',
  FLOAT: 'https://atomicdata.dev/datatypes/float',
  INTEGER: 'https://atomicdata.dev/datatypes/integer',
  JSON: 'https://atomicdata.dev/datatypes/json',
  MARKDOWN: 'https://atomicdata.dev/datatypes/markdown',
  RESOURCEARRAY: 'https://atomicdata.dev/datatypes/resourceArray',
  STRING: 'https://atomicdata.dev/datatypes/string',
  TIMESTAMP: 'https://atomicdata.dev/datatypes/timestamp',
  UNKNOWN: 'unknown-datatype',
} as const;

export const core = {
  classes: {
    property: 'https://atomicdata.dev/classes/Property',
  },
  properties: {
    datatype: 'https://atomicdata.dev/properties/datatype',
    description: 'https://atomicdata.dev/properties/description',
    isA: 'https://atomicdata.dev/properties/isA',
    localId: 'https://atomicdata.dev/properties/localId',
    name: 'https://atomicdata.dev/properties/name',
    parent: 'https://atomicdata.dev/properties/parent',
    shortname: 'https://atomicdata.dev/properties/shortname',
  },
} as const;

export const dataBrowser = {
  classes: {
    folder: 'https://atomicdata.dev/classes/Folder',
    message: 'https://atomicdata.dev/classes/Message',
  },
  properties: {
    about: 'https://atomicdata.dev/properties/about',
    commentsFolder: 'https://atomicdata.dev/properties/commentsFolder',
  },
} as const;

export function validateDatatype(value: unknown, datatype: string): void {
  if (value === undefined)
    throw new Error(`Value is undefined, expected ${datatype}`);
  let err: string | null = null;

  switch (datatype) {
    case Datatype.STRING:
    case Datatype.MARKDOWN:
      if (typeof value !== 'string') err = 'Not a string';
      break;
    case Datatype.INTEGER:
      if (typeof value !== 'number') err = 'Not a number';
      else if (value % 1 !== 0) err = 'Not an integer';
      break;
    case Datatype.FLOAT:
    case Datatype.TIMESTAMP:
      if (typeof value !== 'number') err = 'Not a number';
      break;
    case Datatype.BOOLEAN:
      if (typeof value !== 'boolean') err = 'Not a boolean';
      break;
    case Datatype.JSON:
      try {
        JSON.stringify(value);
      } catch {
        err = 'Not valid JSON';
      }

      break;
    default:
      throw new Error(`Unsupported datatype: ${datatype}`);
  }

  if (err !== null) throw new Error(err);
}
