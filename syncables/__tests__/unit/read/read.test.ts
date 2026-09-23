import { describe, expect, it, vi } from 'vitest';
import {
  describePlatform,
  fetchTransport,
  mergeQuerySelections,
  ontologyShortname,
  paginate,
  prepareDocument,
  readPlatform,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';
import {
  calendar,
  notion,
  notionCrudOverlay,
  notionPaginationOverlay,
  petRows,
  pets,
  workspace,
} from '../../fixtures/read.js';

const reply = (
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): { status: number; headers: Record<string, string>; body: string } => ({
  status,
  headers,
  body: JSON.stringify(body),
});

function petsTransport(): ReturnType<typeof vi.fn<Transport>> {
  return vi.fn<Transport>(async ({ url }) =>
    url.searchParams.get('page') === '2'
      ? reply(petRows.slice(2))
      : reply(petRows.slice(0, 2), {
          Link: '<https://pets.example/pets?page=2>; rel="next"',
        }),
  );
}

const urls = (transport: ReturnType<typeof vi.fn<Transport>>): string[] =>
  transport.mock.calls.map(([request]) => request.url.href);

describe('describePlatform', () => {
  it('lists collections and root parameters from crudResources', () => {
    expect(describePlatform(pets)).toEqual({
      parameters: [],
      collections: ['pets'],
      upstream: 'https://pets.example/',
    });
    expect(describePlatform(calendar).parameters).toEqual([]);
    expect(describePlatform(workspace)).toMatchObject({
      parameters: ['workspaceId'],
      collections: ['entries'],
    });
  });

  it('refuses a document without crudResources', () => {
    const components = { ...pets.components, crudResources: undefined };
    expect(() => describePlatform({ ...pets, components })).toThrow(
      /crudResources/,
    );
  });
});

describe('readPlatform', () => {
  it('follows Link-header pagination and types values from the ontology', async () => {
    const transport = petsTransport();
    const fetched = await readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport,
    });

    expect(urls(transport)).toEqual([
      'https://pets.example/pets',
      'https://pets.example/pets?page=2',
    ]);
    expect(transport.mock.calls[0]?.[0].method).toBe('GET');
    expect(fetched.platform).toBe('pets');
    expect(fetched.errors).toEqual([]);
    expect(fetched.records.map((r) => r.name)).toEqual(
      petRows.map((r) => r.name),
    );
    expect(fetched.records[0]).toEqual({
      resource: 'pet',
      namespace: '',
      id: '1',
      name: 'Rex',
      values: {
        id: 1,
        name: 'Rex',
        age: 1,
        vaccinated: true,
        weight: 0.5,
        'updated-at': Date.parse('2026-09-09T00:00:00Z'),
      },
    });
    const datatypes = Object.fromEntries(
      fetched.ontology.terms.map((t) => [t.shortname, t.datatype]),
    );
    expect(datatypes).toMatchObject({
      age: 'https://atomicdata.dev/datatypes/integer',
      vaccinated: 'https://atomicdata.dev/datatypes/boolean',
      weight: 'https://atomicdata.dev/datatypes/float',
      'updated-at': 'https://atomicdata.dev/datatypes/timestamp',
    });
    expect(fetched.ontology.terms.find((t) => t.kind === 'class')).toMatchObject(
      {
        path: 'pets/class/pet',
        requires: ['pets/property/id', 'pets/property/name'],
      },
    );
  });

  it('probes access with one request and reads nothing', async () => {
    const transport = petsTransport();
    await expect(
      readPlatform(pets, {
        platform: 'pets',
        constants: {},
        transport,
        probe: true,
      }),
    ).resolves.toMatchObject({ records: [] });
    expect(transport).toHaveBeenCalledTimes(1);

    const denied = vi.fn<Transport>(async () => reply({}, {}, 403));
    await expect(
      readPlatform(pets, {
        platform: 'pets',
        constants: {},
        transport: denied,
        probe: true,
      }),
    ).rejects.toThrow('GET /pets responded 403');
  });

  it('reads nested collections once per parent, following page tokens', async () => {
    const transport = vi.fn<Transport>(async ({ url }) => {
      if (url.pathname === '/v3/users/me/calendarList') {
        return reply({
          items: [
            { id: 'work', summary: 'Work' },
            { id: 'a/b', summary: 'Slashed' },
          ],
        });
      }
      const token = url.searchParams.get('pageToken');
      const calendarId = decodeURIComponent(url.pathname.split('/')[3] ?? '');
      return reply(
        token
          ? { items: [{ id: 'e2', summary: `${calendarId} 2` }] }
          : {
              nextPageToken: 'next',
              items: [{ id: 'e1', summary: `${calendarId} 1`, start: {} }],
            },
      );
    });
    const fetched = await readPlatform(calendar, {
      platform: 'google-calendar',
      constants: {},
      transport,
    });

    expect(
      transport.mock.calls.map(([{ url }]) => url.pathname + url.search),
    ).toEqual([
      '/v3/users/me/calendarList',
      '/v3/calendars/work/events',
      '/v3/calendars/work/events?pageToken=next',
      '/v3/calendars/a%2Fb/events',
      '/v3/calendars/a%2Fb/events?pageToken=next',
    ]);
    expect(
      fetched.records
        .filter((r) => r.resource === 'event')
        .map((r) => [r.namespace, r.id, r.name]),
    ).toEqual([
      ['work', 'e1', 'work 1'],
      ['work', 'e2', 'work 2'],
      ['a/b', 'e1', 'a/b 1'],
      ['a/b', 'e2', 'a/b 2'],
    ]);
    // An untyped (object) field stays JSON.
    expect(
      fetched.ontology.terms.find((t) => t.shortname === 'start')?.datatype,
    ).toBe('https://atomicdata.dev/datatypes/json');
  });

  it('requires root parameters and applies only declared query selections', async () => {
    // No page-count metadata in the response, so one page.
    const transport = vi.fn<Transport>(async () => reply([{ id: 'a' }]));
    const options = { platform: 'clockify', transport };
    await expect(
      readPlatform(workspace, { ...options, constants: {} }),
    ).rejects.toThrow('Enter a value for workspaceId');

    const path = '/workspaces/{workspaceId}/entries';
    const selection = mergeQuerySelections(
      { query_overrides: [{ path, values: { start: 'old' } }] },
      { query_overrides: [{ path, values: { start: '2026-01-01T00:00:00Z' } }] },
    );
    const fetched = await readPlatform(workspace, {
      ...options,
      constants: { workspaceId: 'w1' },
      ...(selection ? { selection } : {}),
    });
    expect(fetched.records.map((r) => [r.namespace, r.id])).toEqual([
      ['w1', 'a'],
    ]);
    expect(urls(transport)).toEqual([
      'https://api.example/api/v1/workspaces/w1/entries?hydrated=true&start=2026-01-01T00%3A00%3A00Z&page=1',
    ]);

    await expect(
      readPlatform(workspace, {
        ...options,
        constants: { workspaceId: 'w1' },
        selection: { query_overrides: [{ path, values: { evil: 1 } }] },
      }),
    ).rejects.toThrow('Unknown query parameter evil');
  });

  it('stops a next link that leaves the API origin, keeping the first page', async () => {
    const transport = vi.fn<Transport>(async () =>
      reply(petRows, { link: '<https://evil.example/pets>; rel="next"' }),
    );
    const fetched = await readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(fetched.records).toHaveLength(5);
    expect(fetched.errors).toEqual(['pets: Pagination left the API origin']);
  });

  it('stops when a proxy drops the cursor and the same page repeats', async () => {
    const transport = vi.fn<Transport>(async () =>
      reply(petRows.slice(0, 1), {
        link: '<https://pets.example/pets>; rel="next"',
      }),
    );
    const fetched = await readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(fetched.errors).toEqual([
      'pets: Pagination repeated a page; stopping',
    ]);
  });

  it('retries a 429 after Retry-After, and caps records and requests', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const transport = vi.fn<Transport>(async () =>
      ++calls === 1 ? reply({}, { 'Retry-After': '2' }, 429) : reply(petRows),
    );
    const fetched = await readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport,
      sleep,
      limits: { maxRecords: 3 },
    });
    expect(sleep).toHaveBeenCalledWith(expect.any(Number));
    expect(fetched.records).toHaveLength(3);
    expect(fetched.errors).toEqual([
      'pets: Read exceeds 3 records; narrow its scope',
    ]);

    // Records land page by page, so a cap mid-walk keeps what was read.
    const capped = await readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport: petsTransport(),
      limits: { maxRequests: 1 },
    });
    expect(capped.records).toHaveLength(2);
    expect(capped.errors).toEqual([
      'pets: Read exceeds 1 requests; narrow its scope',
    ]);

    await expect(
      readPlatform(pets, {
        platform: 'pets',
        constants: {},
        transport: vi.fn<Transport>(async () => reply({}, {}, 500)),
      }),
    ).rejects.toThrow('Read incomplete: pets: GET /pets responded 500');
  });

  it('rejects repeated identities instead of reading duplicates', async () => {
    const transport = vi.fn<Transport>(async () =>
      reply([petRows[0], petRows[0]]),
    );
    const fetched = await readPlatform(pets, {
      platform: 'pets',
      constants: {},
      transport,
    });
    expect(fetched.records).toHaveLength(1);
    expect(fetched.errors).toEqual([
      'pets: Missing or repeated record identity; pagination may not be forwarded by the proxy',
    ]);
  });
});

describe('POST-body pagination (Notion-shaped)', () => {
  const document = prepareDocument(notion, [
    notionPaginationOverlay,
    notionCrudOverlay,
  ]);

  /** Two pages per list; the cursor only ever travels in the JSON body. */
  function notionTransport(): ReturnType<typeof vi.fn<Transport>> {
    return vi.fn<Transport>(async ({ url, body }) => {
      const request = JSON.parse(body ?? '{}') as Record<string, unknown>;
      const second = request['start_cursor'] !== undefined;
      if (url.pathname === '/v1/search') {
        return reply({
          object: 'list',
          results: [
            second
              ? { object: 'database', id: 'db2' }
              : {
                  object: 'database',
                  id: 'db1',
                  last_edited_time: '2026-09-01T10:00:00.000Z',
                },
          ],
          next_cursor: second ? null : 'search-2',
          has_more: !second,
        });
      }
      const database = url.pathname.split('/')[3];
      return reply({
        object: 'list',
        results: [{ object: 'page', id: `${database}-${second ? 2 : 1}` }],
        next_cursor: second ? null : `${database}-cursor`,
        has_more: !second,
      });
    });
  }

  it('describes POST collections from overlays', () => {
    expect(describePlatform(document)).toEqual({
      parameters: [],
      collections: ['databases', 'rows'],
      upstream: 'https://api.notion.com/',
    });
  });

  it('sends the cursor as start_cursor in the body and follows next_cursor', async () => {
    const transport = notionTransport();
    const fetched = await readPlatform(document, {
      platform: 'notion',
      constants: {},
      transport,
    });

    const requests = transport.mock.calls.map(([request]) => request);
    expect(
      requests.map((r: TransportRequest) => [
        r.method,
        r.url.href,
        JSON.parse(r.body ?? 'null'),
      ]),
    ).toEqual([
      [
        'POST',
        'https://api.notion.com/v1/search',
        { filter: { property: 'object', value: 'database' } },
      ],
      [
        'POST',
        'https://api.notion.com/v1/search',
        {
          filter: { property: 'object', value: 'database' },
          start_cursor: 'search-2',
        },
      ],
      ['POST', 'https://api.notion.com/v1/databases/db1/query', {}],
      [
        'POST',
        'https://api.notion.com/v1/databases/db1/query',
        { start_cursor: 'db1-cursor' },
      ],
      ['POST', 'https://api.notion.com/v1/databases/db2/query', {}],
      [
        'POST',
        'https://api.notion.com/v1/databases/db2/query',
        { start_cursor: 'db2-cursor' },
      ],
    ]);
    expect(requests.every((r) => r.headers['content-type'] === 'application/json')).toBe(true);
    expect(requests.every((r) => r.url.search === '')).toBe(true);
    expect(fetched.errors).toEqual([]);
    expect(fetched.records.map((r) => [r.resource, r.namespace, r.id])).toEqual(
      [
        ['database', '', 'db1'],
        ['database', '', 'db2'],
        ['page', 'db1', 'db1-1'],
        ['page', 'db1', 'db1-2'],
        ['page', 'db2', 'db2-1'],
        ['page', 'db2', 'db2-2'],
      ],
    );
    expect(fetched.records[0]?.values['last-edited-time']).toBe(
      Date.parse('2026-09-01T10:00:00.000Z'),
    );
  });

  it('paginates one POST operation directly, with a page size in the body', async () => {
    const transport = notionTransport();
    const items = await paginate(document, {
      transport,
      path: '/v1/databases/{database_id}/query',
      method: 'POST',
      pathParams: { database_id: 'abc' },
      body: { sorts: [] },
      pageSize: 100,
    });
    expect(items.map((item) => item['id'])).toEqual(['abc-1', 'abc-2']);
    expect(
      transport.mock.calls.map(([r]) => JSON.parse(r.body ?? 'null')),
    ).toEqual([
      { sorts: [], page_size: 100 },
      { sorts: [], page_size: 100, start_cursor: 'abc-cursor' },
    ]);
  });

  it('auto-detects the body scheme from the request body when x-pagination is absent', async () => {
    // Neither Notion operation carries x-pagination; the scheme matched
    // because both declare start_cursor and page_size body properties.
    const transport = notionTransport();
    const items = await paginate(document, {
      transport,
      path: '/v1/search',
      method: 'POST',
    });
    expect(items.map((item) => item['id'])).toEqual(['db1', 'db2']);
  });
});

describe('paginate (GET)', () => {
  it('walks a Link-header operation without crudResources', async () => {
    const transport = petsTransport();
    const items = await paginate(
      { ...pets, components: { ...pets.components, crudResources: undefined } },
      { transport, path: '/pets' },
    );
    expect(items).toHaveLength(5);
    expect(urls(transport)).toEqual([
      'https://pets.example/pets',
      'https://pets.example/pets?page=2',
    ]);
  });

  it('refuses a path the document does not declare for that method', async () => {
    await expect(
      paginate(pets, { transport: petsTransport(), path: '/pets', method: 'POST' }),
    ).rejects.toThrow('/pets declares no POST operation');
  });
});

describe('fetchTransport', () => {
  it('adapts a fetch-shaped function', async () => {
    const fetchLike = vi.fn(async () =>
      Response.json([{ id: 1, name: 'Rex' }], {
        headers: { 'X-Thing': 'yes' },
      }),
    );
    const transport = fetchTransport(fetchLike);
    const response = await transport({
      url: new URL('https://pets.example/pets'),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(fetchLike).toHaveBeenCalledWith('https://pets.example/pets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(response.headers['x-thing']).toBe('yes');
    expect(JSON.parse(response.body)).toEqual([{ id: 1, name: 'Rex' }]);
  });
});

it('normalizes shortnames', () => {
  expect(ontologyShortname('updated_at')).toBe('updated-at');
  expect(ontologyShortname('State__Reason')).toBe('state-reason');
  expect(ontologyShortname('_id')).toBe('id');
});
