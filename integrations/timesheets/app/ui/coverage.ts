// @wc-ignore-file
/**
 * M2 STUBS (#123 M2, the timeline lens): how the views show time whose
 * coverage is **unknown**, and **conflicts** between this drive and
 * Clockify. Both are fields of `Timesheet` (`../model/types.ts`): M1 fills
 * `unknown` with `unknownIntervals`, and `conflicts` is always empty.
 *
 * The views already call these two functions in the right places; each
 * returns `null` (render nothing) until M2 decides the presentation. Keep
 * the signatures; M2 replaces the bodies.
 */
import type { Interval, Timesheet } from '../model/types.js';
import type { H } from './dom.js';

/**
 * Called by the Week and Entries views for the displayed week (`span`,
 * `[from, to)` in epoch ms), above the grid or day list. `unknown` is
 * `sheet.unknown` clipped to `span`, possibly empty.
 *
 * TODO(M2): render the unknown coverage (e.g. a band, or hatched cells).
 */
export function renderUnknown(
  _h: H,
  _sheet: Timesheet,
  _span: Interval,
  _unknown: Interval[],
): HTMLElement | null {
  return null;
}

/**
 * Called once at the top of the content area of every data view, above the
 * error banners' data. `sheet.conflicts` may be empty.
 *
 * TODO(M2): render the conflict state (design frame N reserves a banner
 * that opens a side-by-side compare; v1 is read-only).
 */
export function renderConflicts(_h: H, _sheet: Timesheet): HTMLElement | null {
  return null;
}

/** `sheet.unknown` clipped to `span`. */
export const unknownIn = (sheet: Timesheet, span: Interval): Interval[] =>
  sheet.unknown
    .map(i => ({
      from: Math.max(i.from, span.from),
      to: Math.min(i.to, span.to),
    }))
    .filter(i => i.to > i.from);
