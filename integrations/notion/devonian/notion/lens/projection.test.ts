// @wc-ignore-file
import { Datatype } from '@tomic/lib';
import { describe, expect, it } from 'vitest';
import type { FetchedPlatform, JSONValue } from './types.js';
import {
  JSON_DATATYPE,
  notionFieldShortname,
  notionFieldValue,
  notionPlainText,
  notionProjection,
} from './projection.js';

const DS = '248104cd-477e-80af-bc30-000bd28de8f9';
const text = (
  content: string,
): Array<{
  type: string;
  text: { content: string; link: unknown };
  annotations: Record<string, string | boolean>;
  plain_text: string;
}> => [
  {
    type: 'text',
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
    },
    plain_text: content,
  },
];

// Raw Notion JSON contains nulls, which Atomic's JSONValue does not model;
// the fixtures are cast at the FetchedRecord boundary, like engine output.
const page = (
  id: string,
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): FetchedPlatform['records'][number] => ({
  resource: 'page',
  namespace: DS,
  id,
  name: id,
  values: {
    object: 'page',
    id,
    parent: { type: 'data_source_id', data_source_id: DS },
    archived: false,
    in_trash: false,
    properties,
    ...extra,
  } as Record<string, JSONValue>,
});

const fixture = (records: FetchedPlatform['records']): FetchedPlatform => ({
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
        recommends: ['notion/property/properties'],
      },
    ],
  },
  records,
});

const key = notionFieldShortname;

describe('notionProjection', () => {
  it('projects the supported subset keyed by stable property id', () => {
    const properties = {
      Name: { id: 'title', type: 'title', title: text('  Write spec ') },
      Notes: {
        id: 'n%3Ab',
        type: 'rich_text',
        rich_text: text('a'.repeat(2500)),
      },
      Estimate: { id: 'EST', type: 'number', number: 0 },
      Done: { id: 'est', type: 'checkbox', checkbox: false },
      Link: { id: 'u', type: 'url', url: null },
      Mail: { id: 'm', type: 'email', email: 'a@example.com' },
      Phone: { id: 'ph', type: 'phone_number', phone_number: '+31 6' },
      Stage: {
        id: 's',
        type: 'select',
        select: { id: 'opt-b', name: 'Doing' },
      },
      State: { id: 'st', type: 'status', status: null },
      Tags: {
        id: 't',
        type: 'multi_select',
        multi_select: [
          { id: 'z', name: 'Zed' },
          { id: 'a', name: 'Ay' },
        ],
      },
      Due: { id: 'd', type: 'date', date: { start: '2026-09-23' } },
    };
    const projected = notionProjection(fixture([page('p1', properties)]), {
      dataSource: DS.replaceAll('-', ''),
    });
    const [row] = projected.records;
    expect(row.name).toBe('Write spec');
    expect(row.values[key('title')]).toBe('  Write spec ');
    expect(row.values[key('n%3Ab')]).toBe('a'.repeat(2500));
    // 0 and false are values; Notion's null (no value) leaves the key absent.
    expect(row.values[key('EST')]).toBe(0);
    expect(row.values[key('est')]).toBe(false);
    expect(key('u') in row.values).toBe(false);
    expect(row.values[key('m')]).toBe('a@example.com');
    expect(row.values[key('ph')]).toBe('+31 6');
    expect(row.values[key('s')]).toBe('opt-b');
    expect(key('st') in row.values).toBe(false);
    expect(row.values[key('t')]).toEqual(['a', 'z']);
    // Unsupported types are preserved raw, never projected or dropped.
    expect(row.values[key('d')]).toBeUndefined();
    expect(row.values.properties).toEqual(properties);
    expect(projected.errors).toBeUndefined();

    const added = projected.ontology.terms.filter(t => t.kind === 'property');
    expect(added.map(t => [t.shortname, t.datatype])).toEqual([
      [key('title'), Datatype.STRING],
      [key('n%3Ab'), Datatype.STRING],
      [key('EST'), Datatype.FLOAT],
      [key('est'), Datatype.BOOLEAN],
      [key('u'), Datatype.STRING],
      [key('m'), Datatype.STRING],
      [key('ph'), Datatype.STRING],
      [key('s'), Datatype.STRING],
      [key('st'), Datatype.STRING],
      [key('t'), JSON_DATATYPE],
    ]);
    expect(added[2].description).toContain('"Estimate"');
    const cls = projected.ontology.terms.find(t => t.kind === 'class')!;
    expect(cls.recommends).toEqual([
      'notion/property/properties',
      ...added.map(t => t.path),
    ]);
  });

  it('distinguishes property ids that differ only in case', () => {
    expect(key('EST')).not.toBe(key('est'));
    expect(key('title')).toBe(key('title'));
    expect(key('%3AUPp')).toMatch(/^notion-[0-9a-f]+$/);
    expect(() => key('')).toThrow(/empty/);
  });

  it('leaves formatted text unprojected and reports it without failing the fetch', () => {
    const bold = text('Loud');
    bold[0].annotations.bold = true;
    const projected = notionProjection(
      fixture([
        page('p1', { Name: { id: 'title', type: 'title', title: bold } }),
        page('p2', {
          Name: { id: 'title', type: 'title', title: text('Quiet') },
        }),
      ]),
    );
    expect(projected.records.map(r => r.name)).toEqual(['Untitled', 'Quiet']);
    expect(projected.records[0].values[key('title')]).toBeUndefined();
    expect(projected.errors).toEqual([
      expect.stringMatching(/p1 property "Name" \(title\).*unprojected/),
    ]);
  });

  it('leaves archived and trashed pages out without implying deletion', () => {
    const projected = notionProjection(
      fixture([
        page('gone', {}, { archived: true }),
        page('bin', {}, { in_trash: true }),
        page('kept', {}),
      ]),
    );
    expect(projected.records.map(r => r.id)).toEqual(['kept']);
    expect(projected.errors).toHaveLength(2);
    expect(projected.errors![0]).toMatch(/gone.*not deleted/);
  });

  it('refuses pages from another data source and mid-fetch type changes', () => {
    const moved = page(
      'p1',
      {},
      {
        parent: { data_source_id: '00000000-0000-0000-0000-000000000000' },
      },
    );
    expect(() =>
      notionProjection(fixture([moved]), { dataSource: DS }),
    ).toThrow(/outside data source/);
    expect(() =>
      notionProjection(
        fixture([
          page('p1', { A: { id: 'x', type: 'number', number: 1 } }),
          page('p2', { A: { id: 'x', type: 'checkbox', checkbox: true } }),
        ]),
      ),
    ).toThrow(/changed type from number to checkbox/);
  });

  it('keeps earlier errors and passes other resources and platforms through', () => {
    const base = fixture([
      { resource: 'user', namespace: '', id: 'u1', name: 'Ann', values: {} },
    ]);
    base.errors = ['capped at 100 records'];
    const projected = notionProjection(base);
    expect(projected.records).toEqual(base.records);
    expect(projected.errors).toEqual(['capped at 100 records']);

    const other = { ...fixture([]), platform: 'clockify' };
    expect(notionProjection(other)).toBe(other);
    const classless = {
      ...fixture([]),
      ontology: { description: '', terms: [] },
    };
    expect(notionProjection(classless)).toBe(classless);
  });
});

describe('notionFieldValue', () => {
  it('rejects values it cannot represent losslessly', () => {
    expect(notionFieldValue('number', Number.NaN)).toBeUndefined();
    expect(notionFieldValue('number', '3')).toBeUndefined();
    expect(notionFieldValue('checkbox', null)).toBeUndefined();
    expect(notionFieldValue('select', { name: 'no id' })).toBeUndefined();
    expect(notionFieldValue('multi_select', [{ id: 'a' }, {}])).toBeUndefined();
    expect(notionFieldValue('multi_select', [])).toEqual([]);
    expect(notionFieldValue('number', null)).toBeNull();
    expect(notionFieldValue('status', null)).toBeNull();
  });

  it('treats links, mentions and colour as formatting', () => {
    const linked = text('x');
    (linked[0].text as { link: unknown }).link = { url: 'https://example.com' };
    expect(notionPlainText(linked)).toBeUndefined();
    expect(notionPlainText([{ type: 'mention', mention: {} }])).toBeUndefined();
    const red = text('x');
    red[0].annotations.color = 'red';
    expect(notionPlainText(red)).toBeUndefined();
    expect(notionPlainText([...text('a'), ...text('b')])).toBe('ab');
    expect(notionPlainText([])).toBe('');
  });
});
