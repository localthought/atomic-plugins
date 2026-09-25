// @wc-ignore-file
/**
 * The three views' numbers (design #89 §6A–C), pure. Entries are bucketed on
 * the local day of their start instant: an entry that crosses midnight
 * counts wholly on its start day (§7).
 */
import { addDays, dayKey, startOfDay, type DayKey, type Week } from './time.js';
import type { Interval, Project, TimeEntry } from './types.js';

export const NO_PROJECT = '';

const durationOf = (e: TimeEntry) => Math.max(0, e.end - e.start);
const projectKey = (e: TimeEntry) => e.project?.id ?? NO_PROJECT;

/** A project's label: its name, else a short form of its id. */
export const projectLabel = (project: Project | undefined) =>
  !project ? 'No project' : (project.name ?? `Project ${project.id.slice(-6)}`);

export interface GridDay {
  key: DayKey;
  isToday: boolean;
  isFuture: boolean;
  /** False when the whole day lies before the import window. */
  inWindow: boolean;
}

export interface GridRow {
  /** `NO_PROJECT` for entries without one. */
  key: string;
  project?: Project;
  /** Milliseconds per day, in `days` order. */
  cells: number[];
  total: number;
}

export interface WeekGrid {
  days: GridDay[];
  rows: GridRow[];
  dayTotals: number[];
  total: number;
  billable: number;
  notBillable: number;
}

export interface GridOptions {
  timeZone: string;
  now: number;
  window?: Interval;
}

const byTotalThenName = (a: GridRow, b: GridRow) => {
  if (!a.project !== !b.project) return a.project ? -1 : 1;
  if (a.total !== b.total) return b.total - a.total;
  const [x, y] = [projectLabel(a.project), projectLabel(b.project)];

  return x < y ? -1 : x > y ? 1 : 0;
};

export function weekGrid(
  entries: TimeEntry[],
  week: Week,
  { timeZone, now, window }: GridOptions,
): WeekGrid {
  const today = dayKey(now, timeZone);
  const index = new Map(week.days.map((d, i) => [d, i]));
  const rows = new Map<string, GridRow>();
  const dayTotals = week.days.map(() => 0);
  let billable = 0;
  let total = 0;

  for (const entry of entries) {
    const i = index.get(dayKey(entry.start, timeZone));
    if (i === undefined) continue;
    const key = projectKey(entry);
    let row = rows.get(key);

    if (!row) {
      row = {
        key,
        ...(entry.project ? { project: entry.project } : {}),
        cells: week.days.map(() => 0),
        total: 0,
      };
      rows.set(key, row);
    }

    const ms = durationOf(entry);
    row.cells[i] += ms;
    row.total += ms;
    dayTotals[i] += ms;
    total += ms;
    if (entry.billable) billable += ms;
  }

  return {
    days: week.days.map(key => ({
      key,
      isToday: key === today,
      isFuture: key > today,
      inWindow: !window || startOfDay(addDays(key, 1), timeZone) > window.from,
    })),
    rows: [...rows.values()].sort(byTotalThenName),
    dayTotals,
    total,
    billable,
    notBillable: total - billable,
  };
}

export interface DayGroup {
  key: DayKey;
  total: number;
  /** Newest first. */
  entries: TimeEntry[];
}

/** The week's entries by day, newest day first; empty days omitted. */
export function dayList(
  entries: TimeEntry[],
  week: Week,
  timeZone: string,
): DayGroup[] {
  const days = new Set(week.days);
  const groups = new Map<DayKey, DayGroup>();

  for (const entry of entries) {
    const key = dayKey(entry.start, timeZone);
    if (!days.has(key)) continue;
    let group = groups.get(key);

    if (!group) {
      group = { key, total: 0, entries: [] };
      groups.set(key, group);
    }

    group.entries.push(entry);
    group.total += durationOf(entry);
  }

  for (const group of groups.values())
    group.entries.sort((a, b) => b.start - a.start || (a.id < b.id ? -1 : 1));

  return [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

export interface ProjectShare {
  key: string;
  project?: Project;
  total: number;
  billable: number;
  /** Share of the window's total in tenths of a percent (406 = 40.6%). The
   * shares of all rows sum to exactly 1000 (largest remainder). */
  shareTenths: number;
  /** Bar lengths relative to the largest project, 0–100. */
  barPercent: number;
  billableBarPercent: number;
}

export interface ProjectSummary {
  total: number;
  billable: number;
  notBillable: number;
  rows: ProjectShare[];
}

/** Largest-remainder rounding of `values` to integers summing to `sum`. */
export function apportion(values: number[], sum: number): number[] {
  const whole = values.reduce((a, b) => a + b, 0);
  if (!whole) return values.map(() => 0);
  const exact = values.map(v => (v * sum) / whole);
  const floors = exact.map(Math.floor);
  let left = sum - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);

  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }

  return floors;
}

/** Totals per project for entries starting inside `window`. */
export function projectSummary(
  entries: TimeEntry[],
  window: Interval | undefined,
): ProjectSummary {
  const rows = new Map<
    string,
    Omit<ProjectShare, 'shareTenths' | 'barPercent' | 'billableBarPercent'>
  >();
  let total = 0;
  let billable = 0;

  for (const entry of entries) {
    if (window && (entry.start < window.from || entry.start >= window.to))
      continue;
    const key = projectKey(entry);
    let row = rows.get(key);

    if (!row) {
      row = {
        key,
        ...(entry.project ? { project: entry.project } : {}),
        total: 0,
        billable: 0,
      };
      rows.set(key, row);
    }

    const ms = durationOf(entry);
    row.total += ms;
    total += ms;

    if (entry.billable) {
      row.billable += ms;
      billable += ms;
    }
  }

  const sorted = [...rows.values()].sort((a, b) =>
    byTotalThenName(
      { ...a, cells: [] } as GridRow,
      { ...b, cells: [] } as GridRow,
    ),
  );
  const largest = sorted[0]?.total ?? 0;
  // Shares of whole minutes, as displayed, so they agree with the totals.
  const shares = apportion(
    sorted.map(r => Math.round(r.total / 60_000)),
    1000,
  );
  const pct = (ms: number) =>
    largest ? Math.round((ms / largest) * 1000) / 10 : 0;

  return {
    total,
    billable,
    notBillable: total - billable,
    rows: sorted.map((r, i) => ({
      ...r,
      shareTenths: shares[i],
      barPercent: pct(r.total),
      billableBarPercent: pct(r.billable),
    })),
  };
}

/** `40.6%`. */
export const formatShare = (tenths: number) =>
  `${Math.floor(tenths / 10)}.${tenths % 10}%`;
