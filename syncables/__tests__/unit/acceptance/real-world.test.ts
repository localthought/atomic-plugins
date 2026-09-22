import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { discoverResources } from '../../../src/resources/discover.js';
import { createMockServer, type MockServer } from '../../../src/mock-server/server.js';
import { createApiClient, type ApiClient } from '../../../src/client/client.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';

/**
 * These documents are vendored, unmodified, from the apis.guru OpenAPI
 * directory (see the header comment in each fixture file). Unlike the
 * hand-written `petsDocument` fixture, they weren't authored to fit this
 * library's model of a "resource" (a collection path paired with an item
 * path, both returning that resource shape directly) — so, alongside the
 * happy path, these tests also pin down where that model and a real API
 * diverge, rather than asserting an idealized result.
 */

function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../../fixtures/real-world/${name}`, import.meta.url),
  );
}

describe('acceptance: giphy.com (apis.guru)', () => {
  let document: OpenApiDocument;
  let server: MockServer;
  let client: ApiClient;
  let baseUrl: string;

  beforeAll(async () => {
    document = await loadOpenApiDocument(fixturePath('giphy.yaml'));
    server = createMockServer(document);
    const info = await server.listen();
    baseUrl = info.url;
    client = createApiClient(document, { baseUrl });
  });

  afterAll(() => server.close());

  it('loads the document and resolves its $refs', () => {
    expect(document.info.title).toBe('Giphy API');
  });

  it('discovers /gifs as the only resource', () => {
    expect(discoverResources(document.paths)).toEqual([
      {
        collectionPath: '/gifs',
        itemPath: '/gifs/{gifId}',
        itemParam: 'gifId',
        updateMethod: 'PUT',
      },
    ]);
  });

  it('syncs the resource end to end', async () => {
    await client.sync();
    const gifs = await client.list('/gifs');
    expect(gifs).toHaveLength(3);

    // Giphy's real GET /gifs response is an envelope, `{ data, meta,
    // pagination }`, not a bare array of gifs. discoverResources/the mock
    // server don't unwrap that, so what gets seeded and synced is one fake
    // envelope object per seed slot, not three real-looking Gif records.
    expect(gifs[0]).toHaveProperty('id');
    expect(gifs[0]).toHaveProperty('data');
    expect(gifs[0]).toHaveProperty('pagination');
  });

  it('falls back to the generated schema for a documented non-resource path', async () => {
    // /gifs/random isn't paired with an item path, so it's served from its
    // documented response schema rather than treated as a resource.
    const response = await fetch(`${baseUrl}/gifs/random`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
  });
});

describe('acceptance: spotify.com (apis.guru)', () => {
  let document: OpenApiDocument;
  let server: MockServer;
  let client: ApiClient;

  beforeAll(async () => {
    // Spotify's document has a vendor extension pointing at an external
    // file ($ref: ../policies.yaml) unrelated to any schema used here;
    // loadOpenApiDocument must resolve refs without tripping over it.
    document = await loadOpenApiDocument(fixturePath('spotify.yaml'));
    server = createMockServer(document);
    const info = await server.listen();
    client = createApiClient(document, { baseUrl: info.url });
  });

  afterAll(() => server.close());

  it('loads the document and resolves its $refs', () => {
    expect(document.info.title).toBe('Spotify Web API');
  });

  it('discovers the collection/item resource pairs described by the document', () => {
    expect(client.resources.sort()).toEqual(
      [
        '/albums',
        '/artists',
        '/audio-features',
        '/audiobooks',
        '/browse/categories',
        '/chapters',
        '/episodes',
        '/shows',
        '/tracks',
      ].sort(),
    );
  });

  it('syncs every discovered resource without any request failing', async () => {
    // Unlike some real-world APIs (see e.g. Trello, where every collection
    // path only supports POST), Spotify's read endpoints all support GET on
    // both the collection and item path, so a full sync succeeds here.
    const result = await client.sync();
    expect(result.changed.sort()).toEqual(client.resources.slice().sort());

    for (const resource of client.resources) {
      const items = await client.list(resource);
      expect(items).toHaveLength(3);
      // As with Giphy, Spotify wraps collection responses in an envelope
      // (e.g. `{ albums: [...] }`), which isn't unwrapped, so each synced
      // record is envelope-shaped rather than a real-looking item.
      expect(items[0]).toHaveProperty('id');
    }
  });

  it('serves an item route directly from the mock server', async () => {
    const albums = await client.list('/albums');
    const id = albums[0]?.['id'] as string;

    const fetched = await client.get('/albums', id);
    expect(fetched).toEqual(albums[0]);
  });
});
