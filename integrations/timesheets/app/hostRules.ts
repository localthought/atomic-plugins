// @wc-ignore-file
/**
 * Test-only: the server's check on writes that carry an import baseline,
 * ported from atomic-server `lib/src/import_identity.rs` (`validate_baseline`,
 * at the pinned ref) so the fake store refuses what the host would. Plus the
 * `approval` stamp `/app-write` puts into every baseline it writes
 * (`stamp_import_approval` in `server/src/plugins/store_host.rs`). If they
 * disagree, the Rust is ground truth. Not bundled.
 */
import { IMPORT_BASELINE, IMPORT_LOCAL_ID } from './reconcile.js';
import type { JSONValue } from './store.js';

type Values = Record<string, JSONValue>;

const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
const IDENTITY = [
  IMPORT_BASELINE,
  'https://atomicdata.dev/properties/importResolution',
  'https://atomicdata.dev/properties/importReferenceReview',
  IMPORT_LOCAL_ID,
  PARENT,
  IS_A,
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;

  return JSON.stringify(value) ?? 'undefined';
}

/** Rust's `Option<&Value>` equality: absent differs from any value. */
const eq = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : canonical(a) === canonical(b);

const object = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Values)
    : undefined;

let stamps = 0;

/** What `/app-write` does to a written baseline. */
export function stamp(propVals: Values): Values {
  const baseline = object(propVals[IMPORT_BASELINE]);
  if (!baseline) return propVals;

  return {
    ...propVals,
    [IMPORT_BASELINE]: { ...baseline, approval: `approval-${++stamps}` },
  };
}

export function validateBaseline(old: Values | undefined, next: Values) {
  const proposed = object(next[IMPORT_BASELINE]);
  if (!proposed) return;
  const stored = old?.[IMPORT_BASELINE];
  if (stored !== undefined && eq(stored, proposed)) return;
  const values = object(proposed.values);
  if (!values) throw new Error('Import baseline needs source values');
  if (IDENTITY.some(key => key in values))
    throw new Error(
      'Import source values cannot contain identity or baseline fields',
    );
  const previousValues = object(stored)?.values as Values | undefined;
  if (!eq(proposed.previous, previousValues ?? {}))
    throw new Error(
      'Import preview is stale; preview this source again before applying',
    );

  for (const [property, desired] of Object.entries(values)) {
    const before = old?.[property];
    const after = next[property];

    if (!old) {
      if (!eq(after, desired))
        throw new Error('Imported value did not preserve its source datatype');
    } else if (!previousValues) {
      if (!eq(before, desired) || !eq(after, before))
        throw new Error(
          'Existing import has no baseline; local values must be reviewed before adoption',
        );
    } else if (
      !eq(after, before) &&
      (!eq(before, previousValues[property]) || !eq(after, desired))
    )
      throw new Error(
        'Import conflicts with a local edit; preview again and resolve the conflict',
      );
  }
}
