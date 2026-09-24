// @wc-ignore-file
/**
 * What happens to a row's imported fields when the source changes and the
 * row may have been edited in Atomic (#97). The policy: **local edits are
 * kept; the source only overwrites a field nobody changed locally since the
 * last import; a field changed on both sides is a conflict, reported and
 * left as it is in Atomic.**
 *
 * "Since the last import" needs a baseline: per row, the value each field
 * had when it was last imported. It is stored in the host's own import
 * metadata, `importBaseline` (`{ values, previous }`) with `localId` as the
 * source identity, the same format the sandbox importers write through
 * `importRecords` (atomic-server `browser/lib/src/import-records.ts`). The
 * server checks every write that carries one (`validate_baseline` in
 * `lib/src/import_identity.rs`): a write may only change a field whose
 * stored value still equals the baseline, and `previous` must equal the
 * stored baseline's `values`. So a stale plan fails instead of overwriting
 * an edit made in between.
 *
 * Per field, with `source` the value now, `row` the value in Atomic and
 * `base` the value at the last import:
 *
 * | source vs base | row vs base | result                                   |
 * |----------------|-------------|------------------------------------------|
 * | same           | any         | keep the row value                       |
 * | changed        | same        | take the source value                    |
 * | changed        | changed     | keep the row value; conflict unless the  |
 * |                |             | row already equals the source            |
 * | cleared        | same        | remove the field                         |
 * | cleared        | absent      | nothing left to do; baseline forgets it  |
 * | cleared        | changed     | keep the row value; conflict             |
 *
 * A row without a baseline (imported before this policy) cannot tell an
 * edit from a source change: a field that equals the source is adopted, any
 * other is a conflict until someone makes them equal. Fields the import does
 * not manage (columns added in Atomic) are never read or written.
 *
 * Kept per plugin (strict folder containment): this is a copy of
 * `integrations/timesheets/app/reconcile.ts`; keep the two identical below
 * this comment. Moving it to one shared place is a maintainer decision.
 */
import type { JSONValue } from './store.js';

export const IMPORT_LOCAL_ID = 'https://atomicdata.dev/properties/localId';
export const IMPORT_BASELINE =
  'https://atomicdata.dev/properties/importBaseline';

type Values = Record<string, JSONValue>;

export interface Conflict {
  property: string;
  /** The source's value now; `undefined` when it was cleared there. */
  source: JSONValue;
  /** The value in Atomic, kept. */
  row: JSONValue;
  /** The value at the last import; `undefined` without a baseline. */
  base: JSONValue;
}

export type Plan =
  | { op: 'create'; set: Values }
  | {
      op: 'update';
      /** Everything to write in one save, a fresh baseline included. */
      set: Values;
      /** Written first, as its own removal (the host's save only sets). */
      remove: string[];
      /**
       * Whether a value a person sees changes. False for bookkeeping only:
       * adopting a row into the baseline, or a baseline catching up.
       */
      changesValues: boolean;
      conflicts: Conflict[];
    }
  | { op: 'unchanged'; conflicts: Conflict[] };

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

const absent = (value: unknown) => value === undefined || value === null;

/** Equal as JSON; `null` and a missing value are the same (no value). */
export const same = (a: unknown, b: unknown) =>
  absent(a) ? absent(b) : !absent(b) && canonical(a) === canonical(b);

function storedBaseline(row: Values): Values | undefined {
  const baseline = row[IMPORT_BASELINE];
  if (baseline === undefined || baseline === null) return undefined;
  const values =
    baseline && typeof baseline === 'object' && !Array.isArray(baseline)
      ? baseline.values
      : undefined;
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('This row has an import baseline this app cannot read');

  return values as Values;
}

/**
 * Plans one row. `source` holds the fields the source has a value for now;
 * a managed field missing from it was cleared there. `row` is the stored
 * row, or `undefined` for a new one.
 */
export function planRow({
  sourceId,
  source,
  managed,
  row,
}: {
  sourceId: string;
  source: Values;
  managed: readonly string[];
  row: Values | undefined;
}): Plan {
  const incoming: Values = {};

  for (const property of managed)
    if (!absent(source[property])) incoming[property] = source[property];

  if (!row)
    return {
      op: 'create',
      set: {
        ...incoming,
        [IMPORT_LOCAL_ID]: sourceId,
        [IMPORT_BASELINE]: { values: incoming, previous: {} },
      },
    };

  const base = storedBaseline(row);
  // A field in the baseline that this run does not manage (the source could
  // not read it this time) keeps its baseline, so the next run that can read
  // it still tells an edit from a change.
  const next: Values = Object.fromEntries(
    Object.entries(base ?? {}).filter(([p]) => !managed.includes(p)),
  );
  const set: Values = {};
  const remove: string[] = [];
  const conflicts: Conflict[] = [];
  const conflict = (property: string) =>
    conflicts.push({
      property,
      source: incoming[property],
      row: row[property],
      base: base?.[property],
    });

  for (const property of managed) {
    const now = incoming[property];
    const current = row[property];

    if (!base) {
      // Nothing to tell an edit from a source change by: adopt what agrees.
      if (same(current, now)) {
        if (!absent(now)) next[property] = now;
      } else conflict(property);
      continue;
    }

    const before = base[property];

    if (same(current, now)) {
      if (!absent(now)) next[property] = now;
    } else if (same(now, before)) {
      // The source did not change; the row did. Keep the edit.
      if (!absent(before)) next[property] = before;
    } else if (same(current, before)) {
      // The row was not edited; the source changed or cleared it.
      if (absent(now)) {
        // The baseline keeps the old value until a later run sees the field
        // gone. A host that cannot remove (the pinned one) then retries the
        // removal instead of mistaking the leftover value for an edit.
        remove.push(property);
        next[property] = before;
      } else {
        set[property] = now;
        next[property] = now;
      }
    } else {
      // Both changed: keep the row, keep the old baseline, say so.
      if (!absent(before)) next[property] = before;
      conflict(property);
    }
  }

  const baselineChanged = !same(next, base ?? {});
  const adopt = row[IMPORT_LOCAL_ID] === undefined;

  if (!Object.keys(set).length && !remove.length && !baselineChanged && !adopt)
    return { op: 'unchanged', conflicts };

  return {
    op: 'update',
    set: {
      ...set,
      ...(adopt ? { [IMPORT_LOCAL_ID]: sourceId } : {}),
      // Always a fresh baseline. The host stamps a new `approval` into any
      // baseline it writes, so re-sending the stored one would not match
      // the server's copy and be refused as stale.
      [IMPORT_BASELINE]: { values: next, previous: base ?? {} },
    },
    remove,
    changesValues: Object.keys(set).length > 0 || remove.length > 0,
    conflicts,
  };
}
