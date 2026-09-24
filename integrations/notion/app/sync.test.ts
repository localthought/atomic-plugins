// @wc-ignore-file
import { readPlatform } from 'syncables/browser';
import { describe, expect, it } from 'vitest';
import { notionFieldShortname } from '../devonian/notion/index.js';
import { DATA_SOURCE, pages } from '../fixtures/notion/scenario.mjs';
import { createController, describe as describeState } from './controller.js';
import {
  APP,
  fakeStore,
  fixtureProxy,
  IS_A,
  ONTOLOGY,
  PARENT,
  ROW_CLASS,
  TABLE,
} from './fakeStore.js';
import { IMPORT_BASELINE, IMPORT_LOCAL_ID } from './reconcile.js';
import { atomic, NOTION_DOCUMENT, sourceId, syncNotion } from './sync.js';
import { syncablesTransport } from './transport.js';

const upstream = new URL('https://api.notion.com/v1');

describe('syncablesTransport', () => {
  it('sends the provider path, method and JSON body to the relay', async () => {
    const proxy = fixtureProxy();
    const transport = syncablesTransport(proxy, 'conn-1', upstream);
    const response = await transport({
      url: new URL(
        `https://api.notion.com/v1/data_sources/${DATA_SOURCE}/query`,
      ),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"page_size":100}',
    });
    expect(proxy.calls).toEqual([
      {
        platform: 'notion',
        connectionId: 'conn-1',
        path: `/v1/data_sources/${DATA_SOURCE}/query`,
        method: 'POST',
        body: '{"page_size":100}',
      },
    ]);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).results).toHaveLength(2);
  });

  it('refuses URLs outside the catalog server before reaching the relay', async () => {
    const proxy = fixtureProxy();
    const transport = syncablesTransport(proxy, 'conn-1', upstream);
    for (const url of [
      'https://api.notion.com/v2/search',
      'https://evil.example/v1/search',
      'https://user@api.notion.com/v1/search',
    ])
      await expect(
        transport({ url: new URL(url), method: 'GET', headers: {} }),
      ).rejects.toThrow(/outside/);
    expect(proxy.calls).toEqual([]);
  });
});

describe('syncNotion', () => {
  const run = async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({ proxy });
    const transport = syncablesTransport(proxy, 'conn-1', upstream);

    return {
      store,
      proxy,
      transport,
      result: await syncNotion(store, transport),
    };
  };

  it('pages through the query with the cursor in the POST body', async () => {
    const { proxy } = await run();
    expect(proxy.calls.map(c => [c.method, c.path])).toEqual([
      ['POST', '/v1/search'],
      ['POST', `/v1/data_sources/${DATA_SOURCE}/query`],
      ['POST', `/v1/data_sources/${DATA_SOURCE}/query`],
    ]);
    expect(JSON.parse(proxy.calls[0]!.body!)).toMatchObject({
      filter: { property: 'object', value: 'data_source' },
    });
    expect(JSON.parse(proxy.calls[1]!.body!)).not.toHaveProperty(
      'start_cursor',
    );
    expect(JSON.parse(proxy.calls[2]!.body!)).toMatchObject({
      start_cursor: 'cursor-2',
    });
  });

  it('creates one row per page, named by title, with lens values in named columns', async () => {
    const { store, result } = await run();
    expect(result).toMatchObject({
      created: 3,
      updated: 0,
      unchanged: 0,
      dataSources: 1,
    });
    expect(result.warnings).toEqual([
      `Notion page ${pages[2]!.id} property "Notes" (rich_text) has no lossless plain value; left unprojected`,
    ]);

    const byShortname = new Map<string, string>();
    for (const [subject, props] of store.resources)
      if (
        props[PARENT] === ONTOLOGY &&
        (props[IS_A] as string[] | undefined)?.includes(atomic.propertyClass)
      )
        byShortname.set(String(props[atomic.shortname]), subject);
    const column = (id: string) => byShortname.get(notionFieldShortname(id))!;
    expect(store.resources.get(column('BJXS'))).toMatchObject({
      [atomic.name]: 'Done',
      [atomic.datatype]: 'https://atomicdata.dev/datatypes/boolean',
      [IS_A]: [atomic.propertyClass],
    });
    expect(store.resources.get(ONTOLOGY)![atomic.properties]).toEqual([
      ...byShortname.values(),
    ]);
    expect(store.resources.get(ROW_CLASS)![atomic.recommends]).toEqual([
      ...byShortname.values(),
    ]);

    const rows = [...store.resources.values()].filter(p => p[PARENT] === TABLE);
    expect(rows.map(r => r[atomic.name])).toEqual([
      'Launch plan',
      'Write changelog',
      'Retrospective',
    ]);
    expect(rows[0]).toMatchObject({
      [IS_A]: [ROW_CLASS],
      [byShortname.get('notion-page-id')!]: pages[0]!.id,
      [byShortname.get('notion-data-source')!]: 'Roadmap',
      [column('n%3D1')]: 3,
      [column('BJXS')]: false,
    });
    expect(rows[1]![column('n%3D1')]).toBe(0);
    expect(rows[2]).not.toHaveProperty(column('Nt0s'));
    expect(rows[2]).not.toHaveProperty(column('n%3D1'));
    expect(typeof rows[0]![byShortname.get('notion-last-edited')!]).toBe(
      'number',
    );
    // Nothing is written outside the app's own subtree.
    for (const { subject } of store.writes)
      expect([ONTOLOGY, ROW_CLASS, TABLE, APP]).toContain(
        store.resources.get(subject)![PARENT] ?? subject,
      );
  });

  it('is idempotent: a second import changes nothing', async () => {
    const { store, transport } = await run();
    const writes = store.writes.length;
    const again = await syncNotion(store, transport);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(store.writes.length).toBe(writes);
  });

  it('removes a value cleared in Notion and keeps one the lens cannot read', async () => {
    const { store, transport } = await run();
    const points = [...store.resources].find(
      ([, p]) => p[atomic.shortname] === notionFieldShortname('n%3D1'),
    )![0];
    const notes = [...store.resources].find(
      ([, p]) => p[atomic.shortname] === notionFieldShortname('Nt0s'),
    )![0];
    const row = (name: string) =>
      [...store.resources.values()].find(
        p => p[PARENT] === TABLE && p[atomic.name] === name,
      )!;
    // A person's earlier plain Notes on the formatted page stay put.
    const retro = [...store.resources].find(
      ([, p]) => p[PARENT] === TABLE && p[atomic.name] === 'Retrospective',
    )!;
    retro[1][notes] = 'Written in Atomic';

    // Next read: Points cleared on "Launch plan".
    const cleared: typeof readPlatform = async (doc, options) => {
      const result = await readPlatform(doc, options);

      for (const record of result.records)
        if (record.id === pages[0]!.id) {
          const values = structuredClone(record.values) as {
            properties: Record<string, Record<string, unknown>>;
          };
          values.properties.Points!.number = null;
          record.values = values as typeof record.values;
        }

      return result;
    };

    const again = await syncNotion(store, transport, cleared);
    expect(again).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    expect(row('Launch plan')).not.toHaveProperty(points);
    expect(row('Retrospective')[notes]).toBe('Written in Atomic');
  });

  it('only ever reads: every relayed request is a POST list', async () => {
    const { proxy } = await run();
    expect(new Set(proxy.calls.map(c => c.method))).toEqual(new Set(['POST']));
    expect(NOTION_DOCUMENT).toBeTruthy();
  });
});

describe('local edits when Notion data is refreshed (#97)', () => {
  type Page = { properties: Record<string, Record<string, unknown>> };

  /** A read in which Notion changed the first page. */
  const changed =
    (mutate: (page: Page) => void): typeof readPlatform =>
    async (doc, options) => {
      const result = await readPlatform(doc, options);

      for (const record of result.records)
        if (record.id === pages[0]!.id) {
          const values = structuredClone(record.values) as unknown as Page;
          mutate(values);
          record.values = values as unknown as typeof record.values;
        }

      return result;
    };

  const setup = async (options: { pinnedRemove?: boolean } = {}) => {
    const proxy = fixtureProxy();
    const store = fakeStore({ proxy, ...options });
    const transport = syncablesTransport(proxy, 'conn-1', upstream);
    await syncNotion(store, transport);
    const column = (id: string) =>
      [...store.resources].find(
        ([, p]) => p[atomic.shortname] === notionFieldShortname(id),
      )![0];
    const subject = (
      await store.query({
        property: IMPORT_LOCAL_ID,
        value: sourceId(pages[0]!.id),
      })
    )[0]!;
    const row = () => store.resources.get(subject)!;

    return { store, transport, column, subject, row };
  };

  it('keeps an edit made in Atomic while Notion is unchanged', async () => {
    const { store, transport, column, row } = await setup();
    row()[column('n%3D1')] = 5;

    const again = await syncNotion(store, transport);

    expect(again).toMatchObject({ updated: 0, conflicts: [] });
    expect(row()[column('n%3D1')]).toBe(5);
  });

  it('follows Notion where nobody edited, and reports what both changed', async () => {
    const { store, transport, column, subject, row } = await setup();
    row()[column('n%3D1')] = 5;
    const read = changed(page => {
      page.properties.Points!.number = 8;
      page.properties.Done!.checkbox = true;
    });

    const again = await syncNotion(store, transport, read);

    expect(again.conflicts).toEqual([
      { subject, name: 'Launch plan', fields: ['Points'] },
    ]);
    expect(row()[column('n%3D1')]).toBe(5);
    expect(row()[column('BJXS')]).toBe(true);
    // Reported again next time, not silently resolved.
    expect((await syncNotion(store, transport, read)).conflicts).toHaveLength(
      1,
    );
  });

  it('keeps an edited value that Notion cleared, and reports it', async () => {
    const { store, transport, column, row } = await setup();
    row()[column('n%3D1')] = 5;
    const again = await syncNotion(
      store,
      transport,
      changed(page => {
        page.properties.Points!.number = null;
      }),
    );

    expect(again.conflicts[0]!.fields).toEqual(['Points']);
    expect(row()[column('n%3D1')]).toBe(5);
  });

  it('says so where the host cannot remove a cleared value, and retries', async () => {
    const { store, transport, column, row } = await setup({
      pinnedRemove: true,
    });
    const read = changed(page => {
      page.properties.Points!.number = null;
    });

    const again = await syncNotion(store, transport, read);

    expect(again.warnings.at(-1)).toBe(
      'Could not clear Points of "Launch plan": this host does not remove values for apps yet',
    );
    expect(row()[column('n%3D1')]).toBe(3);
    expect((await syncNotion(store, transport, read)).conflicts).toEqual([]);
  });

  it('never touches a column added in Atomic', async () => {
    const { store, transport, row } = await setup();
    row()['atomic:my-column'] = 'mine';

    await syncNotion(
      store,
      transport,
      changed(page => {
        page.properties.Done!.checkbox = true;
      }),
    );

    expect(row()['atomic:my-column']).toBe('mine');
  });

  it('adopts rows imported before baselines by page id, without duplicates', async () => {
    const { store, transport, row } = await setup();

    for (const props of store.resources.values())
      if (props[PARENT] === TABLE) {
        delete props[IMPORT_LOCAL_ID];
        delete props[IMPORT_BASELINE];
      }

    row()[atomic.name] = 'Edited before the policy existed';

    const again = await syncNotion(store, transport);

    expect(again).toMatchObject({ created: 0 });
    expect(again.conflicts[0]!.fields).toEqual(['Name']);
    expect(row()[atomic.name]).toBe('Edited before the policy existed');
    expect(row()[IMPORT_LOCAL_ID]).toBe(sourceId(pages[0]!.id));
  });
});

describe('controller', () => {
  it('reports a host without the relay and fetches nothing', async () => {
    const controller = createController(fakeStore());
    expect((await controller.load()).kind).toBe('no-proxy');
    expect(describeState(controller.state())).toMatch(/cannot reach/);
  });

  it('finds the connection, imports, and reports the counts', async () => {
    const proxy = fixtureProxy();
    const controller = createController(
      fakeStore({ proxy }),
      () => {},
      () => 0,
    );
    expect(await controller.load()).toEqual({
      kind: 'ready',
      connectionId: 'conn-1',
    });
    const state = await controller.sync();
    expect(state).toMatchObject({ kind: 'ready', last: { ok: true } });
    expect(describeState(state)).toMatch(
      /3 created, 0 updated, 0 unchanged, from 1 database\./,
    );
  });

  it('asks to connect when there is no connection', async () => {
    const proxy = { ...fixtureProxy(), connections: async () => [] };
    const controller = createController(fakeStore({ proxy }));
    expect((await controller.load()).kind).toBe('not-connected');
    expect((await controller.connect()).kind).toBe('not-connected');
  });
});
