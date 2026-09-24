// @wc-ignore-file
/**
 * The observation log's data model, as pure functions (#97 §2, #123 M1).
 * Nothing here knows about Clockify, the host or storage: the Clockify
 * adapter (`clockifyObserve.ts`) turns reads into `Observation`s, and
 * `observationLog.ts` stores their `Incremental`s as Atomic resources. Kept
 * inside `integrations/timesheets/app/` until a second plugin needs it
 * (#97 answer 10).
 *
 * - An **observation** is one logical read: all pages of one list call, or
 *   one GET by id. It says what it was complete for (its `scope`) and which
 *   fields it returned (its `mask`).
 * - It is stored as an **incremental**: only the records that differ from
 *   the mirror within scope and mask, plus the ids the mirror places inside
 *   the scope that the read did not return (`absent`).
 * - The **mirror** is the fold of the incrementals, ordered by
 *   `(receivedAt, id)`, so every device that holds the same set folds to the
 *   same mirror. A range read's absence is only a *candidate*
 *   (`absentSince`); a point read that finds nothing confirms the deletion
 *   (`deletedAt`).
 * - **Coverage** is where on a range field (for Clockify, the entry's start)
 *   a complete read has looked, with the last time it did.
 *
 * Instants stay the exact strings they arrived as; they are parsed only to
 * compare them.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** Complete for records of `collection` whose `params` fields equal these
 * values and whose `field` instant is in `[from, to)`. */
export interface RangeScope {
  type: 'range';
  collection: string;
  params: Record<string, string>;
  field: string;
  from: string;
  to: string;
}

/** Complete for exactly one record. */
export interface IdScope {
  type: 'id';
  collection: string;
  id: string;
}

export type Scope = RangeScope | IdScope;

export interface CanonicalRecord {
  id: string;
  fields: Record<string, Json>;
}

export type ObservationKind = 'list' | 'point' | 'write-response';

interface ObservationHeader {
  /** Unique across devices; ties on `receivedAt` are ordered by it. */
  id: string;
  /** Which app instance made it. Informational only. */
  device: string;
  /** ISO 8601: the first request was sent. */
  sentAt: string;
  /** ISO 8601: the last response arrived. The fold orders by this. */
  receivedAt: string;
  kind: ObservationKind;
  scope: Scope;
  /** Canonical fields the read returned. Others keep their earlier values. */
  mask: string[];
  /** False when paging stopped early: upserts count, absences do not. */
  complete: boolean;
  /** The provider query as sent, when it differs from the scope (e.g.
   * wall-clock bounds in the user's time zone). Provenance only. */
  query?: Record<string, string>;
}

/** A read as it happened, before it is diffed against the mirror. */
export interface Observation extends ObservationHeader {
  records: CanonicalRecord[];
}

/** How an observation is stored. */
export interface Incremental extends ObservationHeader {
  v: 1;
  /** New or changed records, reduced to the masked fields. */
  upserts: CanonicalRecord[];
  /** Ids the mirror placed in scope that the read did not return. */
  absent: string[];
  /** Records returned unchanged, for reports only. */
  unchanged: number;
  /** FNV-1a of the full canonical response, for reports only. */
  digest: string;
}

export interface MirrorRecord {
  id: string;
  collection: string;
  fields: Record<string, Json>;
  /** `receivedAt` of the last incremental that carried this record. */
  lastSeenAt: string;
  /** A complete range read did not return it: probably gone, not confirmed. */
  absentSince?: string;
  /** A point read found nothing: gone. */
  deletedAt?: string;
}

export interface CoverageSegment {
  /** Which range this covers: collection, params and field (`coverageKey`). */
  key: string;
  from: string;
  to: string;
  /** The latest `receivedAt` of a complete read that covered this span. */
  confirmedAt: string;
}

export interface Mirror {
  /** Keyed by `recordKey(collection, id)`. */
  records: Record<string, MirrorRecord>;
  coverage: CoverageSegment[];
}

export interface Position {
  receivedAt: string;
  id: string;
}

export const emptyMirror = (): Mirror => ({ records: {}, coverage: [] });

export const recordKey = (collection: string, id: string) =>
  `${collection}/${id}`;

export const ms = (instant: string) => Date.parse(instant);

/** Total order of the fold: `receivedAt` as an instant, then `id`. */
export function comparePositions(a: Position, b: Position): number {
  const byTime = ms(a.receivedAt) - ms(b.receivedAt);
  if (byTime !== 0) return byTime;
  if (a.receivedAt !== b.receivedAt)
    return a.receivedAt < b.receivedAt ? -1 : 1;
  if (a.id === b.id) return 0;

  return a.id < b.id ? -1 : 1;
}

/** JSON with object keys sorted, so equal values serialize equally. */
export function stableStringify(value: Json | undefined): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;

  return JSON.stringify(value);
}

/** 32-bit FNV-1a, hex. A report digest, not a security property. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

export function coverageKey(scope: RangeScope): string {
  const params = Object.keys(scope.params)
    .sort()
    .map(k => `${k}=${scope.params[k]}`)
    .join('&');

  return `${scope.collection}?${params}#${scope.field}`;
}

/** Is the mirror's copy of a record inside `scope`? Decided from the mirror's
 * values, so a record the provider moved out of the window looks absent;
 * that is why absence from a range read is only a candidate. */
export function inScope(scope: Scope, record: MirrorRecord): boolean {
  if (record.collection !== scope.collection) return false;
  if (scope.type === 'id') return record.id === scope.id;

  for (const [field, value] of Object.entries(scope.params))
    if (record.fields[field] !== value) return false;
  const at = record.fields[scope.field];
  if (typeof at !== 'string') return false;
  const t = ms(at);

  return t >= ms(scope.from) && t < ms(scope.to);
}

const pick = (fields: Record<string, Json>, mask: string[]) => {
  const out: Record<string, Json> = {};
  for (const field of mask) out[field] = fields[field] ?? null;

  return out;
};

/**
 * The mask-diff (#97 §2.2): what of `observation` is new against `mirror`.
 * A field outside the mask is never compared or cleared. Absences are only
 * listed for a complete observation, and only for records not already
 * marked absent or deleted.
 */
export function diffObservation(
  mirror: Mirror,
  observation: Observation,
): Incremental {
  const { records, ...header } = observation;
  const { collection } = observation.scope;
  const upserts: CanonicalRecord[] = [];
  const returned = new Set<string>();
  let unchanged = 0;

  for (const record of records) {
    returned.add(record.id);
    const masked = pick(record.fields, observation.mask);
    const previous = mirror.records[recordKey(collection, record.id)];
    const same =
      previous &&
      !previous.absentSince &&
      !previous.deletedAt &&
      observation.mask.every(
        field =>
          stableStringify(previous.fields[field] ?? null) ===
          stableStringify(masked[field]),
      );

    if (same) unchanged++;
    else upserts.push({ id: record.id, fields: masked });
  }

  const absent = observation.complete
    ? Object.values(mirror.records)
        .filter(
          r =>
            !r.deletedAt &&
            (!r.absentSince || observation.scope.type === 'id') &&
            !returned.has(r.id) &&
            inScope(observation.scope, r),
        )
        .map(r => r.id)
        .sort()
    : [];

  return {
    v: 1,
    ...header,
    upserts,
    absent,
    unchanged,
    digest: fnv1a(
      stableStringify(
        [...records]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map(r => ({ id: r.id, fields: r.fields })) as Json,
      ),
    ),
  };
}

export const isEmpty = (incremental: Incremental) =>
  !incremental.upserts.length && !incremental.absent.length;

/**
 * Adds `[from, to)` confirmed at `at` to the coverage of `key`. Segments of
 * one key stay disjoint and sorted; each span keeps the latest confirmation.
 */
export function addCoverage(
  coverage: CoverageSegment[],
  key: string,
  from: string,
  to: string,
  at: string,
): CoverageSegment[] {
  if (!(ms(from) < ms(to))) return coverage;
  const own = coverage.filter(c => c.key === key);
  const others = coverage.filter(c => c.key !== key);
  const spans = [...own, { key, from, to, confirmedAt: at }];
  const bounds = new Map<number, string>();

  for (const s of spans) {
    if (!bounds.has(ms(s.from))) bounds.set(ms(s.from), s.from);
    if (!bounds.has(ms(s.to))) bounds.set(ms(s.to), s.to);
  }

  const points = [...bounds.keys()].sort((a, b) => a - b);
  const merged: CoverageSegment[] = [];

  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const covering = spans.filter(s => ms(s.from) <= a && ms(s.to) >= b);
    if (!covering.length) continue;
    const confirmedAt = covering
      .map(s => s.confirmedAt)
      .reduce((x, y) => (ms(y) > ms(x) ? y : x));
    const last = merged.at(-1);

    if (last && ms(last.to) === a && last.confirmedAt === confirmedAt)
      last.to = bounds.get(b)!;
    else
      merged.push({
        key,
        from: bounds.get(a)!,
        to: bounds.get(b)!,
        confirmedAt,
      });
  }

  return [...others, ...merged];
}

/** Every segment of `b` added into `a`. Commutative, idempotent. */
export function mergeCoverage(
  a: CoverageSegment[],
  b: CoverageSegment[],
): CoverageSegment[] {
  return b.reduce(
    (acc, s) => addCoverage(acc, s.key, s.from, s.to, s.confirmedAt),
    a,
  );
}

/** Coverage in a canonical order, for comparing mirrors. */
export const sortCoverage = (coverage: CoverageSegment[]) =>
  [...coverage].sort(
    (a, b) =>
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || ms(a.from) - ms(b.from),
  );

function applyIncremental(mirror: Mirror, incremental: Incremental) {
  const { collection } = incremental.scope;

  for (const upsert of incremental.upserts) {
    const key = recordKey(collection, upsert.id);
    const previous = mirror.records[key];
    mirror.records[key] = {
      id: upsert.id,
      collection,
      fields: { ...(previous?.fields ?? {}), ...upsert.fields },
      lastSeenAt: incremental.receivedAt,
    };
  }

  for (const id of incremental.absent) {
    const record = mirror.records[recordKey(collection, id)];
    if (!record) continue;

    if (incremental.scope.type === 'id') {
      record.deletedAt = incremental.receivedAt;
      delete record.absentSince;
    } else if (!record.deletedAt && !record.absentSince)
      record.absentSince = incremental.receivedAt;
  }

  if (incremental.complete && incremental.scope.type === 'range')
    mirror.coverage = addCoverage(
      mirror.coverage,
      coverageKey(incremental.scope),
      incremental.scope.from,
      incremental.scope.to,
      incremental.receivedAt,
    );
}

/**
 * Folds incrementals onto `base` in `(receivedAt, id)` order. Pure: `base`
 * and the incrementals are not modified. Folding any permutation of the same
 * set gives the same mirror; folding a snapshot of a prefix and then the rest
 * equals folding everything, as long as the rest sorts after the prefix.
 */
export function fold(base: Mirror, incrementals: Incremental[]): Mirror {
  const mirror = structuredClone(base);

  for (const incremental of [...incrementals].sort(comparePositions))
    applyIncremental(mirror, incremental);

  mirror.coverage = sortCoverage(mirror.coverage);

  return mirror;
}

/** A mirror in canonical JSON, for equality checks. */
export const mirrorDigest = (mirror: Mirror) =>
  stableStringify({
    records: mirror.records,
    coverage: sortCoverage(mirror.coverage),
  } as unknown as Json);
