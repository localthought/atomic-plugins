// @wc-ignore-file
/**
 * The aggregate stage of the timeline lens (#97 §3.1, #123 §2.2, M2): a
 * sweep over every claim (`clockifyClaim`, the map stage) and the coverage
 * that turns them into non-overlapping segments, per local day in the
 * user's profile time zone. Provider claims only: intents (`pending`, local
 * conflicts) arrive with M3.
 *
 * Deterministic: claims, entry ids and candidates are sorted, so any two
 * replicas whose mirrors are equal (any fold order of the same
 * observations) produce equal timelines, conflicts included (#97 §5.1).
 *
 * Full recompute, O(n log n) in the claims of the loaded range (#97 §3.2):
 * not measured yet.
 */
import {
  clockifyClaim,
  type TimeClaim,
  type TimeLabel,
} from '../../devonian/clockify/lens/claims.js';
import { timeEntries, unknownIntervals } from '../clockifyObserve.js';
import type { Settings } from '../config.js';
import { addDays, dayKey, startOfDay } from '../model/time.js';
import type { Interval } from '../model/types.js';
import type { Mirror, MirrorRecord } from '../observations.js';
import type {
  ConflictKind,
  ReadOnlyReason,
  Segment,
  Timeline,
  TimelineConflict,
  TimelineDay,
} from './types.js';

export interface TimelineInput {
  mirror: Mirror;
  /** Whose entries, and which coverage, count. */
  settings: Pick<Settings, 'workspaceId' | 'userId'>;
  /** The look-back window the sync reads. */
  window: Interval;
  now: number;
  /** The user's profile time zone (`GET /user` → `settings.timeZone`). */
  timeZone: string;
  /** The workspace's `forceProjects`: `worked(none)` becomes read-only. */
  forceProjects?: boolean;
}

interface Claim extends Interval {
  claim: TimeClaim;
}

type Shape = Omit<Segment, 'from' | 'to'>;

const mine = (record: MirrorRecord, settings: TimelineInput['settings']) =>
  (record.fields.workspaceId ?? settings.workspaceId) ===
    settings.workspaceId &&
  (record.fields.userId ?? settings.userId) === settings.userId;

/**
 * The map stage over the mirror: one claim per entry of this user that is
 * neither confirmed deleted nor an absence candidate (whose span is
 * `unknown` instead), sorted by start, then id.
 */
export function claimsOf(
  mirror: Mirror,
  settings: TimelineInput['settings'],
  now: number,
): TimeClaim[] {
  return timeEntries(mirror)
    .filter(r => !r.deletedAt && !r.absentSince && mine(r, settings))
    .map(r => clockifyClaim(r, now))
    .filter((c): c is TimeClaim => !!c)
    .sort(
      (a, b) =>
        Date.parse(a.from) - Date.parse(b.from) ||
        (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0),
    );
}

const labelKey = (label: TimeLabel) =>
  label.kind === 'worked'
    ? `0${label.projectId === null ? '1' : `0${label.projectId}`}`
    : `1${label.badge ?? ''}`;

const byLabel = (a: TimeLabel, b: TimeLabel) =>
  labelKey(a) < labelKey(b) ? -1 : labelKey(a) > labelKey(b) ? 1 : 0;

/** What one elementary span between two boundaries is. */
function classify(
  active: TimeClaim[],
  unknown: boolean,
  forceProjects: boolean,
): Shape {
  if (unknown) return { state: 'unknown', entryIds: [], readOnly: ['unknown'] };
  if (!active.length)
    return {
      state: 'didNotWork',
      label: { kind: 'didNotWork' },
      entryIds: [],
      readOnly: [],
    };

  const entryIds = active.map(c => c.entryId).sort();
  const labels = [
    ...new Map(active.map(c => [labelKey(c.label), c.label])).values(),
  ].sort(byLabel);
  const worked = labels.filter(l => l.kind === 'worked');
  const reasons = new Set<ReadOnlyReason>();

  for (const c of active) {
    if (c.open) reasons.add('running');
    if (c.locked) reasons.add('locked');
    if (c.label.kind === 'didNotWork') reasons.add('entryType');
    if (c.customFields) reasons.add('customFields');
    if (
      forceProjects &&
      c.label.kind === 'worked' &&
      c.label.projectId === null
    )
      reasons.add('forceProjects');
  }

  const shape = {
    entryIds,
    readOnly: [...reasons].sort(),
    ...(active.some(c => c.open) ? { open: true as const } : {}),
  };

  if (!worked.length)
    return { state: 'didNotWork', label: labels[0], ...shape };

  if (labels.length === 1)
    return {
      state: 'worked',
      label: labels[0],
      ...(active.length > 1 ? { duplicate: true as const } : {}),
      ...shape,
    };

  const kind: ConflictKind =
    worked.length < labels.length ? 'whetherWorked' : 'whichProject';

  return {
    state: 'conflict',
    conflict: { kind, candidates: labels },
    ...shape,
  };
}

const shapeKey = (s: Segment) => JSON.stringify({ ...s, from: 0, to: 0 });

/** Adjacent spans with the same shape joined. */
function merge(segments: Segment[]): Segment[] {
  const out: Segment[] = [];

  for (const s of segments) {
    const last = out.at(-1);

    if (last && last.to === s.from && shapeKey(last) === shapeKey(s))
      last.to = s.to;
    else out.push({ ...s });
  }

  return out;
}

/** The local days from the one containing `from` up to `to`. */
function daysOf(from: number, to: number, timeZone: string) {
  const days: { day: string; from: number; to: number }[] = [];

  for (let day = dayKey(from, timeZone); ; day = addDays(day, 1)) {
    const start = startOfDay(day, timeZone);
    if (start >= to) break;
    days.push({
      day,
      from: start,
      to: Math.min(to, startOfDay(addDays(day, 1), timeZone)),
    });
  }

  return days;
}

export function buildTimeline(input: TimelineInput): Timeline {
  const { mirror, settings, window, now, timeZone } = input;
  const days = daysOf(window.from, now, timeZone);
  const range = { from: days[0]?.from ?? window.from, to: now };
  const unknown = unknownIntervals(mirror, settings, range, now);
  const claims: Claim[] = claimsOf(mirror, settings, now)
    .map(claim => ({
      claim,
      from: Math.max(range.from, Date.parse(claim.from)),
      to: Math.min(range.to, Date.parse(claim.to)),
    }))
    .filter(c => c.to > c.from);

  const bounds = new Set<number>([range.from, range.to]);
  for (const d of days) bounds.add(d.from).add(d.to);
  for (const c of claims) bounds.add(c.from).add(c.to);
  for (const u of unknown) bounds.add(u.from).add(u.to);
  const points = [...bounds]
    .filter(p => p >= range.from && p <= range.to)
    .sort((a, b) => a - b);

  const atoms: Segment[] = [];

  for (let i = 0; i + 1 < points.length; i++) {
    const [from, to] = [points[i], points[i + 1]];
    const active = claims
      .filter(c => c.from <= from && c.to >= to)
      .map(c => c.claim);
    const isUnknown = unknown.some(u => u.from <= from && u.to >= to);
    atoms.push({
      from,
      to,
      ...classify(active, isUnknown, input.forceProjects === true),
    });
  }

  const timelineDays: TimelineDay[] = days.map(d => ({
    ...d,
    segments: merge(atoms.filter(a => a.from >= d.from && a.to <= d.to)),
  }));

  const conflicts: TimelineConflict[] = merge(
    atoms.filter(a => a.state === 'conflict' || a.duplicate),
  ).map(s => ({
    entryId: s.entryIds[0],
    entryIds: s.entryIds,
    fields: s.duplicate
      ? ['start', 'end']
      : s.conflict!.kind === 'whichProject'
        ? ['projectId']
        : ['type'],
    kind: s.duplicate ? 'duplicate' : s.conflict!.kind,
    candidates: s.duplicate ? [s.label!] : s.conflict!.candidates,
    from: s.from,
    to: s.to,
  }));

  return {
    timeZone,
    window,
    days: timelineDays,
    unknown: unknownIntervals(mirror, settings, window, now),
    conflicts,
  };
}
