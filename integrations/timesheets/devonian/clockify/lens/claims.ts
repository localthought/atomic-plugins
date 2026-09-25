// @wc-ignore-file
/**
 * The map stage of the timeline lens (#97 §3.1, #123 §2.1, M2): one Clockify
 * time entry, in the observation log's canonical form, becomes at most one
 * **claim** over `[start, end)`. Per record and pure, so it can later re-run
 * for only the records an incremental touched (#97 §3.2). What happens
 * where claims overlap is the aggregate's business
 * (`app/timeline/sweep.ts`), not this lens's.
 *
 * | Entry                                  | Claim                              |
 * |----------------------------------------|------------------------------------|
 * | `REGULAR`, `end` set, `projectId = P`  | `worked(P)`                        |
 * | `REGULAR`, `end` set, no project       | `worked(none)` (#97 answer 3)      |
 * | `end = null` (running timer)           | `worked(P)` up to `now`, `open`    |
 * | `BREAK`                                | `didNotWork`, badge `break`        |
 * | `HOLIDAY` / `TIME_OFF`                 | `didNotWork`, badge with the type  |
 * | `isLocked: true`                       | as above, flagged `locked`         |
 * | custom field values present            | as above, flagged `customFields`   |
 *
 * `HOLIDAY` and `TIME_OFF` are enum values in Clockify's published spec; no
 * such entry has been observed live. An unknown `type` is read as
 * `REGULAR`. An entry without a valid start, or with `end <= start`, makes
 * no claim. Instants stay the exact strings the provider sent; a running
 * timer's end is `now` in Clockify's `yyyy-MM-ddTHH:mm:ssZ` form.
 */

/** Why a span is not work, when an entry says so. */
export type NotWorkedBadge = 'break' | 'holiday' | 'timeOff';

export type TimeLabel =
  | { kind: 'worked'; projectId: string | null }
  | { kind: 'didNotWork'; badge?: NotWorkedBadge };

export interface TimeClaim {
  entryId: string;
  /** Exact instant strings, `[from, to)`. */
  from: string;
  to: string;
  label: TimeLabel;
  /** A running timer, claimed up to `now`. */
  open?: true;
  locked?: true;
  /** Has custom field values: not editable until the PUT shape for them
   * is checked live (#123 §3.5). */
  customFields?: true;
}

/** The canonical fields the lens reads (`app/clockifyObserve.ts`). */
export interface ClockifyEntryRecord {
  id: string;
  fields: Record<string, unknown>;
}

const BADGES: Record<string, NotWorkedBadge> = {
  BREAK: 'break',
  HOLIDAY: 'holiday',
  TIME_OFF: 'timeOff',
};

const at = (value: unknown) =>
  typeof value === 'string' ? Date.parse(value) : NaN;

export function clockifyClaim(
  entry: ClockifyEntryRecord,
  now: number,
): TimeClaim | undefined {
  const { start, end, projectId, type, isLocked, customFieldValues } =
    entry.fields;
  const from = at(start);
  const open = end === null || end === undefined;
  const to = open ? now : at(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from))
    return undefined;
  const badge = typeof type === 'string' ? BADGES[type] : undefined;

  return {
    entryId: entry.id,
    from: start as string,
    to: open
      ? new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
      : (end as string),
    label: badge
      ? { kind: 'didNotWork', badge }
      : {
          kind: 'worked',
          projectId:
            typeof projectId === 'string' && projectId ? projectId : null,
        },
    ...(open ? { open: true as const } : {}),
    ...(isLocked === true ? { locked: true as const } : {}),
    ...(Array.isArray(customFieldValues) && customFieldValues.length
      ? { customFields: true as const }
      : {}),
  };
}
