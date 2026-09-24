// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { PROJECT, USER, WORKSPACE } from '../fixtures/clockify/scenario.mjs';
import type { Settings } from './config.js';
import { fixtureProxy } from './fixtureProxy.js';
import {
  fakeStore,
  IS_A,
  ONTOLOGY,
  PARENT,
  ROW_CLASS,
  TABLE,
} from './fakeStore.js';
import { atomic, NAME } from './ontology.js';
import { ensureSchema, findSchema } from './schema.js';
import { syncClockify } from './sync.js';
import { relayTransport, type ProxyTransport } from './transport.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const CONNECTION = { platform: 'clockify', connectionId: 'conn-1' };
/** A column someone added in Atomic; the import does not know it. */
const NOTE = 'did:ad:note';

const settings: Settings = {
  workspaceId: WORKSPACE.id,
  userId: USER.id,
  lookbackDays: 7,
};

async function setup(options?: { withNames?: boolean }) {
  const proxy = fixtureProxy(NOW, options);
  const store = fakeStore({ proxy: proxy.request });
  const schema = await ensureSchema(store);
  const transport = relayTransport(store.proxy!, CONNECTION);
  const run = (at = NOW) =>
    syncClockify(store, transport, settings, schema, at);
  const rows = () =>
    [...store.resources.entries()].filter(([, r]) => r[PARENT] === TABLE);

  return { proxy, store, schema, transport, run, rows };
}

describe('ensureSchema', () => {
  it('creates typed Properties under the app ontology once, and lists the row fields as columns', async () => {
    const store = fakeStore();

    expect((await findSchema(store)).row).toEqual({});
    const schema = await ensureSchema(store);
    const writes = store.writes.length;
    expect(await ensureSchema(store)).toEqual(schema);
    expect(store.writes.length).toBe(writes);

    const property = (subject: string) => store.resources.get(subject)!;
    expect(property(schema.row.start)[atomic.datatype]).toBe(
      'https://atomicdata.dev/datatypes/timestamp',
    );
    expect(property(schema.row.billable)[atomic.datatype]).toBe(
      'https://atomicdata.dev/datatypes/boolean',
    );
    expect(property(schema.settings.lookbackDays)[atomic.datatype]).toBe(
      'https://atomicdata.dev/datatypes/integer',
    );
    expect(property(schema.row.start)[PARENT]).toBe(ONTOLOGY);
    expect(store.resources.get(ONTOLOGY)![atomic.properties]).toHaveLength(11);
    const recommends = store.resources.get(ROW_CLASS)![
      atomic.recommends
    ] as string[];
    expect(recommends).toEqual([NAME, ...Object.values(schema.row)]);
    // Settings are stored on the App, not shown as table columns.
    expect(recommends).not.toContain(schema.settings.workspaceId);
    expect(await findSchema(store)).toEqual(schema);
  });

  it('refuses a same-named field with another datatype', async () => {
    const store = fakeStore();
    store.resources.set('did:ad:odd', {
      [PARENT]: ONTOLOGY,
      [IS_A]: [atomic.propertyClass],
      [atomic.shortname]: 'start',
      [atomic.datatype]: 'https://atomicdata.dev/datatypes/string',
    });
    store.resources.get(ONTOLOGY)![atomic.properties] = ['did:ad:odd'];

    await expect(ensureSchema(store)).rejects.toThrow(
      /"Start" already exists with another datatype/,
    );
  });

  it('needs a table with a row class', async () => {
    await expect(ensureSchema(fakeStore({ withTable: false }))).rejects.toThrow(
      /no table/,
    );
  });
});

describe('syncClockify against the shared Clockify mock', () => {
  it('imports completed entries in the window, skipping running timers and breaks', async () => {
    const { proxy, schema, run, rows } = await setup();

    const result = await run();

    expect(result).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
      warnings: [],
    });
    expect(rows().map(([, r]) => r[schema.row.entryId])).toEqual([
      'entry-1',
      'entry-2',
    ]);
    const first = rows().find(
      ([, r]) => r[schema.row.entryId] === 'entry-1',
    )![1];
    expect(first[NAME]).toBe('Fix plugin source loading');
    expect(first[IS_A]).toEqual([ROW_CLASS]);
    expect(first[schema.row.start]).toBe(NOW - 86_400_000 - 4 * 3_600_000);
    expect(first[schema.row.end]).toBe(NOW - 86_400_000 - 2 * 3_600_000);
    expect(first[schema.row.projectId]).toBe(PROJECT.id);
    expect(first[schema.row.projectName]).toBe(PROJECT.name);
    expect(first[schema.row.memberName]).toBe(USER.name);
    expect(first[schema.row.billable]).toBe(true);
    // Every call carried the reference, and the 7-day window as the
    // LocalThought path computes it.
    expect(
      proxy.seen.every(
        r => r.connectionId === 'conn-1' && r.platform === 'clockify',
      ),
    ).toBe(true);
    expect(proxy.fixture.state.requests[0]).toBe(
      `GET /proxy/clockify/api/v1/workspaces/${WORKSPACE.id}/user/${USER.id}/time-entries` +
        '?start=2026-09-16T12%3A00%3A00Z&end=2026-09-23T12%3A00%3A00Z&page=1&page-size=50',
    );
  });

  it('keeps raw ids and warns when project and user names are unavailable', async () => {
    const { schema, run, rows } = await setup({ withNames: false });

    const result = await run();

    expect(result.warnings).toHaveLength(2);
    const [, first] = rows()[0];
    expect(first[schema.row.projectId]).toBe(PROJECT.id);
    expect(first[schema.row.projectName]).toBeUndefined();
  });

  it('is idempotent: a second run creates nothing and rewrites nothing', async () => {
    const { store, run } = await setup();
    await run();
    const writes = store.writes.length;

    const again = await run();

    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(store.writes.length).toBe(writes);
  });

  it('rolls the look-back window forward with the clock', async () => {
    const { proxy, run } = await setup();
    await run(NOW);
    await run(NOW + 86_400_000);

    const starts = proxy.fixture.state.requests
      .filter(r => r.includes('/time-entries'))
      .map(r => new URL(r.slice(4), 'http://x').searchParams.get('start'));
    expect(starts).toEqual(['2026-09-16T12:00:00Z', '2026-09-17T12:00:00Z']);
  });

  it('updates a changed entry in place and keeps a property the import does not map', async () => {
    const { store, schema, proxy, run } = await setup();
    await run();
    const [subject] = await store.query({
      property: schema.row.entryId,
      value: 'entry-1',
    });
    store.resources.set(NOTE, { [IS_A]: [atomic.propertyClass] });
    store.resources.get(subject)![NOTE] = 'mine';
    proxy.fixture.state.entries[0].description = 'Renamed in Clockify';

    const result = await run();

    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(store.resources.get(subject)![NAME]).toBe('Renamed in Clockify');
    expect(store.resources.get(subject)![NOTE]).toBe('mine');
  });

  it("does not adopt another installation's row with the same Clockify id", async () => {
    const { store, schema, run } = await setup();
    store.resources.set('did:ad:elsewhere', {
      [PARENT]: 'did:ad:other-table',
      [schema.row.entryId]: 'entry-1',
    });

    const result = await run();

    expect(result.created).toBe(2);
    expect(store.resources.get('did:ad:elsewhere')).toEqual({
      [PARENT]: 'did:ad:other-table',
      [schema.row.entryId]: 'entry-1',
    });
  });

  it('surfaces a failing time-entries request and writes nothing', async () => {
    const { store, schema } = await setup();
    const writes = store.writes.length;
    const transport: ProxyTransport = {
      request: async () => ({
        status: 401,
        body: { message: 'Reconnect Clockify' },
      }),
    };

    await expect(
      syncClockify(store, transport, settings, schema, NOW),
    ).rejects.toThrow(/failed with 401: Reconnect Clockify/);
    expect(store.writes.length).toBe(writes);
  });

  it('keeps existing rows readable through a proxy failure and recovers on the next run', async () => {
    const { proxy, rows, run } = await setup();
    await run();
    const before = rows();
    proxy.fixture.state.failures = { count: 1, status: 503 };

    await expect(run()).rejects.toThrow(/failed with 503/);
    expect(rows()).toEqual(before);

    expect(await run()).toMatchObject({ created: 0, unchanged: 2 });
  });

  it('pages until a short page', async () => {
    const { store, schema } = await setup();
    const entry = (i: number) => ({
      id: `e${i}`,
      description: `Entry ${i}`,
      type: 'REGULAR',
      timeInterval: {
        start: new Date(NOW - 3_600_000 - i * 1000).toISOString(),
        end: new Date(NOW - i * 1000).toISOString(),
      },
    });
    const pages: string[] = [];
    const transport: ProxyTransport = {
      async request(path, query) {
        if (!path.endsWith('/time-entries')) return { status: 404, body: {} };
        pages.push(query!.page);
        const page = Number(query!.page);
        const count = page === 1 ? 50 : 3;

        return {
          status: 200,
          body: Array.from({ length: count }, (_, i) =>
            entry((page - 1) * 50 + i),
          ),
        };
      },
    };

    const result = await syncClockify(store, transport, settings, schema, NOW);

    expect(pages).toEqual(['1', '2']);
    expect(result.created).toBe(53);
  });
});
