// @wc-ignore-file
/**
 * Build-time stand-in for `@tomic/lib` in the drive-plugin bundle only, as in
 * timesheets/app. The Notion lens and devonian's Atomic Data API
 * (`src/atomic/`) import two runtime values from it: `Datatype` and
 * `validateDatatype`. Bundling the whole library (its `validateDatatype`
 * pulls in `Client`) into a module stored as a string on a resource is not
 * worth that. Typecheck and tests use the real library; build.test.ts pins
 * these values and this validation to it.
 *
 * `Datatype` lists only the members devonian's `AtomicSchema` and the lens
 * use. `validateDatatype` covers the datatypes the lens's columns can have
 * (string, float, boolean, timestamp, JSON) plus integer and markdown, with
 * the real library's checks for them; any other datatype throws, as the real
 * one does for an unknown datatype. Links (atomicURL, resourceArray) never
 * reach it: `AtomicSchema` validates those itself.
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
