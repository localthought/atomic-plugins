// @wc-ignore-file
import { fetchNamed, fetchTimeEntries } from './clockifyApi.js';
import type { ConnectionReference } from './config.js';
import { NAME, row, TIME_ENTRY_CLASS } from './ontology.js';
import { projectEntries, type ProjectedEntry } from './project.js';
import type { JSONValue, PluginStore } from './store.js';
import type { ProxyTransport } from './transport.js';

const PARENT = 'https://atomicdata.dev/properties/parent';

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Non-fatal: e.g. project names unavailable, so rows keep raw ids only. */
  warnings: string[];
}

export function rowValues(entry: ProjectedEntry): Record<string, JSONValue> {
  const values: Record<string, JSONValue> = {
    [NAME]: entry.name,
    [row.entryId]: entry.entryId,
    [row.start]: entry.start,
    [row.end]: entry.end,
  };
  if (entry.billable !== undefined) values[row.billable] = entry.billable;
  if (entry.projectId) values[row.projectId] = entry.projectId;
  if (entry.projectName) values[row.projectName] = entry.projectName;
  if (entry.memberId) values[row.memberId] = entry.memberId;
  if (entry.memberName) values[row.memberName] = entry.memberName;

  return values;
}

/**
 * Fetch the look-back window, project it through the Clockify lens, and
 * reconcile each entry into the app's data table by its Clockify id.
 *
 * Identity is a stored `entry-id` found with `store.query()`, not a
 * deterministic subject: app-write `create` never accepts a caller-chosen
 * subject. `query` is drive-scoped (hostStore.ts), so a match is also
 * required to be a child of `parent`; an entry id found elsewhere in the
 * drive (another installation) is not this app's row. Requests are sequential: with a host relay every
 * one is a parent-page round trip on a single-use code.
 *
 * Import only: nothing is written back to Clockify, and an entry that
 * disappears from Clockify is left in place (never an implicit deletion).
 */
export async function syncClockify(
  store: PluginStore,
  transport: ProxyTransport,
  reference: ConnectionReference,
  now = Date.now(),
): Promise<SyncResult> {
  const data = await store.getData();
  const parent = data?.table ?? (await store.getApp());
  const rowClass = data?.rowClass ?? TIME_ENTRY_CLASS;

  const entries = await fetchTimeEntries(
    transport,
    reference.workspaceId,
    reference.userId,
    reference.lookbackDays,
    now,
  );
  const projects = await fetchNamed(
    transport,
    reference.workspaceId,
    'projects',
  );
  const members = await fetchNamed(transport, reference.workspaceId, 'users');
  const warnings = [projects.warning, members.warning].filter(
    (w): w is string => !!w,
  );

  const result: SyncResult = { created: 0, updated: 0, unchanged: 0, warnings };
  // Membership by subject, from two queries, rather than by reading each
  // match's `parent`: it does not depend on resource reads returning
  // properties (see the README's "Host bugs found").
  const own = new Set(await store.query({ property: PARENT, value: parent }));

  for (const entry of projectEntries(entries, projects.items, members.items)) {
    const values = rowValues(entry);
    const matches = await store.query({
      property: row.entryId,
      value: entry.entryId,
    });
    const subject = matches.find(s => own.has(s));

    if (!subject) {
      const created = await store.newResource({
        parent,
        isA: [rowClass],
        propVals: values,
      });
      own.add(created.subject);
      result.created++;
      continue;
    }

    const existing = await store.getResource(subject);
    const changed = Object.entries(values).filter(
      ([property, value]) => existing.get(property) !== value,
    );

    if (!changed.length) {
      result.unchanged++;
      continue;
    }

    for (const [property, value] of changed) existing.set(property, value);
    await existing.save();
    result.updated++;
  }

  return result;
}
