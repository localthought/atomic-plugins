// @wc-ignore-file
/**
 * Builds the views' `Timesheet` from the M1 observation log's mirror (#123):
 * the entries as Clockify last showed them, never the table's rows (those
 * are a read-only projection that a sync overwrites).
 *
 * Which entries count follows the one Clockify lens (`../project.ts`, via
 * `../../localthought.ts`): completed `REGULAR` entries. Running timers and
 * breaks are counted, not listed. A confirmed deletion is dropped; an
 * absence candidate (probably deleted, not confirmed) is kept, and its span
 * is `unknown` (M1's `unknownIntervals`).
 *
 * M2 hooks: `unknown` and `conflicts` come from the timeline sweep
 * (`../timeline/sweep.ts`, #123 M2) over `timeZone`; `../ui/coverage.ts`
 * renders them.
 */
import type { RawNamed } from '../clockifyApi.js';
import {
  rawFromCanonical,
  timeEntries,
  TIME_ENTRY,
} from '../clockifyObserve.js';
import type { Settings } from '../config.js';
import {
  coverageKey,
  ms,
  type Mirror,
  type MirrorRecord,
} from '../observations.js';
import { projectEntries } from '../project.js';
import { buildTimeline } from '../timeline/sweep.js';
import { weekStartOf } from './time.js';
import type { Project, Timesheet, TimeEntry } from './types.js';

const DAY = 86_400_000;

export interface SourceInput {
  mirror: Mirror;
  /** Clockify's project list (with `color`, `clientName`), if read. */
  projects?: RawNamed[];
  members?: RawNamed[];
  /** Absent before setup: then every entry in the mirror is shown. */
  settings?: Settings;
  now: number;
  timeZone: string;
  /** Clockify's `settings.weekStart`; Monday when unknown. */
  weekStart?: string;
  /** The workspace's `forceProjects` (M2: `worked(none)` is read-only). */
  forceProjects?: boolean;
}

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export function projectOf(
  id: string | undefined,
  projects: RawNamed[],
): Project | undefined {
  if (!id) return undefined;
  const found = projects.find(p => p.id === id);
  const name = text(found?.name);
  const color = text(found?.color);
  const client = text(found?.clientName);

  return {
    id,
    ...(name ? { name } : {}),
    ...(color && /^#[0-9a-f]{3,8}$/i.test(color) ? { color } : {}),
    ...(client ? { client } : {}),
  };
}

const mine = (record: MirrorRecord, settings?: Settings) =>
  !settings ||
  ((record.fields.workspaceId ?? settings.workspaceId) ===
    settings.workspaceId &&
    (record.fields.userId ?? settings.userId) === settings.userId);

export function timesheetFromMirror(input: SourceInput): Timesheet {
  const { mirror, settings, now, timeZone } = input;
  const projects = input.projects ?? [];
  const members = input.members ?? [];
  const window = settings
    ? { from: now - settings.lookbackDays * DAY, to: now }
    : undefined;
  const records = timeEntries(mirror).filter(
    r => !r.deletedAt && mine(r, settings),
  );
  const byId = new Map(records.map(r => [r.id, r]));

  const inWindow = (r: MirrorRecord) => {
    const start = r.fields.start;
    if (typeof start !== 'string') return false;

    return !window || (ms(start) >= window.from && ms(start) < window.to);
  };

  let running = 0;
  let breaks = 0;

  for (const r of records) {
    if (r.fields.type === 'BREAK') {
      if (inWindow(r)) breaks++;
    } else if (r.fields.start && !r.fields.end) running++;
  }

  const entries: TimeEntry[] = projectEntries(
    records.map(rawFromCanonical),
    projects,
    members,
  )
    .filter(p => Number.isFinite(p.start) && Number.isFinite(p.end))
    .map(p => {
      const fields = byId.get(p.entryId)?.fields ?? {};
      const project = projectOf(text(fields.projectId), projects);

      return {
        id: p.entryId,
        description: text(fields.description) ?? '',
        start: p.start,
        end: p.end,
        billable: fields.billable === true,
        ...(project ? { project } : {}),
        ...(p.memberName ? { member: p.memberName } : {}),
      };
    });

  const key = settings
    ? coverageKey({
        type: 'range',
        collection: TIME_ENTRY,
        params: {
          workspaceId: settings.workspaceId,
          userId: settings.userId,
        },
        field: 'start',
        from: '',
        to: '',
      })
    : undefined;
  const confirmations = mirror.coverage
    .filter(c => !key || c.key === key)
    .map(c => c.confirmedAt)
    .sort((a, b) => ms(a) - ms(b));
  const lastChecked = confirmations.at(-1);
  const timeline =
    settings && window
      ? buildTimeline({
          mirror,
          settings,
          window,
          now,
          timeZone,
          forceProjects: input.forceProjects,
        })
      : undefined;

  return {
    entries,
    running,
    breaks,
    ...(window ? { window } : {}),
    ...(lastChecked ? { lastChecked } : {}),
    weekStart: weekStartOf(input.weekStart),
    timeZone,
    // M2: both from the timeline sweep (`../timeline/sweep.ts`).
    ...(timeline
      ? { unknown: timeline.unknown, conflicts: timeline.conflicts }
      : { unknown: [], conflicts: [] }),
  };
}
