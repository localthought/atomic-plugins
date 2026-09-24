// @wc-ignore-file
import { fetchNamed, fetchTimeEntries } from './clockifyApi.js';
import type { Settings } from './config.js';
import { atomic, NAME, type RowKey } from './ontology.js';
import { projectEntries, type ProjectedEntry } from './project.js';
import type { CompleteSchema } from './schema.js';
import type { JSONValue, PluginStore } from './store.js';
import type { ProxyTransport } from './transport.js';

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Non-fatal: e.g. project names unavailable, so rows keep raw ids only. */
  warnings: string[];
}

export function rowValues(
  entry: ProjectedEntry,
  row: Record<RowKey, string>,
): Record<string, JSONValue> {
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
 * reconcile each entry into the app's table by its Clockify id.
 *
 * Identity is a stored `clockify-entry-id` found with `store.query()`, not a
 * deterministic subject: app-write `create` never accepts a caller-chosen
 * subject. `query` is drive-scoped, so a match must also be a child of the
 * app's table; an entry id found elsewhere in the drive (another
 * installation) is not this app's row. Requests are sequential: each one is a
 * parent-page round trip on a single-use code.
 *
 * Import only: nothing is written back to Clockify, and an entry that
 * disappears from Clockify is left in place (never an implicit deletion).
 */
export async function syncClockify(
  store: PluginStore,
  transport: ProxyTransport,
  settings: Settings,
  schema: CompleteSchema,
  now = Date.now(),
): Promise<SyncResult> {
  const entries = await fetchTimeEntries(
    transport,
    settings.workspaceId,
    settings.userId,
    settings.lookbackDays,
    now,
  );
  const projects = await fetchNamed(
    transport,
    settings.workspaceId,
    'projects',
  );
  const members = await fetchNamed(transport, settings.workspaceId, 'users');
  const warnings = [projects.warning, members.warning].filter(
    (w): w is string => !!w,
  );

  const result: SyncResult = { created: 0, updated: 0, unchanged: 0, warnings };
  const own = new Set(
    await store.query({ property: atomic.parent, value: schema.table }),
  );

  for (const entry of projectEntries(entries, projects.items, members.items)) {
    const values = rowValues(entry, schema.row);
    const matches = await store.query({
      property: schema.row.entryId,
      value: entry.entryId,
    });
    const subject = matches.find(s => own.has(s));

    if (!subject) {
      const created = await store.newResource({
        parent: schema.table,
        isA: [schema.rowClass],
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
