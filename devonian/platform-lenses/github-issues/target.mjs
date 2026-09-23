/**
 * Which Atomic drive the GitHub issue tracker syncs into, and whether the
 * browser's local index of that drive can be trusted for enumeration.
 *
 * Two kinds of target are supported:
 * - `local-only`: a drive registered with `store.registerLocalOnlyDrive`. Its
 *   only copy is the browser WASM/OPFS database, so `queryLocalDb` is
 *   authoritative and saves are durable once they resolve.
 * - `synced`: any other drive, e.g. the user's real drive on AtomicServer. The
 *   local index is authoritative only after a drive sync has finished for it
 *   in this session (`store.hasCompletedDriveSyncFor`), and a save is durable
 *   only once AtomicServer acknowledged it (`store.getSaveState`).
 *
 * The kind is read from the store on every call, never persisted, because
 * `store.promoteLocalDrive` can turn a local-only tracker into a synced one.
 */
import { core, dataBrowser } from '@tomic/lib';

// Not exported by every published @tomic/lib version; the URLs are stable.
const commentsFolderProperty =
  dataBrowser.properties.commentsFolder ??
  'https://atomicdata.dev/properties/commentsFolder';
const jsonDatatype = 'https://atomicdata.dev/datatypes/json';

/** Classify a drive. A store without the needed predicates is never ready. */
export function atomicTarget(store, drive) {
  if (typeof drive !== 'string' || !drive)
    throw new Error('An Atomic drive is required');
  if (
    typeof store.isLocalOnlyDrive === 'function' &&
    store.isLocalOnlyDrive(drive)
  )
    return { drive, kind: 'local-only', ready: true };
  const ready =
    typeof store.hasCompletedDriveSyncFor === 'function' &&
    store.hasCompletedDriveSyncFor(drive) === true;
  return { drive, kind: 'synced', ready };
}

/** Throws unless the local index of `drive` is complete enough to enumerate. */
export function assertEnumerable(store, drive) {
  const target = atomicTarget(store, drive);
  if (!target.ready)
    throw new Error(`Atomic drive has not finished syncing: ${drive}`);
  return target;
}

/**
 * Throws unless `resource`'s last save is durable for `drive`'s kind.
 * `save()` returning 'offline' is reported as before ("AtomicServer
 * disconnected"). On a synced drive, a rejected commit is permanent (a person
 * must look) and anything short of acknowledged is transient.
 */
export function assertSaved(store, drive, resource, saveResult) {
  if (saveResult === 'offline') throw new Error('AtomicServer disconnected');
  if (atomicTarget(store, drive).kind === 'local-only') return;
  if (typeof store.getSaveState !== 'function')
    throw new Error(`Atomic write not acknowledged: ${resource.subject}`);
  const state = store.getSaveState(resource);
  if (state?.kind === 'error')
    throw new Error(
      `Atomic write rejected: ${resource.subject}: ${state.error ?? 'unknown error'}`,
    );
  if (state?.kind !== 'idle')
    throw new Error(`Atomic write not acknowledged: ${resource.subject}`);
}

/** IndexedDB key for one tracker. Includes the drive so drives never share state. */
export function trackerStateKey({ agent, drive, repository, mode }) {
  for (const [name, value] of Object.entries({
    agent,
    drive,
    repository,
    mode,
  }))
    if (typeof value !== 'string' || !value)
      throw new Error(`Tracker state key needs ${name}`);
  return `devonian-tracker:${JSON.stringify([agent, drive, repository, mode])}`;
}

/** Table layout the lens expects; handed to the host's table builder. */
export const trackerTableSpec = {
  name: 'Issue Tracker',
  rowName: 'Issue',
  columns: [
    { name: 'Description', type: 'markdown' },
    { name: 'Status', type: 'select', options: ['Todo', 'Doing', 'Done'] },
    { name: 'GitHub issue number', type: 'number' },
  ],
  views: [
    { name: 'Board', kind: 'kanban', groupByColumn: 'Status', default: true },
    { name: 'All issues', kind: 'table' },
  ],
};

/**
 * Create the tracker table, provenance property and (only when missing) the
 * drive's Comments folder inside an existing drive of either kind, and return
 * the config `AtomicPort` consumes.
 *
 * `buildTable(spec)` is supplied by the host (atomic-server's
 * `buildTableFromSpec`) and must resolve to `{ tableSubject, classSubject,
 * columns: { Description, Status, 'GitHub issue number' }, tags: { Status } }`.
 *
 * An existing `commentsFolder` on the drive is reused, never replaced: on the
 * user's real drive it holds their other comments.
 */
export async function provisionTracker(
  store,
  { drive, repository, buildTable },
) {
  if (typeof repository !== 'string' || !repository)
    throw new Error('A GitHub repository is required');
  if (typeof buildTable !== 'function')
    throw new Error('A host table builder is required');
  atomicTarget(store, drive);
  const driveResource = await store.getResource(drive);
  if (driveResource.error) throw driveResource.error;

  const table = await buildTable(trackerTableSpec);
  for (const column of ['Description', 'Status', 'GitHub issue number'])
    if (typeof table?.columns?.[column] !== 'string')
      throw new Error(`Table builder did not return the ${column} column`);
  const tags = table.tags?.Status;
  if (
    !tags ||
    !['Todo', 'Doing', 'Done'].every(s => typeof tags[s] === 'string')
  )
    throw new Error('Table builder did not return Todo/Doing/Done tags');

  const provenance = await store.newResource({
    parent: drive,
    isA: [core.classes.property],
    propVals: {
      [core.properties.name]: 'GitHub source',
      [core.properties.shortname]: 'github-source',
      [core.properties.description]:
        'Original author, identity and timestamps from GitHub.',
      [core.properties.datatype]: jsonDatatype,
    },
  });
  assertSaved(store, drive, provenance, await provenance.save());

  let commentsFolder = driveResource.get(commentsFolderProperty);
  if (typeof commentsFolder !== 'string' || !commentsFolder) {
    const folder = await store.newResource({
      parent: drive,
      isA: [dataBrowser.classes.folder],
      propVals: { [core.properties.name]: 'Comments' },
    });
    assertSaved(store, drive, folder, await folder.save());
    await driveResource.set(commentsFolderProperty, folder.subject);
    assertSaved(store, drive, driveResource, await driveResource.save());
    commentsFolder = folder.subject;
  }

  return {
    connection: {
      repository,
      drive,
      table: table.tableSubject,
      rowClass: table.classSubject,
      body: table.columns.Description,
      status: table.columns.Status,
      number: table.columns['GitHub issue number'],
      tags,
    },
    commentsFolder,
    provenance: provenance.subject,
  };
}
