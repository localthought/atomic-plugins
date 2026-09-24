// @wc-ignore-file
import { fetchNamed, fetchTimeEntries } from './clockifyApi.js';
import type { Settings } from './config.js';
import { atomic, NAME, ROW_FIELDS, type RowKey } from './ontology.js';
import { projectEntries, type ProjectedEntry } from './project.js';
import type { CompleteSchema } from './schema.js';
import type { JSONValue, PluginStore } from './store.js';
import { IMPORT_LOCAL_ID, planRow } from './reconcile.js';
import type { ProxyTransport } from './transport.js';

/** A row whose Atomic value was kept although Clockify has another one. */
export interface RowConflict {
  subject: string;
  name: string;
  /** Display names of the fields, e.g. `Project`. */
  fields: string[];
}

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Rows with local edits that differ from Clockify; the edits were kept. */
  conflicts: RowConflict[];
  /** Non-fatal: e.g. project names unavailable, so rows keep raw ids only. */
  warnings: string[];
}

/** The row's source identity in the host's import metadata (`localId`). */
export const sourceId = (entryId: string) => `clockify-time-entry:${entryId}`;

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
 * reconcile each entry into the app's table.
 *
 * Identity is the host's import identity, `localId` =
 * `clockify-time-entry:<id>`, found with `store.query()` and required to be
 * a child of the app's table (another installation's row with the same id is
 * not this app's). The server keeps `(parent, localId)` unique. Rows imported
 * before `localId` was written are matched by `clockify-entry-id` and adopted.
 * Requests are sequential: each one is a parent-page round trip.
 *
 * What a sync may change in an existing row is `reconcile.ts`'s policy:
 * local edits are kept, only fields nobody edited follow Clockify, and a
 * field changed on both sides is reported in `conflicts`.
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

  const result: SyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    conflicts: [],
    warnings,
  };
  const own = new Set(
    await store.query({ property: atomic.parent, value: schema.table }),
  );
  // A field this run could not read is unknown, not cleared: without the
  // projects or users list, names are left as they are rather than removed.
  const unknown = new Set([
    ...(projects.warning ? [schema.row.projectName] : []),
    ...(members.warning ? [schema.row.memberName] : []),
  ]);
  const managed = [NAME, ...Object.values(schema.row)].filter(
    p => !unknown.has(p),
  );
  const fieldName = new Map<string, string>([
    [NAME, 'Name'],
    ...(Object.keys(ROW_FIELDS) as RowKey[]).map(
      key => [schema.row[key], ROW_FIELDS[key].name] as const,
    ),
  ]);
  const find = async (property: string, value: string) =>
    (await store.query({ property, value })).find(s => own.has(s));

  for (const entry of projectEntries(entries, projects.items, members.items)) {
    const id = sourceId(entry.entryId);
    const subject =
      (await find(IMPORT_LOCAL_ID, id)) ??
      (await find(schema.row.entryId, entry.entryId));
    const existing = subject ? await store.getResource(subject) : undefined;
    const plan = planRow({
      sourceId: id,
      source: rowValues(entry, schema.row),
      managed,
      row: existing?.props,
    });

    if (plan.op === 'create') {
      const created = await store.newResource({
        parent: schema.table,
        isA: [schema.rowClass],
        propVals: plan.set,
      });
      own.add(created.subject);
      result.created++;
      continue;
    }

    if (plan.conflicts.length)
      result.conflicts.push({
        subject: existing!.subject,
        name: String(existing!.get(NAME) ?? entry.name),
        fields: plan.conflicts.map(
          c => fieldName.get(c.property) ?? c.property,
        ),
      });

    if (plan.op === 'unchanged') {
      result.unchanged++;
      continue;
    }

    for (const property of plan.remove) existing!.remove(property);
    for (const [property, value] of Object.entries(plan.set))
      existing!.set(property, value);
    await existing!.save();
    if (plan.changesValues) result.updated++;
    else result.unchanged++;

    if (plan.remove.length) {
      // A host without removal for apps keeps the value; say so rather than
      // report a clear that did not happen. The next run retries.
      const after = await store.getResource(existing!.subject);
      const kept = plan.remove.filter(p => after.get(p) !== undefined);
      if (kept.length)
        warnings.push(
          `Could not clear ${kept.map(p => fieldName.get(p) ?? p).join(', ')} of "${entry.name}": this host does not remove values for apps yet`,
        );
    }
  }

  return result;
}
