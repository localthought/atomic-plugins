// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  JSON_DATATYPE,
  notionDataSourceQuery,
  notionFieldShortname,
  notionProjection,
} from './localthought';

const DS = '248104cd477e80afbc30000bd28de8f9';

describe('notionProjection re-export', () => {
  // The projection itself (the supported subset, fail-closed text,
  // archived pages, type drift) is tested where it lives:
  // devonian/notion/lens/projection.test.ts. This test only
  // checks that the wiring here still resolves to that implementation.
  it('projects a plain title into the record name', () => {
    const projected = notionProjection({
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
      records: [
        {
          resource: 'page',
          namespace: DS,
          id: 'p1',
          name: 'p1',
          values: {
            properties: {
              Name: {
                id: 'title',
                type: 'title',
                title: [
                  {
                    type: 'text',
                    text: { content: 'Plan' },
                    annotations: { bold: false, color: 'default' },
                  },
                ],
              },
            },
          },
        },
      ],
    });
    expect(projected.records[0].name).toBe('Plan');
    expect(projected.records[0].values[notionFieldShortname('title')]).toBe(
      'Plan',
    );
  });

  it('leaves other platforms untouched', () => {
    const other = {
      platform: 'clockify',
      ontology: { description: '', terms: [] },
      records: [],
    };
    expect(notionProjection(other)).toBe(other);
  });
});

describe('notionDataSourceQuery', () => {
  it('builds a proxy-relative POST with a normalized data source id', () => {
    expect(notionDataSourceQuery(DS)).toEqual({
      path: '/v1/data_sources/248104cd-477e-80af-bc30-000bd28de8f9/query',
      method: 'POST',
      body: '{"page_size":100}',
    });
    expect(JSON.parse(notionDataSourceQuery(DS, 'next-1').body)).toEqual({
      page_size: 100,
      start_cursor: 'next-1',
    });
  });

  it('refuses ids and cursors that could escape the declared endpoint', () => {
    expect(() => notionDataSourceQuery('../pages')).toThrow(/UUID/);
    expect(() => notionDataSourceQuery(DS, '')).toThrow(/cursor/);
    expect(() => notionDataSourceQuery(DS, 'x'.repeat(1025))).toThrow(/cursor/);
  });
});
