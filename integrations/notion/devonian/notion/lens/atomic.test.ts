// @wc-ignore-file
import { Datatype } from '@tomic/lib';
import { describe, expect, it } from 'vitest';
import { DATA_SOURCE, pages } from '../../../fixtures/notion/scenario.mjs';
import {
  ATOMIC_NAME,
  NOTION_LENS_BASE,
  NotionRowLenses,
  notionDataSourceScope,
  notionLensProperty,
} from './atomic.js';
import {
  NOTION_FIXED_COLUMNS,
  notionColumns,
  notionDataSourceTitles,
  notionPropertyNames,
} from './columns.js';
import {
  JSON_DATATYPE,
  notionFieldShortname,
  notionProjection,
  notionPropertyValue,
} from './projection.js';
import type { FetchedPlatform, FetchedRecord, JSONValue } from './types.js';

const key = notionFieldShortname;

/** The fixture pages as syncables hands them to the lens, projected. */
function projected(raw: unknown[] = pages): FetchedPlatform {
  return notionProjection(
    {
      platform: 'notion',
      ontology: {
        description: '',
        terms: [
          {
            path: 'notion/class/page',
            kind: 'class',
            shortname: 'page',
            description: '',
            datatype: JSON_DATATYPE,
            requires: [],
            recommends: [],
          },
        ],
      },
      records: raw.map(page => {
        const p = page as { id: string; url: string };

        return {
          resource: 'page',
          namespace: DATA_SOURCE,
          id: p.id,
          name: p.id,
          values: page as Record<string, JSONValue>,
        };
      }),
    },
    { dataSource: DATA_SOURCE },
  );
}

/**
 * Binds every column to a host Property subject in atomic-server's own
 * `atomic:` form, which devonian would reject as a subject or property.
 */
function lenses(read = projected()) {
  const columns = notionColumns(
    read.ontology.terms,
    notionPropertyNames(read.records),
  );
  const bound = new Map(
    columns.map(c => [c.shortname, `atomic:property-${c.shortname}`]),
  );

  return {
    read,
    columns,
    bound,
    lenses: new NotionRowLenses({ columns, bound }),
  };
}

/** A column's host Property subject, and its property inside the lens store. */
const column = (shortname: string) => `atomic:property-${shortname}`;
const lensProperty = notionLensProperty;

describe('notionColumns', () => {
  it('names each projected column after its Notion property, after the fixed ones', () => {
    const { columns } = lenses();
    expect(columns.slice(0, 4)).toEqual(NOTION_FIXED_COLUMNS);
    expect(
      columns.slice(4).map(c => [c.shortname, c.name, c.datatype]),
    ).toEqual([
      [key('title'), 'Name', Datatype.STRING],
      [key('%3AUPp'), 'Status', Datatype.STRING],
      [key('BJXS'), 'Done', Datatype.BOOLEAN],
      [key('n%3D1'), 'Points', Datatype.FLOAT],
      [key('Tg%5Cq'), 'Tags', JSON_DATATYPE],
      [key('Nt0s'), 'Notes', Datatype.STRING],
    ]);
  });

  it('falls back to the property id when no page carries a name', () => {
    const { read } = lenses();
    expect(notionColumns(read.ontology.terms, new Map())[4]!.name).toBe(
      'title',
    );
  });

  it('titles data sources by plain title, then name, then id', () => {
    const source = (id: string, title: unknown, name = '') =>
      ({
        resource: 'data-source',
        namespace: '',
        id,
        name,
        values: { title },
      }) as unknown as FetchedRecord;
    const plain = [{ type: 'text', text: { content: 'Roadmap' } }];
    const bold = [
      { type: 'text', text: { content: 'X' }, annotations: { bold: true } },
    ];
    expect(
      notionDataSourceTitles([
        source('a', plain),
        source('b', bold, 'Fallback'),
        source('c', []),
      ]),
    ).toEqual(
      new Map([
        ['a', 'Roadmap'],
        ['b', 'Fallback'],
        ['c', 'c'],
      ]),
    );
  });
});

describe('NotionRowLenses: read (Notion -> Atomic)', () => {
  it('ingests a page into a row of bound Property values, keyed by page id', async () => {
    const { read, lenses: l } = lenses();
    const lens = l.lens(DATA_SOURCE, 'Roadmap', read.records);
    const subject = await lens.ingest(read.records[0]!);
    expect(subject.startsWith(`${NOTION_LENS_BASE}/resources/`)).toBe(true);
    expect(
      l.identities.externalId(
        { scope: notionDataSourceScope(DATA_SOURCE), entity: 'page' },
        subject,
      ),
    ).toBe(pages[0]!.id);
    expect(l.store.get(subject)![lensProperty('notion-page-id')]).toBe(
      pages[0]!.id,
    );
    expect(l.toHost(l.store.get(subject)!)).toEqual({
      [ATOMIC_NAME]: 'Launch plan',
      [column('notion-page-id')]: pages[0]!.id,
      [column('notion-data-source')]: 'Roadmap',
      [column('notion-url')]: pages[0]!.url,
      [column(key('title'))]: 'Launch plan',
      [column(key('%3AUPp'))]: 'b1f5a3c2-0001-4000-8000-000000000002',
      [column(key('BJXS'))]: false,
      [column(key('n%3D1'))]: 3,
      [column(key('Tg%5Cq'))]: [
        'c2e6b4d3-0002-4000-8000-000000000001',
        'c2e6b4d3-0002-4000-8000-000000000002',
      ],
      [column(key('Nt0s'))]: 'Plain notes',
    });
  });

  it('reads over a seeded existing row, unsets values Notion cleared, and keeps unreadable ones', async () => {
    const { read, lenses: l } = lenses();
    const lens = l.lens(DATA_SOURCE, 'Roadmap', read.records);
    // The host row as an earlier import left it: Points 5, Notes plain.
    l.seed(DATA_SOURCE, pages[2]!.id, {
      [ATOMIC_NAME]: 'Retrospective',
      [column(key('n%3D1'))]: 5,
      [column(key('Nt0s'))]: 'Keep this bold',
      'atomic:unmanaged': 'ignored',
    });
    const subject = await lens.ingest(read.records[2]!);
    expect(subject).toBe(l.subject(DATA_SOURCE, pages[2]!.id));
    const resource = l.toHost(l.store.get(subject)!);
    // Points is null in Notion: removed. Notes is formatted: kept as it was.
    expect(resource).not.toHaveProperty(column(key('n%3D1')));
    expect(resource[column(key('Nt0s'))]).toBe('Keep this bold');
    expect(resource).not.toHaveProperty('atomic:unmanaged');
  });

  it('skips columns without a binding', async () => {
    const { read, columns, bound } = lenses();
    bound.delete(key('BJXS'));
    const l = new NotionRowLenses({ columns, bound });
    const subject = await l
      .lens(DATA_SOURCE, 'Roadmap', read.records)
      .ingest(read.records[0]!);
    expect(l.toHost(l.store.get(subject)!)).not.toHaveProperty(
      column(key('BJXS')),
    );
    expect(l.store.get(subject)).not.toHaveProperty(lensProperty(key('BJXS')));
    expect(l.managed()).not.toContain(column(key('BJXS')));
  });

  it('never writes to Notion: publish and delete are refused', async () => {
    const { read, lenses: l } = lenses();
    const lens = l.lens(DATA_SOURCE, 'Roadmap', read.records);
    const subject = await lens.ingest(read.records[0]!);
    await expect(lens.publish(subject)).rejects.toThrow(/read-only/);
    await expect(lens.delete(subject)).rejects.toThrow(/read-only/);
    expect(l.store.get(subject)).toBeDefined();
  });
});

describe('NotionRowLenses: write (Atomic -> Notion, not wired)', () => {
  it('round-trips a read row back to the same Notion values', async () => {
    const { read, lenses: l } = lenses();
    const lens = l.lens(DATA_SOURCE, 'Roadmap', read.records);
    const page = read.records[1]!;
    const subject = await lens.ingest(page);
    const written = l.write(l.store.get(subject)!, page);
    const props = written.values.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.Name!.title).toEqual([
      { type: 'text', text: { content: 'Write changelog' } },
    ]);
    expect(props.Status!.status).toEqual({
      id: 'b1f5a3c2-0001-4000-8000-000000000003',
    });
    expect(props.Done!.checkbox).toBe(true);
    expect(props.Points!.number).toBe(0);
    expect(props.Tags!.multi_select).toEqual([]);
    expect(props.Notes!.rich_text).toEqual([]);
    // Everything else on the page passes through.
    expect(written.values.url).toBe(page.values.url);
    expect(props.Name!.id).toBe('title');
  });

  it("writes an absent value as Notion's empty and changed values by id", async () => {
    const { read, lenses: l } = lenses();
    const page = read.records[0]!;
    const subject = await l
      .lens(DATA_SOURCE, 'Roadmap', read.records)
      .ingest(page);
    const resource = l.store.get(subject)!;
    delete resource[lensProperty(key('n%3D1'))];
    delete resource[lensProperty(key('%3AUPp'))];
    resource[lensProperty(key('Tg%5Cq'))] = [
      'c2e6b4d3-0002-4000-8000-000000000001',
    ];
    const props = l.write(resource, page).values.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.Points!.number).toBeNull();
    expect(props.Status!.status).toBeNull();
    expect(props.Tags!.multi_select).toEqual([
      { id: 'c2e6b4d3-0002-4000-8000-000000000001' },
    ]);
  });

  it('refuses to overwrite formatted text it never read, and leaves it when the row has none', async () => {
    const { read, lenses: l } = lenses();
    const page = read.records[2]!;
    const subject = await l
      .lens(DATA_SOURCE, 'Roadmap', read.records)
      .ingest(page);
    const resource = l.store.get(subject)!;
    const kept = l.write(resource, page).values.properties as Record<
      string,
      unknown
    >;
    expect(kept.Notes).toEqual(
      (page.values.properties as Record<string, unknown>).Notes,
    );
    resource[lensProperty(key('Nt0s'))] = 'Plain now';
    expect(() => l.write(resource, page)).toThrow(/no lossless plain value/);
  });

  it('refuses to create pages', () => {
    const { lenses: l } = lenses();
    expect(() =>
      l.write({ '@id': `${NOTION_LENS_BASE}/resources/x` }, undefined),
    ).toThrow(/not supported/);
  });
});

describe('notionPropertyValue', () => {
  it('splits long text into 2000-character parts without splitting a surrogate pair', () => {
    const text = `${'a'.repeat(1999)}😀${'b'.repeat(10)}`;
    const parts = notionPropertyValue('rich_text', text) as {
      text: { content: string };
    }[];
    expect(parts.map(p => p.text.content.length)).toEqual([1999, 12]);
    expect(parts.map(p => p.text.content).join('')).toBe(text);
    expect(() => notionPropertyValue('title', 'x'.repeat(200_001))).toThrow(
      /limit/,
    );
  });

  it('keeps false, 0 and [] as values and refuses the wrong shape', () => {
    expect(notionPropertyValue('checkbox', false)).toBe(false);
    expect(notionPropertyValue('number', 0)).toBe(0);
    expect(notionPropertyValue('multi_select', [])).toEqual([]);
    expect(() => notionPropertyValue('number', '3')).toThrow(/Cannot write/);
    expect(() => notionPropertyValue('select', '')).toThrow(/Cannot write/);
  });
});
