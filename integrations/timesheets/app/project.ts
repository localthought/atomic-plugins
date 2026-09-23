// @wc-ignore-file
import {
  CLOCKIFY_PLATFORM,
  clockifyFields,
  clockifyProjection,
  resolveClockifyReferences,
  type FetchedPlatform,
  type FetchedRecord,
  type Term,
} from '../localthought.js';
import type { RawNamed, RawTimeEntry } from './clockifyApi.js';

/**
 * Runs the one Clockify lens (`../devonian/clockify/`, via
 * `../localthought.ts`) over records fetched by this app, instead of
 * re-implementing it as the Phase 2 branch did. The lens reads the
 * lower-cased field names the generic engine produces (`timeinterval`,
 * `projectid`, `userid`), so raw provider keys are lower-cased here first.
 */

export interface ProjectedEntry {
  entryId: string;
  name: string;
  /** Epoch milliseconds, as the lens produces them. */
  start: number;
  end: number;
  billable?: boolean;
  projectId?: string;
  projectName?: string;
  memberId?: string;
  memberName?: string;
}

const lowerKeys = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key.toLowerCase(), v]),
  ) as FetchedRecord['values'];

const record = (
  resource: string,
  id: string,
  name: string,
  raw: Record<string, unknown>,
): FetchedRecord => ({
  resource,
  namespace: CLOCKIFY_PLATFORM,
  id,
  name,
  values: lowerKeys(raw),
});

/** The lens only reads a class term's `kind` and `shortname`. */
const classTerm = (shortname: string): Term => ({
  path: `urn:atomic:clockify:${shortname}`,
  kind: 'class',
  shortname,
  description: `Clockify ${shortname}`,
  datatype:
    'https://atomicdata.dev/datatypes/resourceArray' as Term['datatype'],
  requires: [],
  recommends: [],
});

export function toFetchedPlatform(
  entries: RawTimeEntry[],
  projects: RawNamed[],
  members: RawNamed[],
): FetchedPlatform {
  return {
    platform: CLOCKIFY_PLATFORM,
    ontology: {
      description: 'Clockify, fetched by the timesheets drive app',
      terms: ['timeentry', 'project', 'member'].map(classTerm),
    },
    records: [
      ...entries.map(e => record('timeentry', e.id, '', e)),
      ...projects.map(p => record('project', p.id, p.name, p)),
      ...members.map(m => record('member', m.id, m.name, m)),
    ],
  };
}

const str = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined;

export function projectEntries(
  entries: RawTimeEntry[],
  projects: RawNamed[],
  members: RawNamed[],
): ProjectedEntry[] {
  const projected = clockifyProjection(
    toFetchedPlatform(entries, projects, members),
  );
  const references = new Map(
    resolveClockifyReferences(projected).map(r => [r.timeEntryId, r]),
  );

  return projected.records
    .filter(r => r.resource === 'timeentry')
    .map(r => {
      const ref = references.get(r.id);
      const billable = r.values.billable;

      return {
        entryId: r.id,
        name: r.name,
        start: r.values[clockifyFields.start] as number,
        end: r.values[clockifyFields.end] as number,
        ...(typeof billable === 'boolean' ? { billable } : {}),
        ...(ref?.projectId ? { projectId: ref.projectId } : {}),
        ...(str(ref?.project?.name) ? { projectName: ref!.project!.name } : {}),
        ...(ref?.userId ? { memberId: ref.userId } : {}),
        ...(str(ref?.member?.name) ? { memberName: ref!.member!.name } : {}),
      };
    });
}
