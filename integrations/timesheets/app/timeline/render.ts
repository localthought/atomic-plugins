// @wc-ignore-file
/**
 * How the views show the timeline's `unknown` spans and conflicts (#123 §4,
 * M2: read-only, no actions yet). `../ui/coverage.ts` calls these from its
 * two hooks. The text is built by pure functions so it is testable without a
 * DOM; the elements only carry it.
 */
import { dayKey, formatDay, formatTime } from '../model/time.js';
import type { Conflict, Interval, Timesheet } from '../model/types.js';
import { projectLabel } from '../model/views.js';
import type { H } from '../ui/dom.js';
import type { TimeLabel, TimelineConflict } from './types.js';

const BADGE_TEXT = {
  break: 'Break',
  holiday: 'Holiday',
  timeOff: 'Time off',
} as const;

/** `22 Sep 09:00 – 10:30`, or `22 Sep 23:00 – 23 Sep 01:00` across midnight. */
export function spanText({ from, to }: Interval, timeZone: string): string {
  const [a, b] = [dayKey(from, timeZone), dayKey(to - 1, timeZone)];
  const start = `${formatDay(a)} ${formatTime(from, timeZone)}`;

  return a === b
    ? `${start} – ${formatTime(to, timeZone)}`
    : `${start} – ${formatDay(dayKey(to, timeZone))} ${formatTime(to, timeZone)}`;
}

/** `Atomic plugins`, `No project`, `Break`, `Did not work`. */
export function labelText(label: TimeLabel, sheet: Timesheet): string {
  if (label.kind === 'didNotWork')
    return label.badge ? BADGE_TEXT[label.badge] : 'Did not work';
  if (label.projectId === null) return 'No project';
  const known = sheet.entries.find(
    e => e.project?.id === label.projectId,
  )?.project;

  return projectLabel(known ?? { id: label.projectId });
}

const isTimelineConflict = (c: Conflict): c is TimelineConflict =>
  'kind' in c && 'candidates' in c && 'from' in c;

/** One conflict as a sentence. A plain `Conflict` (no timeline fields)
 * names only the entry and fields. */
export function conflictText(conflict: Conflict, sheet: Timesheet): string {
  if (!isTimelineConflict(conflict))
    return `Entry ${conflict.entryId}: ${conflict.fields.join(', ')} disagree`;
  const span = spanText(conflict, sheet.timeZone);
  const names = conflict.candidates.map(l => labelText(l, sheet)).join(' · ');
  const entries = `${conflict.entryIds.length} entries`;

  switch (conflict.kind) {
    case 'duplicate':
      return `${names} twice (${entries}), ${span}`;
    case 'whichProject':
      return `Unclear which project: ${names} (${entries}), ${span}`;
    case 'whetherWorked':
      return `Unclear whether worked: ${names} (${entries}), ${span}`;
  }
}

export function renderUnknownSpans(
  h: H,
  sheet: Timesheet,
  unknown: Interval[],
): HTMLElement | null {
  if (!unknown.length) return null;

  return h(
    'div',
    { class: 'unknown', role: 'note', 'aria-label': 'Not loaded' },
    h('strong', null, 'Not loaded: '),
    unknown.map(i => spanText(i, sheet.timeZone)).join('; '),
    '. No complete read of Clockify covers this time, so it is not shown as “did not work”.',
  );
}

export function renderConflictList(h: H, sheet: Timesheet): HTMLElement | null {
  if (!sheet.conflicts.length) return null;
  const n = sheet.conflicts.length;

  return h(
    'section',
    { class: 'conflicts', 'aria-label': 'Conflicts in Clockify' },
    h(
      'p',
      null,
      h(
        'strong',
        null,
        `${n} ${n === 1 ? 'conflict' : 'conflicts'} in Clockify`,
      ),
      ' (read-only for now: fix them in Clockify)',
    ),
    h(
      'ul',
      null,
      sheet.conflicts.map(c => h('li', null, conflictText(c, sheet))),
    ),
  );
}
