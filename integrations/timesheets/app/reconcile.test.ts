// @wc-ignore-file
/**
 * #97: what a refresh does to a row edited in Atomic. Every write here goes
 * through the fake store, which applies the server's `validate_baseline`
 * (`hostRules.ts`), so a plan the host would refuse fails these tests too.
 */
import { describe, expect, it } from 'vitest';
import { USER, WORKSPACE } from '../fixtures/clockify/scenario.mjs';
import type { Settings } from './config.js';
import { fakeStore, IS_A, PARENT, TABLE } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { validateBaseline } from './hostRules.js';
import { atomic, NAME } from './ontology.js';
import {
  IMPORT_BASELINE,
  IMPORT_LOCAL_ID,
  planRow,
  same,
} from './reconcile.js';
import { ensureSchema } from './schema.js';
import { sourceId, syncClockify } from './sync.js';
import { relayTransport } from './transport.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const NOTE = 'did:ad:note';
const settings: Settings = {
  workspaceId: WORKSPACE.id,
  userId: USER.id,
  lookbackDays: 7,
};

async function setup(options: { pinnedRemove?: boolean } = {}) {
  const proxy = fixtureProxy(NOW);
  const store = fakeStore({ proxy: proxy.request, ...options });
  store.resources.set(NOTE, { [IS_A]: [atomic.propertyClass] });
  const schema = await ensureSchema(store);
  const transport = relayTransport(store.proxy!, {
    platform: 'clockify',
    connectionId: 'conn-1',
  });
  const run = () => syncClockify(store, transport, settings, schema, NOW);
  await run();
  const [subject] = await store.query({
    property: IMPORT_LOCAL_ID,
    value: sourceId('entry-1'),
  });
  const row = () => store.resources.get(subject)!;
  const clockify = proxy.fixture.state.entries[0];
  /** An edit in Atomic: an ordinary write, no baseline involved. */
  const edit = (values: Record<string, unknown>) =>
    Object.assign(row(), values);

  return { store, schema, transport, run, subject, row, clockify, edit };
}

describe('local edits when Clockify data is refreshed', () => {
  it('keeps a local edit while the source is unchanged, on every run', async () => {
    const { run, row, edit } = await setup();
    edit({ [NAME]: 'Renamed in Atomic' });

    expect(await run()).toMatchObject({ updated: 0, conflicts: [] });
    expect(await run()).toMatchObject({ updated: 0, conflicts: [] });
    expect(row()[NAME]).toBe('Renamed in Atomic');
  });

  it('takes a source change into a field nobody edited, next to a kept edit', async () => {
    const { schema, run, row, edit, clockify } = await setup();
    edit({ [NAME]: 'Renamed in Atomic' });
    clockify.billable = false;

    expect(await run()).toMatchObject({ updated: 1, conflicts: [] });
    expect(row()[NAME]).toBe('Renamed in Atomic');
    expect(row()[schema.row.billable]).toBe(false);
  });

  it('reports a field changed on both sides, keeps the local value, and keeps reporting it', async () => {
    const { subject, run, row, edit, clockify } = await setup();
    edit({ [NAME]: 'Renamed in Atomic' });
    clockify.description = 'Renamed in Clockify';

    const conflict = {
      subject,
      name: 'Renamed in Atomic',
      fields: ['Name'],
    };
    expect((await run()).conflicts).toEqual([conflict]);
    expect(row()[NAME]).toBe('Renamed in Atomic');
    // Still unresolved, so still reported; the baseline did not move.
    expect((await run()).conflicts).toEqual([conflict]);
    expect(row()[IMPORT_BASELINE]).toMatchObject({
      values: { [NAME]: 'Fix plugin source loading' },
    });

    // Making them equal in Atomic resolves it, and the baseline catches up.
    // Only the baseline is written, so it does not count as an update.
    edit({ [NAME]: 'Renamed in Clockify' });
    expect(await run()).toMatchObject({ updated: 0, conflicts: [] });
    expect(row()[IMPORT_BASELINE]).toMatchObject({
      values: { [NAME]: 'Renamed in Clockify' },
    });
  });

  it('removes a value cleared in Clockify when nobody edited it', async () => {
    const { schema, run, row, clockify } = await setup();
    expect(row()[schema.row.projectName]).toBe('Atomic plugins');
    clockify.projectId = null;

    expect(await run()).toMatchObject({ updated: 1, conflicts: [] });
    expect(row()[schema.row.projectId]).toBeUndefined();
    expect(row()[schema.row.projectName]).toBeUndefined();
    expect(await run()).toMatchObject({ updated: 0, unchanged: 2 });
  });

  it('at a host that cannot remove values for apps, says so and retries', async () => {
    const { schema, run, row, clockify } = await setup({ pinnedRemove: true });
    clockify.projectId = null;

    const first = await run();

    expect(first.warnings).toEqual([
      'Could not clear Clockify project id, Project of "Fix plugin source loading": this host does not remove values for apps yet',
    ]);
    expect(row()[schema.row.projectName]).toBe('Atomic plugins');
    // Not mistaken for a local edit next time: still a pending removal.
    expect((await run()).warnings).toHaveLength(1);
  });

  it('keeps a local edit of a value that Clockify cleared, and reports it', async () => {
    const { schema, run, row, edit, clockify } = await setup();
    edit({ [schema.row.projectName]: 'My own project name' });
    clockify.projectId = null;

    const result = await run();

    expect(result.conflicts[0].fields).toEqual(['Project']);
    expect(row()[schema.row.projectName]).toBe('My own project name');
    // The field nobody edited was still cleared.
    expect(row()[schema.row.projectId]).toBeUndefined();
  });

  it('never touches a column added in Atomic', async () => {
    const { run, row, edit, clockify } = await setup();
    edit({ [NOTE]: 'mine' });
    clockify.description = 'Renamed in Clockify';

    await run();

    expect(row()[NOTE]).toBe('mine');
  });

  it('converges after a write failed halfway through a sync', async () => {
    const { store, run, clockify } = await setup();
    const second = store.resources.get(
      (
        await store.query({
          property: IMPORT_LOCAL_ID,
          value: sourceId('entry-2'),
        })
      )[0],
    )!;
    clockify.description = 'Renamed in Clockify';
    store.failRowSaves(1);

    await expect(run()).rejects.toThrow('Simulated write failure');
    expect(await run()).toMatchObject({ updated: 1, conflicts: [] });
    expect(await run()).toMatchObject({ updated: 0, unchanged: 2 });
    expect(second[NAME]).toBe('Weekly sync');
  });

  it('adopts rows imported before baselines, and reports the ones that differ', async () => {
    const { store, schema, run, row, clockify } = await setup();

    // As #96 left them: no localId, no baseline, one edited in Atomic.
    for (const props of store.resources.values())
      if (props[PARENT] === TABLE) {
        delete props[IMPORT_LOCAL_ID];
        delete props[IMPORT_BASELINE];
      }

    row()[NAME] = 'Edited before the policy existed';
    clockify.billable = false;

    const result = await run();

    // Nothing to tell an edit from a change by: both differences are
    // reported, nothing is overwritten, the agreeing fields are adopted.
    expect(result.conflicts[0].fields.sort()).toEqual(['Billable', 'Name']);
    expect(row()[NAME]).toBe('Edited before the policy existed');
    expect(row()[schema.row.billable]).toBe(true);
    expect(row()[IMPORT_LOCAL_ID]).toBe(sourceId('entry-1'));
    expect(
      (row()[IMPORT_BASELINE] as { values: object }).values,
    ).not.toHaveProperty(NAME);
    expect(
      await store.query({
        property: IMPORT_LOCAL_ID,
        value: sourceId('entry-2'),
      }),
    ).toHaveLength(1);
  });

  it('keeps project names, and their baseline, when the projects list cannot be read', async () => {
    const { store, schema, transport, run, row } = await setup();
    const blind = {
      request: async (path: string, query?: Record<string, string>) =>
        path.endsWith('/projects')
          ? { status: 403, body: { message: 'Forbidden' } }
          : transport.request(path, query),
    };

    const result = await syncClockify(store, blind, settings, schema, NOW);

    expect(result.warnings).toHaveLength(1);
    expect(row()[schema.row.projectName]).toBe('Atomic plugins');
    expect(row()[IMPORT_BASELINE]).toMatchObject({
      values: { [schema.row.projectName]: 'Atomic plugins' },
    });
    expect(await run()).toMatchObject({ updated: 0, conflicts: [] });
  });
});

describe('planRow', () => {
  const P = 'p';

  it('always writes a fresh baseline whose previous is the stored one', () => {
    const plan = planRow({
      sourceId: 's',
      source: { [P]: 2 },
      managed: [P],
      row: {
        [P]: 1,
        [IMPORT_LOCAL_ID]: 's',
        [IMPORT_BASELINE]: { values: { [P]: 1 }, previous: {}, approval: 'x' },
      },
    });

    expect(plan).toEqual({
      op: 'update',
      set: {
        [P]: 2,
        [IMPORT_BASELINE]: { values: { [P]: 2 }, previous: { [P]: 1 } },
      },
      remove: [],
      changesValues: true,
      conflicts: [],
    });
  });

  it('treats null and missing as the same absence', () => {
    expect(same(null, undefined)).toBe(true);
    expect(same(0, undefined)).toBe(false);
    expect(same({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it('produces writes the server accepts, and the server refuses a stale one', () => {
    const base = { values: { [P]: 'a' }, previous: {} };
    const older = { [P]: 'a', [IMPORT_LOCAL_ID]: 's', [IMPORT_BASELINE]: base };
    const plan = planRow({
      sourceId: 's',
      source: { [P]: 'b' },
      managed: [P],
      row: older,
    });
    if (plan.op !== 'update') throw new Error('expected an update');
    expect(() =>
      validateBaseline(older, { ...older, ...plan.set }),
    ).not.toThrow();

    // The same plan against a row edited in the meantime: refused, so the
    // edit is not overwritten by a plan made from an older read.
    const edited = { ...older, [P]: 'edited' };
    expect(() => validateBaseline(edited, { ...edited, ...plan.set })).toThrow(
      /local edit/,
    );
    // Planned from the current row instead: the edit is kept and reported.
    expect(
      planRow({
        sourceId: 's',
        source: { [P]: 'b' },
        managed: [P],
        row: edited,
      }),
    ).toMatchObject({ op: 'unchanged', conflicts: [{ property: P }] });
  });
});
