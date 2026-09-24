// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { notionFieldShortname } from '../devonian/notion/index.js';
import { fakeStore, fixtureProxy, PARENT, TABLE } from './fakeStore.js';
import { loadSchema } from './record.js';
import { loadRows } from './rows.js';
import { atomic, syncNotion } from './sync.js';
import { syncablesTransport } from './transport.js';

const upstream = new URL('https://api.notion.com/v1');

describe('loadRows (N4)', () => {
  it('reads imported rows back by column shortname', async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({ proxy });
    await syncNotion(store, syncablesTransport(proxy, 'conn-1', upstream));
    const schema = (await loadSchema(store))!;
    const rows = await loadRows(store, schema);
    expect(rows).toHaveLength(3);
    const launch = rows.find(r => r.name === 'Launch plan')!;
    expect(launch).toMatchObject({
      dataSource: 'Roadmap',
      pageId: '1a2b3c4d-0000-4000-8000-000000000001',
    });
    expect(launch.url).toMatch(/^https:\/\/www\.notion\.so\//);
    expect(typeof launch.lastEdited).toBe('number');
    expect(launch.values[notionFieldShortname('n%3D1')]).toBe(3);
    expect(launch.values[notionFieldShortname('BJXS')]).toBe(false);
  });

  it('ignores children of the table the sync did not make', async () => {
    const store = fakeStore();
    await store.newResource({ parent: TABLE, propVals: { [atomic.name]: 'Hand-made' } });
    const rows = await loadRows(store, (await loadSchema(store))!);
    expect(rows).toEqual([]);
  });

  // Not an assertion on speed: records the cost for the PR (N4 asks for it).
  it.each([45, 500, 2000])('reads %i rows with one getResource each', async n => {
    const store = fakeStore();
    const schema = (await loadSchema(store))!;
    const pageId = await store.newResource({
      parent: 'atomic:ontology',
      propVals: { [atomic.shortname]: 'notion-page-id' },
    });
    schema.columns.set('notion-page-id', {
      subject: pageId.subject,
      shortname: 'notion-page-id',
      name: 'Notion page id',
      datatype: '',
    });
    for (let i = 0; i < n; i++)
      store.resources.set(`atomic:row-${i}`, {
        [PARENT]: TABLE,
        [atomic.name]: `Row ${i}`,
        [pageId.subject]: `page-${i}`,
      });
    let reads = 0;
    const get = store.getResource.bind(store);
    store.getResource = s => {
      reads++;

      return get(s);
    };
    const started = performance.now();
    const rows = await loadRows(store, schema);
    const ms = performance.now() - started;
    expect(rows).toHaveLength(n);
    expect(reads).toBe(n);
    console.info(`loadRows: ${n} rows, ${reads} getResource calls, ${ms.toFixed(1)} ms (fake store)`);
  });
});
