import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { createMockServer, type MockServer } from '../../../src/mock-server/server.js';
import { petsDocument } from '../../fixtures/pets.js';

describe('createMockServer', () => {
  let server: MockServer;
  let baseUrl: string;

  beforeAll(async () => {
    const document = await loadOpenApiDocument(petsDocument);
    server = createMockServer(document);
    const info = await server.listen();
    baseUrl = info.url;
  });

  afterAll(() => server.close());

  it('seeds a fresh collection with fake data on first GET', async () => {
    const response = await fetch(`${baseUrl}/pets`);
    const pets = (await response.json()) as Record<string, unknown>[];

    expect(response.status).toBe(200);
    expect(pets).toHaveLength(3);
    expect(pets[0]).toHaveProperty('id');
    expect(pets[0]).toHaveProperty('name');
  });

  it('creates, reads, updates and deletes an item', async () => {
    const createResponse = await fetch(`${baseUrl}/pets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rex', tag: 'dog' }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as Record<string, unknown>;
    expect(created['name']).toBe('Rex');
    expect(created['id']).toEqual(expect.any(String));

    const fetched = await fetch(`${baseUrl}/pets/${created['id'] as string}`).then((r) =>
      r.json(),
    );
    expect(fetched).toEqual(created);

    const updateResponse = await fetch(`${baseUrl}/pets/${created['id'] as string}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rex Updated', tag: 'dog' }),
    });
    const updated = (await updateResponse.json()) as Record<string, unknown>;
    expect(updated['name']).toBe('Rex Updated');
    expect(updated['id']).toBe(created['id']);

    const deleteResponse = await fetch(`${baseUrl}/pets/${created['id'] as string}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(204);

    const afterDelete = await fetch(`${baseUrl}/pets/${created['id'] as string}`);
    expect(afterDelete.status).toBe(404);
  });

  it('falls back to the documented example for non-resource paths', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  it('serves an ETag and Last-Modified for a collection, and 304s when unchanged', async () => {
    const first = await fetch(`${baseUrl}/pets`);
    const etag = first.headers.get('etag');
    const lastModified = first.headers.get('last-modified');
    expect(etag).toBeTruthy();
    expect(lastModified).toBeTruthy();

    const conditional = await fetch(`${baseUrl}/pets`, {
      headers: { 'If-None-Match': etag ?? '' },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');

    const byDate = await fetch(`${baseUrl}/pets`, {
      headers: { 'If-Modified-Since': lastModified ?? '' },
    });
    expect(byDate.status).toBe(304);
  });

  it('bumps the ETag and stops returning 304 once the collection changes', async () => {
    const first = await fetch(`${baseUrl}/pets`);
    const etag = first.headers.get('etag');

    await fetch(`${baseUrl}/pets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Whiskers', tag: 'cat' }),
    });

    const second = await fetch(`${baseUrl}/pets`, {
      headers: { 'If-None-Match': etag ?? '' },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).not.toBe(etag);
  });
});
