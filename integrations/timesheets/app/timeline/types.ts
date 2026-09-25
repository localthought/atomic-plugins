// @wc-ignore-file
/**
 * The timeline (#123 M2): what the aggregate sweep (`sweep.ts`) makes of the
 * mirror's claims and coverage, as non-overlapping segments per local day.
 * Read-only: nothing here is an edit yet (M3/M4).
 *
 * The views' `Timesheet` (`../model/types.ts`, owned by the #89 UI work)
 * takes two projections of it: `unknown` (unchanged shape) and `conflicts`,
 * whose elements are `TimelineConflict`s, a structural extension of the
 * views' `Conflict` (`{ entryId, fields }`) with the kind, span and
 * candidates, so a renderer that only knows `Conflict` still works.
 *
 * Times here are epoch ms, like the views' `Interval`: the view layer's
 * form. The mirror and the claims keep the provider's exact strings.
 */
import type { DayKey } from '../model/time.js';
import type { Conflict, Interval } from '../model/types.js';
import type {
  NotWorkedBadge,
  TimeLabel,
} from '../../devonian/clockify/lens/claims.js';

export type { NotWorkedBadge, TimeLabel };

/**
 * - `worked`: one project claims the span (or no project: `worked(none)`),
 *   possibly by several entries (`duplicate`).
 * - `didNotWork`: a complete read covers the span and no entry claims it,
 *   or only a break / holiday / time-off entry does (`label.badge`).
 * - `unknown`: no complete read covers the span, or an entry there is an
 *   unconfirmed absence candidate. Never shown as `didNotWork`.
 * - `conflict`: entries that cannot all be true claim the span.
 */
export type SegmentState = 'worked' | 'didNotWork' | 'unknown' | 'conflict';

/**
 * - `whichProject`: entries with different projects overlap, "no project"
 *   included ("unclear which project", #97 answer 3).
 * - `whetherWorked`: a worked entry overlaps a break, holiday or time off
 *   ("unclear whether worked").
 */
export type ConflictKind = 'whichProject' | 'whetherWorked';

/** Why an edit on this span would not be offered (M3+). */
export type ReadOnlyReason =
  /** A running timer (#97 answer 9). */
  | 'running'
  | 'locked'
  /** A break, holiday or time-off entry. */
  | 'entryType'
  /** Custom field values whose PUT shape is unverified (#123 §3.5). */
  | 'customFields'
  /** `worked(none)` in a workspace with `forceProjects`: Clockify refuses
   * an entry without a project there (checked live, #123). */
  | 'forceProjects'
  /** Not loaded. */
  | 'unknown';

export interface Segment extends Interval {
  state: SegmentState;
  /** For `worked` and `didNotWork`. */
  label?: TimeLabel;
  /** For `conflict`: every label claimed, sorted (projects by id, "no
   * project" after them, then not-worked). */
  conflict?: { kind: ConflictKind; candidates: TimeLabel[] };
  /** `worked` by two or more entries of the same project. */
  duplicate?: true;
  /** Includes a running timer. */
  open?: true;
  /** The entries claiming the span, sorted. Empty for `unknown`. */
  entryIds: string[];
  readOnly: ReadOnlyReason[];
}

export interface TimelineDay extends Interval {
  /** Local date in the timeline's zone. `to - from` is 23 or 25 h on a
   * DST change, and the last day ends at `now`. */
  day: DayKey;
  segments: Segment[];
}

/** A `Conflict` as the views know it, plus what the timeline knows. */
export interface TimelineConflict extends Conflict, Interval {
  /** `duplicate`: same project twice, not a question of which. */
  kind: ConflictKind | 'duplicate';
  /** Every entry involved; `entryId` is the first of them. */
  entryIds: string[];
  candidates: TimeLabel[];
}

export interface Timeline {
  timeZone: string;
  /** The look-back window the sync reads. */
  window: Interval;
  /** Whole local days from the one containing `window.from` up to `now`. */
  days: TimelineDay[];
  /** Unknown time inside `window` (M1's `unknownIntervals`). */
  unknown: Interval[];
  /** Maximal conflicting and duplicate spans, not split at midnight. */
  conflicts: TimelineConflict[];
}
