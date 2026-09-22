import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorageAdapter } from '../../src/sync/file-storage.js';

const RESOURCE = '/calendars/{calendarId}/events';

describe('FileStorageAdapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reflector-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips records and lists them', async () => {
    const store = new FileStorageAdapter(dir, 'primary');
    await store.put(RESOURCE, 'a1', { id: 'a1', summary: 'One' });
    await store.put(RESOURCE, 'b2', { id: 'b2', summary: 'Two' });

    expect(await store.get(RESOURCE, 'a1')).toEqual({ id: 'a1', summary: 'One' });
    const listed = await store.list(RESOURCE);
    expect(listed).toHaveLength(2);

    await store.delete(RESOURCE, 'a1');
    expect(await store.get(RESOURCE, 'a1')).toBeUndefined();
    expect(await store.list(RESOURCE)).toHaveLength(1);
  });

  it('isolates records by namespace so calendars do not collide', async () => {
    const primary = new FileStorageAdapter(dir, 'primary');
    const work = new FileStorageAdapter(dir, 'work@example.com');
    await primary.put(RESOURCE, 'x', { id: 'x', cal: 'primary' });
    await work.put(RESOURCE, 'x', { id: 'x', cal: 'work' });

    expect(await primary.get(RESOURCE, 'x')).toEqual({ id: 'x', cal: 'primary' });
    expect(await work.get(RESOURCE, 'x')).toEqual({ id: 'x', cal: 'work' });
  });

  it('returns an empty list for an unknown resource', async () => {
    const store = new FileStorageAdapter(dir, 'primary');
    expect(await store.list(RESOURCE)).toEqual([]);
  });
});
