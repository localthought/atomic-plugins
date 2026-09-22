import { describe, expect, it } from 'vitest';
import {
  RemoteStorageAdapter,
  RemoteStorageBackend,
} from '../../../src/remotestorage/adapter.js';

const EVENTS = '/calendars/{calendarId}/events';

interface RemoteStorageMock {
  fetchImpl: typeof fetch;
  docs: Map<string, string>;
}

/**
 * A tiny in-memory stand-in for a remoteStorage server, keyed by URL path:
 * PUT/GET/DELETE a document, and GET a path ending in `/` for a folder listing
 * of its immediate children.
 */
function makeRemoteStorageMock(): RemoteStorageMock {
  const docs = new Map<string, string>();

  const listing = (folderPath: string): Response => {
    const items: Record<string, unknown> = {};
    for (const path of docs.keys()) {
      if (!path.startsWith(folderPath) || path === folderPath) {
        continue;
      }
      const remainder = path.slice(folderPath.length);
      const slash = remainder.indexOf('/');
      if (slash === -1) {
        items[remainder] = { ETag: '"x"' };
      } else {
        items[`${remainder.slice(0, slash)}/`] = { ETag: '"x"' };
      }
    }
    return new Response(JSON.stringify({ '@context': 'x', items }), {
      status: 200,
      headers: { 'Content-Type': 'application/ld+json' },
    });
  };

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';

    if (method === 'PUT') {
      docs.set(path, String(init?.body));
      return new Response(null, { status: 200, headers: { ETag: '"x"' } });
    }
    if (method === 'DELETE') {
      const existed = docs.delete(path);
      return new Response(null, { status: existed ? 200 : 404 });
    }
    if (path.endsWith('/')) {
      return listing(path);
    }
    const body = docs.get(path);
    if (body === undefined) {
      return new Response(null, { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, docs };
}

const BASE = 'https://storage.example/me/reflector';

describe('RemoteStorageAdapter', () => {
  it('puts, gets, lists and deletes records over the remoteStorage protocol', async () => {
    const { fetchImpl, docs } = makeRemoteStorageMock();
    const adapter = new RemoteStorageAdapter(BASE, fetchImpl, 'primary');

    // An empty (never-written) folder lists as no items.
    expect(await adapter.list(EVENTS)).toEqual([]);
    expect(await adapter.get(EVENTS, 'e1')).toBeUndefined();

    await adapter.put(EVENTS, 'e1', { id: 'e1', summary: 'One' });
    await adapter.put(EVENTS, 'e2', { id: 'e2', summary: 'Two' });

    // The resource path (with slashes and braces) is stored as one encoded segment.
    expect([...docs.keys()]).toContain(
      `/me/reflector/primary/${encodeURIComponent(EVENTS)}/e1`,
    );

    expect(await adapter.get(EVENTS, 'e1')).toMatchObject({ summary: 'One' });
    const listed = await adapter.list(EVENTS);
    expect(listed).toHaveLength(2);
    expect(listed.map((e) => e['summary']).sort()).toEqual(['One', 'Two']);

    await adapter.delete(EVENTS, 'e1');
    expect(await adapter.get(EVENTS, 'e1')).toBeUndefined();
    expect(await adapter.list(EVENTS)).toHaveLength(1);
    // Deleting a missing document is a no-op, not an error.
    await expect(adapter.delete(EVENTS, 'gone')).resolves.toBeUndefined();
  });
});

describe('RemoteStorageBackend', () => {
  it('enumerates every record across namespaces and resources', async () => {
    const { fetchImpl } = makeRemoteStorageMock();
    const backend = new RemoteStorageBackend(BASE, fetchImpl, 'me@storage.example');

    expect(backend.label).toBe('remoteStorage: me@storage.example');
    // Nothing stored yet.
    expect(await backend.enumerate()).toEqual([]);

    await backend
      .adapter('_account')
      .put('/users/me/calendarList', 'primary', { id: 'primary' });
    await backend.adapter('primary').put(EVENTS, 'e1', { id: 'e1', summary: 'One' });
    await backend.adapter('work').put(EVENTS, 'e9', { id: 'e9', summary: 'Nine' });

    const records = await backend.enumerate();
    expect(records).toHaveLength(3);
    // Namespace / resource / id are decoded back to their readable form.
    expect(records).toContainEqual({
      namespace: 'primary',
      resource: EVENTS,
      id: 'e1',
      value: { id: 'e1', summary: 'One' },
    });
    expect(records).toContainEqual({
      namespace: '_account',
      resource: '/users/me/calendarList',
      id: 'primary',
      value: { id: 'primary' },
    });
  });
});
