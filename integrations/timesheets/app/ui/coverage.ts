// @wc-ignore-file
/**
 * M2 hooks (#123 M2, the timeline lens): how the views show time whose
 * coverage is **unknown**, and **conflicts** between this drive and
 * Clockify. Both are fields of `Timesheet` (`../model/types.ts`).
 *
 * The views call these two functions in the right places. Since M2 the
 * timeline sweep (`../timeline/sweep.ts`) fills both fields and these
 * render them read-only; each returns `null` when there is nothing to show.
 */
import type { Interval, Timesheet } from '../model/types.js';
import { renderConflictList, renderUnknownSpans } from '../timeline/render.js';
import type { H } from './dom.js';

/**
 * Called by the Week and Entries views for the displayed week (`span`,
 * `[from, to)` in epoch ms), above the grid or day list. `unknown` is
 * `sheet.unknown` clipped to `span`, possibly empty.
 *
 * M2: a "Not loaded" note listing the spans (`../timeline/render.ts`);
 * nothing when `unknown` is empty.
 */
export function renderUnknown(
  h: H,
  sheet: Timesheet,
  _span: Interval,
  unknown: Interval[],
): HTMLElement | null {
  return renderUnknownSpans(h, sheet, unknown);
}

/**
 * Called once at the top of the content area of every data view, above the
 * error banners' data. `sheet.conflicts` may be empty.
 *
 * M2: a read-only list, one line per conflict (`../timeline/render.ts`);
 * nothing when there is none. Design frame N's banner with a side-by-side
 * compare and the resolve actions are M4.
 */
export function renderConflicts(h: H, sheet: Timesheet): HTMLElement | null {
  return renderConflictList(h, sheet);
}

/** `sheet.unknown` clipped to `span`. */
export const unknownIn = (sheet: Timesheet, span: Interval): Interval[] =>
  sheet.unknown
    .map(i => ({
      from: Math.max(i.from, span.from),
      to: Math.min(i.to, span.to),
    }))
    .filter(i => i.to > i.from);
