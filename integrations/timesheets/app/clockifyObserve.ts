// @wc-ignore-file
import { MAX_PAGES, PAGE_SIZE, type RawTimeEntry } from './clockifyApi.js';
import {
  coverageKey,
  ms,
  type CanonicalRecord,
  type Json,
  type Mirror,
  type MirrorRecord,
  type Observation,
  type RangeScope,
} from './observations.js';
import {
  instantsOf,
  MAX_ZONE_OFFSET_MS,
  wallClock,
  wallClockParam,
} from './timeZone.js';
import { ProxyError, requestJson, type ProxyTransport } from './transport.js';

/**
 * Clockify as the observation log sees it (#123 §2, M1): what a time entry
 * is canonically, which reads produce which observations, and which spans of
 * time those reads actually cover. Read-only: nothing here writes.
 *
 * Checked against a live account on 2026-09-24 (#123), and modelled by the
 * mock:
 * - the list's `start`/`end` are wall-clock time in the user's profile
 *   time zone (see `timeZone.ts`), and select entries whose *start* is in
 *   `[start, end)`;
 * - lists come newest start first, so a deletion between pages can make the
 *   next page skip one entry (caught by the confirming GET);
 * - GET by id of a deleted or unknown entry answers 400 "Time entry doesn't
 *   belong to Workspace", not 404.
 * Not checked: how a wall-clock bound in a repeated or skipped DST hour is
 * resolved; the recorded scope assumes the reading that covers least.
 */

export const TIME_ENTRY = 'timeEntry';
/** integration-proxy's body for a 404 it answers itself (`proxy.rs`). */
export const PROXY_NOT_IN_CATALOG = 'method or path is not in the catalog';
/** Clockify's 400 message for GET by id of a deleted or unknown entry. */
export const NOT_IN_WORKSPACE = "Time entry doesn't belong to Workspace";
const HOUR = 3_600_000;

/** Every range read starts this much earlier than the window it is for. */
export const MARGIN_MS = 24 * HOUR;

/**
 * The fields the sync manages, with provider names. Everything else on the
 * entry (and in `timeInterval`, e.g. `duration`, `timeZone`, `zonedStart`,
 * `offsetStart`) is kept verbatim in `extra`, uninterpreted, so a later
 * full-replacement PUT can send it back.
 */
export const ENTRY_FIELDS = [
  'start',
  'end',
  'projectId',
  'taskId',
  'description',
  'billable',
  'tagIds',
  'type',
  'isLocked',
  'userId',
  'workspaceId',
  'customFieldValues',
  'extra',
] as const;

/** Both a list read and a GET by id return full entries. */
export const ENTRY_MASK: string[] = [...ENTRY_FIELDS];

const json = (value: unknown): Json =>
  value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Json);

export function canonicalEntry(raw: RawTimeEntry): CanonicalRecord {
  const { id, timeInterval, ...rest } = raw;
  const { start, end, ...intervalExtra } = (timeInterval ?? {}) as Record<
    string,
    unknown
  >;
  const extra: Record<string, unknown> = {};
  const fields: Record<string, Json> = {
    start: typeof start === 'string' ? start : null,
    end: typeof end === 'string' ? end : null,
  };

  for (const [key, value] of Object.entries(rest)) {
    if ((ENTRY_FIELDS as readonly string[]).includes(key))
      fields[key] = json(value);
    else extra[key] = value;
  }

  for (const field of ENTRY_FIELDS)
    if (!(field in fields) && field !== 'extra') fields[field] = null;
  if (Object.keys(intervalExtra).length) extra.timeInterval = intervalExtra;
  fields.extra = json(extra);

  return { id, fields };
}

/** Back to the provider's shape, for the lens and (later) PUT bodies. */
export function rawFromCanonical(record: MirrorRecord): RawTimeEntry {
  const {
    start,
    end,
    extra,
    ...rest
  }: Record<string, Json> & { extra?: Json } = record.fields;
  const { timeInterval, ...other } = (
    extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}
  ) as Record<string, Json>;

  return {
    ...other,
    ...rest,
    id: record.id,
    timeInterval: {
      ...(timeInterval && typeof timeInterval === 'object'
        ? (timeInterval as Record<string, Json>)
        : {}),
      start: typeof start === 'string' ? start : null,
      end: typeof end === 'string' ? end : null,
    },
  } as RawTimeEntry;
}

export interface ReadContext {
  transport: ProxyTransport;
  workspaceId: string;
  userId: string;
  /** Wall clock in epoch ms; `sentAt`/`receivedAt` come from it. */
  clock: () => number;
  /**
   * The user's profile time zone (`GET /user` → `settings.timeZone`), which
   * Clockify reads the list's bounds in. Unknown: the bounds are sent as UTC
   * digits and the recorded scope is narrowed by 14 h at each end, since
   * Clockify may read them in any zone.
   */
  timeZone?: string;
  newId: () => string;
  device: string;
}

const iso = (at: number) => new Date(at).toISOString();

/** Clockify wants `yyyy-MM-ddThh:mm:ssZ`. */
export const clockifyInstant = (at: number) =>
  new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');

const listPath = (c: ReadContext) =>
  `/api/v1/workspaces/${encodeURIComponent(c.workspaceId)}/user/${encodeURIComponent(c.userId)}/time-entries`;

type Account = Pick<ReadContext, 'workspaceId' | 'userId'>;

export function rangeScope(c: Account, from: string, to: string): RangeScope {
  return {
    type: 'range',
    collection: TIME_ENTRY,
    params: { workspaceId: c.workspaceId, userId: c.userId },
    field: 'start',
    from,
    to,
  };
}

export interface RangeRead {
  observation: Observation;
  /** Set when paging stopped early; the observation is then incomplete. */
  error?: unknown;
}

/**
 * The query bounds for `[from, to)` (whole seconds), and the UTC span the
 * read is then known to be complete for: the latest instant the `start`
 * bound can mean and the earliest the `end` bound can mean.
 */
export function rangeBounds(
  from: number,
  to: number,
  timeZone: string | undefined,
): { query: { start: string; end: string }; from: number; to: number } {
  const [f, t] = [from, to].map(at => Math.floor(at / 1000) * 1000);

  if (!timeZone)
    return {
      query: { start: clockifyInstant(f), end: clockifyInstant(t) },
      from: f + MAX_ZONE_OFFSET_MS,
      to: t - MAX_ZONE_OFFSET_MS,
    };

  return {
    query: {
      start: wallClockParam(f, timeZone),
      end: wallClockParam(t, timeZone),
    },
    from: Math.max(...instantsOf(wallClock(f, timeZone), timeZone)),
    to: Math.min(...instantsOf(wallClock(t, timeZone), timeZone)),
  };
}

/**
 * All pages of the user's time entries starting in `[from, to)`, as one
 * observation. A failure on the first page throws and observes nothing. A
 * failure on a later page returns what was read, marked incomplete, with
 * the error: its upserts count, but it proves no absence and adds no
 * coverage.
 */
export async function readRange(
  c: ReadContext,
  from: number,
  to: number,
): Promise<RangeRead> {
  const bounds = rangeBounds(from, to, c.timeZone);
  const scope = rangeScope(
    c,
    clockifyInstant(bounds.from),
    clockifyInstant(Math.max(bounds.from, bounds.to)),
  );
  const sentAt = iso(c.clock());
  const records: CanonicalRecord[] = [];
  let error: unknown;
  let complete = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let items: RawTimeEntry[];

    try {
      items = await requestJson<RawTimeEntry[]>(c.transport, listPath(c), {
        ...bounds.query,
        page: String(page),
        'page-size': String(PAGE_SIZE),
      });
      if (!Array.isArray(items))
        throw new Error(`Clockify ${listPath(c)} did not return a list`);
    } catch (caught) {
      if (page === 1) throw caught;
      error = caught;
      break;
    }

    for (const item of items)
      if (item && typeof item.id === 'string')
        records.push(canonicalEntry(item));

    if (items.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (!complete && !error)
    error = new Error(
      `Clockify ${listPath(c)} returned more than ${MAX_PAGES} pages`,
    );

  return {
    observation: {
      id: c.newId(),
      device: c.device,
      sentAt,
      receivedAt: iso(c.clock()),
      kind: 'list',
      scope,
      query: {
        ...bounds.query,
        ...(c.timeZone ? { timeZone: c.timeZone } : {}),
      },
      mask: ENTRY_MASK,
      complete,
      records: dedupe(records),
    },
    ...(error ? { error } : {}),
  };
}

/** A page shift can serve one entry twice; keep the last copy. */
const dedupe = (records: CanonicalRecord[]) => [
  ...new Map(records.map(r => [r.id, r])).values(),
];

/** Does this failed GET by id say the entry is gone? */
export function saysDeleted(error: unknown): boolean {
  if (!(error instanceof ProxyError)) return false;
  const message =
    error.body && typeof error.body === 'object' && 'message' in error.body
      ? (error.body as { message: unknown }).message
      : undefined;

  // Live, Clockify answers 400 with this message. A 404 is accepted too,
  // except the proxy's own for an operation missing from its catalog.
  if (error.status === 400) return message === NOT_IN_WORKSPACE;

  return error.status === 404 && error.body !== PROXY_NOT_IN_CATALOG;
}

/**
 * One entry by id (`GET /workspaces/{ws}/time-entries/{id}`). 200 observes
 * it; `saysDeleted` observes that it is gone, which confirms an absence
 * candidate. Anything else, any other 400 included, throws and observes
 * nothing.
 */
export async function readOne(
  c: ReadContext,
  id: string,
): Promise<Observation> {
  const sentAt = iso(c.clock());
  const path = `/api/v1/workspaces/${encodeURIComponent(c.workspaceId)}/time-entries/${encodeURIComponent(id)}`;
  let records: CanonicalRecord[];

  try {
    const entry = await requestJson<RawTimeEntry>(c.transport, path);
    if (!entry || entry.id !== id)
      throw new Error(`Clockify ${path} returned another entry`);
    records = [canonicalEntry(entry)];
  } catch (error) {
    if (!saysDeleted(error)) throw error;
    records = [];
  }

  return {
    id: c.newId(),
    device: c.device,
    sentAt,
    receivedAt: iso(c.clock()),
    kind: 'point',
    scope: { type: 'id', collection: TIME_ENTRY, id },
    mask: ENTRY_MASK,
    complete: true,
    records,
  };
}

export const timeEntries = (mirror: Mirror): MirrorRecord[] =>
  Object.values(mirror.records).filter(r => r.collection === TIME_ENTRY);

/** Entries a complete range read did not return, not yet confirmed. */
export const absenceCandidates = (mirror: Mirror) =>
  timeEntries(mirror)
    .filter(r => r.absentSince && !r.deletedAt)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

export interface Interval {
  from: number;
  to: number;
}

const span = (record: MirrorRecord, now: number): Interval | undefined => {
  const { start, end } = record.fields;
  if (typeof start !== 'string') return undefined;
  const from = ms(start);
  const to = typeof end === 'string' ? ms(end) : now;

  return Number.isFinite(from) && Number.isFinite(to) && to > from
    ? { from, to }
    : undefined;
};

/**
 * The longest entry the mirror knows, running timers counted up to `now`,
 * but never less than the margin. A start-filtered read over `[s', e)`
 * sees every entry that *starts* there; an entry that started earlier can
 * still reach into it. Time `t` counts as known only if starts are covered
 * back to `t − longest`: under the assumption that no entry is longer than
 * the longest one seen (or 24 h), nothing unseen can overlap `t`.
 */
export function longestEntryMs(mirror: Mirror, now: number): number {
  let longest = MARGIN_MS;

  for (const record of timeEntries(mirror)) {
    if (record.deletedAt) continue;
    const s = span(record, now);
    if (s) longest = Math.max(longest, s.to - s.from);
  }

  return longest;
}

/** Overlapping or touching intervals merged, sorted. */
function union(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];

  for (const i of [...intervals].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && i.from <= last.to) last.to = Math.max(last.to, i.to);
    else merged.push({ ...i });
  }

  return merged;
}

function subtract(intervals: Interval[], cut: Interval): Interval[] {
  return intervals.flatMap(i => {
    if (cut.to <= i.from || cut.from >= i.to) return [i];

    return [
      ...(cut.from > i.from ? [{ from: i.from, to: cut.from }] : []),
      ...(cut.to < i.to ? [{ from: cut.to, to: i.to }] : []),
    ];
  });
}

/**
 * What time in `window` is **unknown** (#123 §2.2): not covered by a
 * complete read once the coverage over starts is shortened by the longest
 * entry, or overlapped by an entry that is only an absence candidate.
 * Everything else in the window is known: worked where an entry claims it,
 * not worked where none does.
 */
export function unknownIntervals(
  mirror: Mirror,
  c: Account,
  window: Interval,
  now: number,
): Interval[] {
  const key = coverageKey(rangeScope(c, '', ''));
  const longest = longestEntryMs(mirror, now);
  let unknown: Interval[] = [window];

  // Erode the union of what was read, not each read on its own: two
  // adjacent reads cover starts continuously across their boundary.
  for (const covered of union(
    mirror.coverage
      .filter(segment => segment.key === key)
      .map(segment => ({ from: ms(segment.from), to: ms(segment.to) })),
  )) {
    const from = covered.from + longest;
    if (from < covered.to)
      unknown = subtract(unknown, { from, to: covered.to });
  }

  for (const record of absenceCandidates(mirror)) {
    const s = span(record, now);
    if (!s) continue;
    const cut = {
      from: Math.max(s.from, window.from),
      to: Math.min(s.to, window.to),
    };
    if (cut.from < cut.to)
      unknown = [...subtract(unknown, cut), cut].sort(
        (a, b) => a.from - b.from,
      );
  }

  return unknown.filter(i => i.to > i.from);
}

export const totalMs = (intervals: Interval[]) =>
  intervals.reduce((sum, i) => sum + (i.to - i.from), 0);
