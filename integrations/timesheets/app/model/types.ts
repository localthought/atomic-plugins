// @wc-ignore-file
/**
 * The view model's input: what the Week, Entries, Projects and Detail views
 * show, independent of where it came from. Today `source.ts` builds it from
 * the M1 observation log's mirror (#123); M2's timeline lens is meant to
 * fill the same shape, plus the `unknown` and `conflicts` hooks below, which
 * the UI renders only as marked stubs for now.
 */
import type { WeekStart } from './time.js';

export interface Project {
  id: string;
  /** The Clockify name; absent when project names could not be loaded. */
  name?: string;
  /** `#rrggbb` from Clockify, when known. */
  color?: string;
  client?: string;
}

/** One completed time entry. Running timers and breaks are not entries. */
export interface TimeEntry {
  id: string;
  /** Empty when the entry has none. */
  description: string;
  /** Epoch ms. */
  start: number;
  end: number;
  billable: boolean;
  project?: Project;
  member?: string;
}

/** `[from, to)` in epoch ms. */
export interface Interval {
  from: number;
  to: number;
}

/**
 * A conflict between this drive and Clockify. Only possible once edits
 * flow back (design frame N, later; M2+). Always empty in v1.
 */
export interface Conflict {
  entryId: string;
  fields: string[];
}

export interface Timesheet {
  entries: TimeEntry[];
  /** Counted, not shown as entries (design §6A note). */
  running: number;
  breaks: number;
  /** The current import window, when settings are known. */
  window?: Interval;
  /** When a complete read last confirmed the window (ISO), if ever. */
  lastChecked?: string;
  weekStart: WeekStart;
  /** Days are grouped in this IANA zone. */
  timeZone: string;
  /**
   * M2 hook: time in the window no complete read covers. M1 computes it
   * (`clockifyObserve.unknownIntervals`); the views render it only as a
   * stub until M2's timeline lens defines how.
   */
  unknown: Interval[];
  /** M2 hook: see `Conflict`. */
  conflicts: Conflict[];
}
