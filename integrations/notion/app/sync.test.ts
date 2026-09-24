// @wc-ignore-file
import { readPlatform } from 'syncables/browser';
import { describe, expect, it } from 'vitest';
import { notionFieldShortname } from '../devonian/notion/index.js';
import { DATA_SOURCE, pages } from '../fixtures/notion/scenario.mjs';
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
import { atomic, NOTION_DOCUMENT, syncNotion } from './sync.js';
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

describe('syncNotion progress (N3)', () => {
  it('reports listing, then reading per query page, then writing and done', async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({ proxy });
    const events: unknown[] = [];
    await syncNotion(
      store,
      syncablesTransport(proxy, 'conn-1', upstream),
      undefined,
      { onProgress: e => events.push({ ...e }) },
    );
    // The fixture serves two pages per query page: 2, then 3.
    expect(events).toEqual([
      { dataSource: DATA_SOURCE, title: 'Roadmap', phase: 'listing', pages: 0 },
      { dataSource: DATA_SOURCE, title: 'Roadmap', phase: 'reading', pages: 2 },
      { dataSource: DATA_SOURCE, title: 'Roadmap', phase: 'reading', pages: 3 },
      { dataSource: DATA_SOURCE, title: 'Roadmap', phase: 'writing', pages: 3 },
      { dataSource: DATA_SOURCE, title: 'Roadmap', phase: 'done', pages: 3 },
    ]);
  });

  it('keeps the first data source’s rows when writing the second one throws', async () => {
    const proxy = fixtureProxy('conn-1', { scenario: 'two-sources' });
    const store = fakeStore({ proxy });
    const create = store.newResource.bind(store);
    store.newResource = async args => {
      if (args?.propVals?.[atomic.name] === 'Thinking in Systems')
        throw new Error('host refused the write');

      return create(args);
    };
    const events: { phase: string; title: string }[] = [];
    await expect(
      syncNotion(store, syncablesTransport(proxy, 'conn-1', upstream), undefined, {
        onProgress: e => events.push(e),
      }),
    ).rejects.toThrow(/refused/);
    const rows = [...store.resources.values()].filter(p => p[PARENT] === TABLE);
    expect(rows.map(r => r[atomic.name])).toEqual([
      'Launch plan',
      'Write changelog',
      'Retrospective',
    ]);
    expect(events.filter(e => e.phase === 'done').map(e => e.title)).toEqual([
      'Roadmap',
    ]);
  });
});

describe('syncNotion per data source (N6, N7, N10)', () => {
  it('reports each database’s schema in Notion order, with options and skipped types', async () => {
    const proxy = fixtureProxy('conn-1', { scenario: 'two-sources' });
    const store = fakeStore({ proxy });
    const result = await syncNotion(
      store,
      syncablesTransport(proxy, 'conn-1', upstream),
    );
    expect(result.dataSources).toBe(2);
    const [roadmap, reading] = result.perDataSource;
    expect(roadmap).toMatchObject({
      id: DATA_SOURCE,
      title: 'Roadmap',
      pages: 3,
      created: 3,
      formatted: [
        { page: pages[2]!.id, title: 'Retrospective', property: 'Notes' },
      ],
      archived: [],
    });
    expect(roadmap!.properties.map(p => p.name)).toEqual([
      'Name',
      'Status',
      'Done',
      'Points',
      'Tags',
      'Notes',
    ]);
    expect(roadmap!.properties[1]).toMatchObject({
      type: 'status',
      shortname: notionFieldShortname('%3AUPp'),
      options: [
        { name: 'Not started', color: 'default' },
        { name: 'In progress', color: 'blue' },
        { name: 'Done', color: 'green' },
      ],
    });
    expect(reading).toMatchObject({ title: 'Reading list', pages: 2, created: 2 });
    // Types the lens does not project are listed, without a column.
    expect(
      reading!.properties.filter(p => !p.shortname).map(p => [p.name, p.type]),
    ).toEqual([
      ['Recommended by', 'people'],
      ['Date read', 'date'],
    ]);
    // Two "Status" properties with different ids stay two columns.
    const statuses = result.perDataSource.map(
      r => r.properties.find(p => p.name === 'Status')!.shortname,
    );
    expect(new Set(statuses).size).toBe(2);
  });

  it('picks up a renamed option from the schema with no row writes', async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({ proxy });
    const transport = syncablesTransport(proxy, 'conn-1', upstream);
    await syncNotion(store, transport);
    const writes = store.writes.length;
    proxy.api.renameOption('b1f5a3c2-0001-4000-8000-000000000003', 'Shipped');
    const again = await syncNotion(store, transport);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(store.writes.length).toBe(writes);
    const status = again.perDataSource[0]!.properties.find(
      p => p.name === 'Status',
    )!;
    expect(status.options!.map(o => o.name)).toEqual([
      'Not started',
      'In progress',
      'Shipped',
    ]);
  });

  it('reports zero data sources when Notion shares none', async () => {
    const proxy = fixtureProxy('conn-1', { scenario: 'empty' });
    const result = await syncNotion(
      fakeStore({ proxy }),
      syncablesTransport(proxy, 'conn-1', upstream),
    );
    expect(result).toMatchObject({ dataSources: 0, created: 0, perDataSource: [] });
  });
});
