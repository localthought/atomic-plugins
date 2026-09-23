// @wc-ignore-file
/**
 * The Notion catalog document (catalog/notion.json: overlays/catalog.json's
 * notion entry as the proxy composes it) and the authored mock-proxy fixture
 * that serves it. The lens test at the end feeds the fixture's pages through
 * `notionProjection` in the shape syncables/browser's `readPlatform` hands it:
 * `resource: 'page'`, `values` keyed by field shortname.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import document from './catalog/notion.json' with { type: 'json' };
import provenance from './catalog/notion.provenance.json' with { type: 'json' };
import fixture, {
  DATA_SOURCE,
  FIXTURE_PAGE_SIZE,
  notionFixture,
  pages,
} from './fixtures/notion/scenario.mjs';
import {
  JSON_DATATYPE,
  notionFieldShortname,
  notionProjection,
  type FetchedPlatform,
} from './localthought';

type Doc = {
  security?: unknown;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    paginationSchemes: Record<string, Record<string, unknown>>;
    crudResources: Record<string, Record<string, Record<string, unknown>>>;
    schemas: Record<string, unknown>;
  };
};

const doc = document as unknown as Doc;
const PAGES_BASE = 'https://ontola.github.io/atomic-plugins/overlays/';

describe('Notion catalog document', () => {
  it('declares both lists as POST operations with a request-body cursor', () => {
    for (const path of ['/search', '/data_sources/{data_source_id}/query'])
      expect(doc.paths[path]!.post!['x-pagination']).toEqual([
        { scheme: 'bodyCursor' },
      ]);
    const scheme = doc.components.paginationSchemes.bodyCursor!;
    expect(scheme.type).toBe('pageToken');
    expect(scheme.request).toEqual({
      bodyFields: {
        start_cursor: expect.objectContaining({ role: 'pageToken' }),
        page_size: expect.objectContaining({ role: 'pageSize' }),
      },
    });
    expect(scheme.response).toEqual({
      bodyFields: { next_cursor: { role: 'nextPageToken' } },
    });
  });

  it('declares data sources and their pages as read-only crudResources', () => {
    const { data_source, page } = doc.components.crudResources;
    expect(data_source!.collections).toEqual({
      data_sources: {
        urlTemplate: '/search',
        'x-list-method': 'POST',
        'x-list-body': {
          filter: { property: 'object', value: 'data_source' },
          page_size: 100,
        },
      },
    });
    expect(page!.collections).toEqual({
      pages: {
        urlTemplate: '/data_sources/{data_source_id}/query',
        'x-list-method': 'POST',
        'x-list-body': { page_size: 100 },
      },
    });
    // The page collection's context comes from the data source identity.
    expect(data_source!.identity).toEqual({
      urlTemplate: '/data_sources/{data_source_id}',
      bindings: { data_source_id: { field: 'id' } },
    });
    for (const resource of [data_source!, page!])
      expect(Object.keys(resource)).not.toContain('operations');
  });

  it('keeps the OAuth overlay and every referenced schema', () => {
    expect(doc.security).toEqual([{ notionOAuth: [] }]);
    for (const name of ['NotionDataSource', 'NotionPage', 'JsonObject'])
      expect(doc.components.schemas).toHaveProperty(name);
  });

  it('is a snapshot of the current overlays/catalog.json notion entry', () => {
    // Hashes, not a re-composition: nothing here can parse YAML. A changed
    // overlay or catalog entry fails this; rerun catalog/generate.py.
    const root = new URL('../../', import.meta.url);
    const catalog = JSON.parse(
      readFileSync(new URL('overlays/catalog.json', root), 'utf8'),
    ) as { platforms: { name: string; openapi: string; overlays: string[] }[] };
    const entry = catalog.platforms.find(p => p.name === 'notion')!;
    const { sources } = provenance as {
      sources: { url: string; sha256: string }[];
    };
    expect(sources.map(s => s.url)).toEqual([entry.openapi, ...entry.overlays]);

    // The base OAD is pinned to an openapi-directory commit; overlays are
    // read from this checkout, as overlays CI and generate.py read them.
    for (const { url, sha256 } of sources.slice(1)) {
      const file = url.replace(PAGES_BASE, '');
      expect(url).not.toBe(file);
      const bytes = readFileSync(new URL(`overlays/${file}`, root));
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(
        sha256,
      );
    }
  });

  it('is what the mock proxy serves', () => {
    expect(fixture.document).toEqual(doc);
    expect(fixture.jsonBody).toBe(true);
  });
});

describe('Notion fixture', () => {
  const url = (path: string) => new URL(`http://mock/proxy/notion${path}`);

  it('walks every page only by sending next_cursor back in the body', () => {
    const api = notionFixture();
    const query = `/v1/data_sources/${DATA_SOURCE}/query`;
    const seen: string[] = [];
    let body: Record<string, unknown> = { page_size: 100 };

    for (let i = 0; i < 10; i++) {
      const response = api.request('POST', url(query), body);
      expect(response.status).toBe(200);
      const page = response.body as {
        results: { id: string }[];
        next_cursor: string | null;
        has_more: boolean;
      };
      expect(page.results.length).toBeLessThanOrEqual(FIXTURE_PAGE_SIZE);
      seen.push(...page.results.map(r => r.id));
      expect(page.has_more).toBe(page.next_cursor !== null);
      if (!page.next_cursor) break;
      body = { page_size: 100, start_cursor: page.next_cursor };
    }

    expect(seen).toEqual(pages.map(p => p.id));
    // The cursor is ignored if sent anywhere but the body.
    expect(
      api.request('POST', url(`${query}?start_cursor=cursor-2`), {}).body,
    ).toMatchObject({ results: [{ id: pages[0]!.id }, { id: pages[1]!.id }] });
  });

  it('filters search, refuses unknown cursors and data sources, and writes', () => {
    const api = notionFixture();
    const search = (value: string) =>
      api.request('POST', url('/v1/search'), {
        filter: { property: 'object', value },
      }).body as { results: { object: string }[] };
    expect(search('data_source').results.map(r => r.object)).toEqual([
      'data_source',
    ]);
    expect(
      api.request('POST', url(`/v1/data_sources/${DATA_SOURCE}/query`), {
        start_cursor: 'cursor-99',
      }).status,
    ).toBe(400);
    expect(
      api.request(
        'POST',
        url('/v1/data_sources/00000000-0000-4000-8000-000000000000/query'),
        {},
      ).status,
    ).toBe(404);
    expect(
      api.request('PATCH', url(`/v1/pages/${pages[0]!.id}`), {}).status,
    ).toBe(403);
    expect(api.request('POST', url('/v1/pages'), {}).status).toBe(403);
    expect(api.requests.map(r => r.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'PATCH',
      'POST',
    ]);
  });
});

describe('read-only lens over the fixture pages', () => {
  // What a syncables-style reader produces from the page list: one record
  // per page, namespaced by its data source, with the page's top-level
  // fields as values (`properties` passes through as raw JSON).
  const fetched: FetchedPlatform = {
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
    records: pages.map(p => ({
      resource: 'page',
      namespace: DATA_SOURCE,
      id: p.id,
      name: p.id,
      values: {
        properties: p.properties,
        parent: p.parent,
        archived: p.archived,
        'in-trash': p.in_trash,
        url: p.url,
      },
    })),
  };

  it('names rows by title and keys values by stable property id', () => {
    const projected = notionProjection(fetched, { dataSource: DATA_SOURCE });
    expect(projected.records.map(r => r.name)).toEqual([
      'Launch plan',
      'Write changelog',
      'Retrospective',
    ]);
    const [launch, changelog, retro] = projected.records;
    const key = notionFieldShortname;
    expect(launch!.values[key('BJXS')]).toBe(false);
    expect(launch!.values[key('n%3D1')]).toBe(3);
    expect(launch!.values[key('%3AUPp')]).toBe(
      'b1f5a3c2-0001-4000-8000-000000000002',
    );
    expect(launch!.values[key('Tg%5Cq')]).toEqual([
      'c2e6b4d3-0002-4000-8000-000000000001',
      'c2e6b4d3-0002-4000-8000-000000000002',
    ]);
    // `0`, `true` and `[]` are values; a null number leaves the key absent.
    expect(changelog!.values[key('n%3D1')]).toBe(0);
    expect(changelog!.values[key('BJXS')]).toBe(true);
    expect(changelog!.values[key('Tg%5Cq')]).toEqual([]);
    expect(retro!.values).not.toHaveProperty(key('n%3D1'));
    // Formatted rich text is reported, not flattened.
    expect(retro!.values).not.toHaveProperty(key('Nt0s'));
    expect(projected.errors).toEqual([
      `Notion page ${retro!.id} property "Notes" (rich_text) has no lossless plain value; left unprojected`,
    ]);
  });

  it('leaves out a trashed page under either spelling of in_trash', () => {
    for (const field of ['in_trash', 'in-trash']) {
      const trashed = {
        ...fetched,
        records: [
          {
            ...fetched.records[0]!,
            values: { ...fetched.records[0]!.values, [field]: true },
          },
        ],
      };
      const projected = notionProjection(trashed);
      expect(projected.records).toEqual([]);
      expect(projected.errors).toEqual([
        `Notion page ${pages[0]!.id} is archived or in trash; left out, not deleted`,
      ]);
    }
  });
});
