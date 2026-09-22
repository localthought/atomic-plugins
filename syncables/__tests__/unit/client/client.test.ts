import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { createMockServer, type MockServer } from '../../../src/mock-server/server.js';
import {
  createApiClient,
  type ApiClient,
  type SyncResult,
} from '../../../src/client/client.js';
import {
  InMemoryStorageAdapter,
  type StorageAdapter,
} from '../../../src/client/storage.js';
import { petsDocument } from '../../fixtures/pets.js';

function countingStorage(): { storage: StorageAdapter; putCount: () => number } {
  const inner = new InMemoryStorageAdapter();
  let puts = 0;
  const storage: StorageAdapter = {
    list: (resource) => inner.list(resource),
    get: (resource, id) => inner.get(resource, id),
    put: async (resource, id, value) => {
      puts += 1;
      await inner.put(resource, id, value);
    },
    delete: (resource, id) => inner.delete(resource, id),
  };
  return { storage, putCount: () => puts };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('createApiClient', () => {
  let server: MockServer;
  let client: ApiClient;

  beforeAll(async () => {
    const document = await loadOpenApiDocument(petsDocument);
    server = createMockServer(document);
    const info = await server.listen();
    client = createApiClient(document, { baseUrl: info.url });
  });

  afterAll(() => server.close());

  it('discovers the resources described by the document', () => {
    expect(client.resources).toEqual(['/pets']);
  });

  it('syncs the remote collection into local storage', async () => {
    expect(await client.list('/pets')).toEqual([]);

    await client.sync();

    const pets = await client.list('/pets');
    expect(pets.length).toBeGreaterThan(0);
  });

  it('creates a resource remotely and stores it locally', async () => {
    const created = await client.create('/pets', { name: 'Milo', tag: 'cat' });

    const local = await client.get('/pets', created['id'] as string);
    expect(local).toEqual(created);
  });

  it('updates and removes a resource, keeping local storage in sync', async () => {
    const created = await client.create('/pets', { name: 'Buddy', tag: 'dog' });
    const id = created['id'] as string;

    await client.update('/pets', id, { name: 'Buddy Jr', tag: 'dog' });
    const updated = await client.get('/pets', id);
    expect(updated?.['name']).toBe('Buddy Jr');

    await client.remove('/pets', id);
    expect(await client.get('/pets', id)).toBeUndefined();
  });

  it('throws for an unknown resource', async () => {
    await expect(client.list('/unknown')).rejects.toThrow(/Unknown resource/);
  });

  it('throws when paginate() targets a path with no GET operation', async () => {
    await expect(client.paginate('/does-not-exist')).rejects.toThrow(
      /No GET operation found/,
    );
  });

  it('paginate() against a non-paginated GET returns its items directly', async () => {
    const items = await client.paginate('/pets');
    expect(Array.isArray(items)).toBe(true);
  });

  it('rejects paginate() when a page request responds with a non-2xx status', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const failingFetch: typeof fetch = async () =>
      new Response('service unavailable', { status: 503 });
    const brokenClient = createApiClient(document, {
      baseUrl: 'http://example.invalid',
      fetch: failingFetch,
    });

    await expect(brokenClient.paginate('/pets')).rejects.toThrow(
      /failed with status 503/,
    );
  });
});

describe('createApiClient conditional sync', () => {
  let server: MockServer;
  let client: ApiClient;
  let baseUrl: string;
  let responseStatuses: number[];

  beforeAll(async () => {
    const document = await loadOpenApiDocument(petsDocument);
    server = createMockServer(document);
    const info = await server.listen();
    baseUrl = info.url;
    const trackingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      responseStatuses.push(response.status);
      return response;
    };
    client = createApiClient(document, {
      baseUrl: info.url,
      fetch: trackingFetch,
    });
  });

  afterAll(() => server.close());

  it('only reports a resource as changed the sync it actually changed in', async () => {
    responseStatuses = [];
    const first = await client.sync();
    expect(first.changed).toEqual(['/pets']);

    const second = await client.sync();
    expect(second.changed).toEqual([]);
    // The mock server now honors If-None-Match/If-Modified-Since, so the
    // second, no-op sync gets a 304 instead of a full body.
    expect(responseStatuses).toContain(304);

    await client.create('/pets', { name: 'Whiskers', tag: 'cat' });

    const third = await client.sync();
    expect(third.changed).toEqual(['/pets']);
  });

  it('polls on an interval until stopped', async () => {
    const results: SyncResult[] = [];
    const handle = client.startPolling({
      intervalMs: 20,
      onSync: (result) => results.push(result),
    });

    await new Promise((resolve) => setTimeout(resolve, 90));
    handle.stop();
    // stop() doesn't cancel a sync already in flight when it's called, so
    // give one a moment to land before treating the count as final.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const countAfterStop = results.length;

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(countAfterStop).toBeGreaterThanOrEqual(2);
    expect(results.length).toBe(countAfterStop);
    for (const result of results) {
      expect(Array.isArray(result.changed)).toBe(true);
    }
  });

  it('reports polling errors via onError and keeps polling', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const brokenClient = createApiClient(document, {
      baseUrl: 'http://127.0.0.1:1',
    });
    const errors: unknown[] = [];

    const handle = brokenClient.startPolling({
      intervalMs: 20,
      onError: (error) => errors.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();

    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('skips a polling tick while the previous sync is still in flight', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    let concurrent = 0;
    let maxConcurrent = 0;
    const slowFetch: typeof fetch = async (input, init) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 40));
      try {
        return await fetch(input, init);
      } finally {
        concurrent -= 1;
      }
    };
    const slowClient = createApiClient(document, {
      baseUrl,
      fetch: slowFetch,
    });
    let syncCount = 0;
    const handle = slowClient.startPolling({
      intervalMs: 10, // much shorter than each 40ms sync
      onSync: () => {
        syncCount += 1;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 130));
    handle.stop();

    // Ticking every 10ms for 130ms would fire ~13 times if none were
    // skipped; the in-flight guard keeps this well below that.
    expect(syncCount).toBeLessThan(5);
    expect(maxConcurrent).toBe(1);
  });
});

describe('createApiClient sync — fallback detection, pagination, envelopes', () => {
  let server: MockServer;
  let baseUrl: string;

  beforeAll(async () => {
    const document = await loadOpenApiDocument(petsDocument);
    server = createMockServer(document);
    const info = await server.listen();
    baseUrl = info.url;
  });

  afterAll(() => server.close());

  it('detects unchanged data via item fingerprints when the server sends no conditional headers', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const strippingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if ((init?.method ?? 'GET') !== 'GET') {
        return response;
      }
      const body = await response.text();
      const headers = new Headers(response.headers);
      headers.delete('etag');
      headers.delete('last-modified');
      return new Response(body, { status: response.status, headers });
    };
    const { storage, putCount } = countingStorage();
    const client = createApiClient(document, {
      baseUrl,
      fetch: strippingFetch,
      storage,
    });

    const first = await client.sync();
    expect(first.changed).toEqual(['/pets']);
    const putsAfterFirst = putCount();
    expect(putsAfterFirst).toBeGreaterThan(0);

    const second = await client.sync();
    // No ETag/Last-Modified means the server can't 304 this — the client
    // still gets a full 200 body, but recognizes it's identical via
    // per-item fingerprinting and reports (and writes) nothing new.
    expect(second.changed).toEqual([]);
    expect(putCount()).toBe(putsAfterFirst);
  });

  it('prunes items that were removed directly on the server between syncs', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const client = createApiClient(document, { baseUrl });

    await client.sync();
    const [pet] = await client.list('/pets');
    const id = pet?.['id'] as string;

    await fetch(`${baseUrl}/pets/${id}`, { method: 'DELETE' });

    const result = await client.sync();
    expect(result.changed).toEqual(['/pets']);
    expect(await client.get('/pets', id)).toBeUndefined();
  });

  it('rejects sync() when the collection GET responds with a non-2xx, non-304 status', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const failingFetch: typeof fetch = async () =>
      new Response('internal error', { status: 500 });
    const client = createApiClient(document, { baseUrl, fetch: failingFetch });

    await expect(client.sync()).rejects.toThrow(/failed with status 500/);
  });

  it('syncs a resource whose collection GET is paginated by walking every page', async () => {
    const paginatedDocument = {
      openapi: '3.0.0',
      info: { title: 'Widgets', version: '1.0.0' },
      paths: {
        '/widgets': {
          get: {
            'x-pagination': [{ scheme: 'offset' }],
            responses: {
              '200': {
                description: 'A page of widgets',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        widgets: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/Widget' },
                        },
                        pagination: {
                          type: 'object',
                          properties: {
                            total_count: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/widgets/{widgetId}': {
          get: {
            responses: {
              '200': {
                description: 'A widget',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Widget' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Widget: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
          },
        },
        paginationSchemes: {
          offset: {
            type: 'pageNumber',
            request: {
              queryParameters: {
                limit: { role: 'pageSize' },
                offset: { role: 'offset' },
              },
            },
            response: {
              bodyFields: {
                'pagination.total_count': { role: 'totalCount' },
              },
            },
          },
        },
      },
    };

    const document = await loadOpenApiDocument(paginatedDocument);
    const widgetServer = createMockServer(document);
    const info = await widgetServer.listen();
    try {
      const client = createApiClient(document, { baseUrl: info.url });

      const result = await client.sync();
      expect(result.changed).toEqual(['/widgets']);

      const widgets = await client.list('/widgets');
      // The mock server generates a fixed 7-item dataset per paginated
      // path template; with its default page size of 3 this takes three
      // requests (3 + 3 + 1) to fully traverse.
      expect(widgets).toHaveLength(7);
      expect(new Set(widgets.map((w) => w['id'])).size).toBe(7);
    } finally {
      await widgetServer.close();
    }
  });

  it('unwraps an enveloped (non-array) response for a non-paginated resource', async () => {
    const gadgetsDocument = {
      openapi: '3.0.0',
      info: { title: 'Gadgets', version: '1.0.0' },
      paths: {
        '/gadgets': {
          get: {
            responses: {
              '200': {
                description: 'Gadgets',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        gadgets: { type: 'array', items: { type: 'object' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/gadgets/{gadgetId}': {
          get: { responses: { '200': { description: 'A gadget' } } },
        },
      },
    };
    const document = await loadOpenApiDocument(gadgetsDocument);
    const syntheticFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ gadgets: [{ id: 'g1', name: 'Gadget One' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const client = createApiClient(document, {
      baseUrl: 'http://example.invalid',
      fetch: syntheticFetch,
    });

    const result = await client.sync();
    expect(result.changed).toEqual(['/gadgets']);
    expect(await client.list('/gadgets')).toEqual([
      { id: 'g1', name: 'Gadget One' },
    ]);

    // paginate() falls back through the same envelope-unwrapping when the
    // operation it targets turns out not to be paginated.
    const paginated = await client.paginate('/gadgets');
    expect(paginated).toEqual([{ id: 'g1', name: 'Gadget One' }]);
  });

  it('rejects sync() for a resource whose collection path has no GET operation', async () => {
    // Mirrors a real-world quirk (e.g. Trello): discoverResources pairs a
    // resource by path shape alone, so a collection path that only
    // supports POST is still a "resource" — its GET just isn't there.
    const postOnlyDocument = {
      openapi: '3.0.0',
      info: { title: 'Post Only', version: '1.0.0' },
      paths: {
        '/boards': {
          post: {
            responses: {
              '201': {
                description: 'Created',
                content: {
                  'application/json': { schema: { type: 'object' } },
                },
              },
            },
          },
        },
        '/boards/{boardId}': {
          get: { responses: { '200': { description: 'A board' } } },
        },
      },
    };
    const document = await loadOpenApiDocument(postOnlyDocument);
    const boardsServer = createMockServer(document);
    const info = await boardsServer.listen();
    try {
      const client = createApiClient(document, { baseUrl: info.url });
      await expect(client.sync()).rejects.toThrow(/failed with status 405/);
    } finally {
      await boardsServer.close();
    }
  });

  it('trusts a change-indicator field over the rest of the record when fingerprinting', async () => {
    const notesDocument = {
      openapi: '3.0.0',
      info: { title: 'Notes', version: '1.0.0' },
      paths: {
        '/notes': {
          get: {
            responses: {
              '200': {
                description: 'Notes',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
        '/notes/{noteId}': {
          get: { responses: { '200': { description: 'A note' } } },
        },
      },
    };
    const document = await loadOpenApiDocument(notesDocument);
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      return new Response(
        JSON.stringify([
          {
            id: 'n1',
            // The rest of the record differs between calls, but a shared
            // `updatedAt` should still be read as "unchanged".
            title: call === 1 ? 'Draft' : 'Different text, same updatedAt',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = createApiClient(document, {
      baseUrl: 'http://example.invalid',
      fetch: fetchImpl,
    });

    const first = await client.sync();
    expect(first.changed).toEqual(['/notes']);

    const second = await client.sync();
    expect(second.changed).toEqual([]);
  });
});

describe('createApiClient local-first writes', () => {
  let server: MockServer;
  let baseUrl: string;

  beforeAll(async () => {
    const document = await loadOpenApiDocument(petsDocument);
    server = createMockServer(document);
    const info = await server.listen();
    baseUrl = info.url;
  });

  afterAll(() => server.close());

  it('creates, updates and removes locally without waiting on the network', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    let releaseRequests: (() => void) | undefined;
    const blockedUntilReleased = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const stalledFetch: typeof fetch = async (input, init) => {
      await blockedUntilReleased;
      return fetch(input, init);
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: stalledFetch,
    });

    const created = await client.create('/pets', { name: 'Milo', tag: 'cat' });
    expect(await client.get('/pets', created['id'] as string)).toEqual(created);
    expect(client.pendingWrites('/pets')).toEqual([
      { resource: '/pets', id: created['id'], type: 'create', attempts: 0 },
    ]);

    const id = created['id'] as string;
    const updated = await client.update('/pets', id, { name: 'Milo Jr' });
    expect(updated['name']).toBe('Milo Jr');
    expect(await client.get('/pets', id)).toEqual(updated);

    await client.remove('/pets', id);
    expect(await client.get('/pets', id)).toBeUndefined();

    // All three writes are still stuck behind the same stalled fetch.
    expect(client.pendingWrites('/pets').map((w) => w.type)).toEqual([
      'create',
      'update',
      'delete',
    ]);

    releaseRequests?.();
    await waitUntil(() => client.pendingWrites('/pets').length === 0);
  });

  it('retries a failing write with backoff until it succeeds', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    let putAttempts = 0;
    const flakyFetch: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        putAttempts += 1;
        if (putAttempts < 3) {
          throw new Error('simulated network failure');
        }
      }
      return fetch(input, init);
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: flakyFetch,
      retry: { baseDelayMs: 5, maxDelayMs: 20 },
    });

    await client.sync();
    const [pet] = await client.list('/pets');
    const id = pet?.['id'] as string;

    const before = Date.now();
    await client.update('/pets', id, { name: 'Renamed Fast' });
    expect(Date.now() - before).toBeLessThan(50);

    await waitUntil(() => putAttempts >= 3);
    await waitUntil(() => client.pendingWrites('/pets').length === 0);

    const remote = await fetch(`${baseUrl}/pets/${id}`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(remote['name']).toBe('Renamed Fast');
  });

  it('moves a locally created record onto whatever id the server assigns', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const reassigningFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if ((init?.method ?? 'GET') !== 'POST') {
        return response;
      }
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ...body, id: 'server-assigned-id' }),
        { status: response.status, headers: response.headers },
      );
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: reassigningFetch,
    });

    const created = await client.create('/pets', { name: 'Reassigned', tag: 'cat' });
    const localId = created['id'] as string;

    await waitUntil(() => client.pendingWrites('/pets').length === 0);

    expect(await client.get('/pets', localId)).toBeUndefined();
    const moved = await client.get('/pets', 'server-assigned-id');
    expect(moved?.['name']).toBe('Reassigned');
  });

  it('stops retrying once maxAttempts is reached and surfaces the failure', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    const alwaysFailingFetch: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        throw new Error('server unreachable');
      }
      return fetch(input, init);
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: alwaysFailingFetch,
      retry: { baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 },
    });

    await client.sync();
    const [pet] = await client.list('/pets');
    const id = pet?.['id'] as string;

    await client.remove('/pets', id);

    await waitUntil(() => {
      const [pending] = client.pendingWrites('/pets');
      return pending?.attempts === 2;
    });

    const [pending] = client.pendingWrites('/pets');
    expect(pending).toMatchObject({ type: 'delete', attempts: 2 });
    expect(pending?.lastError).toMatch(/server unreachable/);

    // Doesn't keep retrying forever once it's given up.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(client.pendingWrites('/pets')[0]?.attempts).toBe(2);
  });

  it('retries a write after an HTTP error status, not just a thrown network error', async () => {
    const document = await loadOpenApiDocument(petsDocument);
    let putCalls = 0;
    const failingStatusFetch: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        putCalls += 1;
        if (putCalls < 2) {
          return new Response('server error', { status: 500 });
        }
      }
      return fetch(input, init);
    };
    const client = createApiClient(document, {
      baseUrl,
      fetch: failingStatusFetch,
      retry: { baseDelayMs: 5, maxDelayMs: 10 },
    });

    await client.sync();
    const [pet] = await client.list('/pets');
    const id = pet?.['id'] as string;

    await client.update('/pets', id, { name: 'Retried Status' });
    await waitUntil(() => putCalls >= 2);
    await waitUntil(() => client.pendingWrites('/pets').length === 0);

    const remote = (await fetch(`${baseUrl}/pets/${id}`).then((response) =>
      response.json(),
    )) as Record<string, unknown>;
    expect(remote['name']).toBe('Retried Status');
  });

  it('pendingWrites() filters by resource and defaults to reporting every resource', async () => {
    const twoResourceDocument = {
      openapi: '3.0.0',
      info: { title: 'Two Resources', version: '1.0.0' },
      paths: {
        '/pets': petsDocument.paths['/pets'],
        '/pets/{petId}': petsDocument.paths['/pets/{petId}'],
        '/toys': {
          get: {
            responses: {
              '200': {
                description: 'Toys',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
          post: {
            responses: {
              '201': {
                description: 'Created',
                content: {
                  'application/json': {
                    schema: { type: 'object' },
                  },
                },
              },
            },
          },
        },
        '/toys/{toyId}': {
          get: { responses: { '200': { description: 'A toy' } } },
          put: { responses: { '200': { description: 'Updated' } } },
          delete: { responses: { '204': { description: 'Deleted' } } },
        },
      },
      components: petsDocument.components,
    };
    const document = await loadOpenApiDocument(twoResourceDocument);
    let releaseRequests: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const stalledFetch: typeof fetch = async (input, init) => {
      await blocked;
      return fetch(input, init);
    };
    const twoResourceServer = createMockServer(document);
    const info = await twoResourceServer.listen();
    try {
      const client = createApiClient(document, {
        baseUrl: info.url,
        fetch: stalledFetch,
      });

      await client.create('/pets', { name: 'Milo', tag: 'cat' });
      await client.create('/toys', { name: 'Ball' });

      expect(client.pendingWrites('/pets')).toHaveLength(1);
      expect(client.pendingWrites('/pets')[0]?.resource).toBe('/pets');
      expect(client.pendingWrites().map((w) => w.resource).sort()).toEqual([
        '/pets',
        '/toys',
      ]);

      releaseRequests?.();
      await waitUntil(() => client.pendingWrites().length === 0);
    } finally {
      await twoResourceServer.close();
    }
  });
});
