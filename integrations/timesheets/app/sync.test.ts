// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  clockifyEntries,
  clockifyFixture,
  USER,
  WORKSPACE,
} from '../../localthought/mock-clockify.mjs';
import type { ConnectionReference } from './config.js';
import { fakeStore, PARENT, IS_A } from './fakeStore.js';
import { NAME, row, TIME_ENTRY_CLASS } from './ontology.js';
import type { HostProxyRequest } from './store.js';
import { syncClockify } from './sync.js';
import { hostTransport, type ProxyTransport } from './transport.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');

const reference: ConnectionReference = {
  platform: 'clockify',
  connectionId: 'conn-1',
  workspaceId: WORKSPACE.id,
  userId: USER.id,
  lookbackDays: 7,
};

/** The shared mock proxy's Clockify fixture, reached the way a host relay would. */
function fixtureProxy() {
  const fixture = clockifyFixture();
  // Pin the fixture's relative timestamps so the window is deterministic.
  fixture.state.entries = clockifyEntries(NOW);
  const seen: HostProxyRequest[] = [];

  const request = async (req: HostProxyRequest) => {
    seen.push(req);
    const url = new URL(
      `/proxy/${req.platform}${req.path}`,
      'http://proxy.test',
    );
    for (const [k, v] of Object.entries(req.query ?? {}))
      url.searchParams.set(k, v);

    return fixture.request('GET', url);
  };

  return { fixture, seen, request };
}

describe('syncClockify against the shared Clockify mock', () => {
  it('imports completed entries in the window, skipping running timers and breaks', async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({
      table: 'did:ad:table',
      rowClass: 'did:ad:class',
      proxy: proxy.request,
    });
    const transport = hostTransport(store, reference)!;

    const result = await syncClockify(store, transport, reference, NOW);

    expect(result).toMatchObject({ created: 2, updated: 0, unchanged: 0 });
    const rows = [...store.resources.values()].filter(
      r => r[PARENT] === 'did:ad:table',
    );
    expect(rows.map(r => r[row.entryId]).sort()).toEqual([
      'entry-1',
      'entry-2',
    ]);
    const first = rows.find(r => r[row.entryId] === 'entry-1')!;
    expect(first[NAME]).toBe('Fix plugin source loading');
    expect(first[IS_A]).toEqual(['did:ad:class']);
    expect(first[row.start]).toBe(NOW - 86_400_000 - 4 * 3_600_000);
    expect(first[row.end]).toBe(NOW - 86_400_000 - 2 * 3_600_000);
    expect(first[row.projectId]).toBe('cccccccccccccccccccccccc');
    // The mock serves no projects/users lists: names are unavailable, not fatal.
    expect(first[row.projectName]).toBeUndefined();
    expect(result.warnings).toHaveLength(2);
    // Every call carried the reference, and the 7-day window as the LocalThought path computes it.
    expect(
      proxy.seen.every(
        r => r.connectionId === 'conn-1' && r.platform === 'clockify',
      ),
    ).toBe(true);
    expect(proxy.fixture.state.requests[0]).toBe(
      `GET /proxy/clockify/api/v1/workspaces/${WORKSPACE.id}/user/${USER.id}/time-entries` +
        '?start=2026-09-16T12%3A00%3A00Z&end=2026-09-23T12%3A00%3A00Z&page=1&page-size=50',
    );
  });

  it('is idempotent: a second run creates nothing and rewrites nothing', async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({ table: 'did:ad:table', proxy: proxy.request });
    const transport = hostTransport(store, reference)!;
    await syncClockify(store, transport, reference, NOW);
    const writes = store.writes.length;

    const again = await syncClockify(store, transport, reference, NOW);

    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(store.writes.length).toBe(writes);
  });

  it('updates a changed entry in place and keeps a local-only property', async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({ table: 'did:ad:table', proxy: proxy.request });
    const transport = hostTransport(store, reference)!;
    await syncClockify(store, transport, reference, NOW);
    const [subject] = await store.query({
      property: row.entryId,
      value: 'entry-2',
    });
    store.resources.get(subject)!['did:ad:local-note'] = 'mine';
    proxy.fixture.state.entries.find(
      (e: { id: string }) => e.id === 'entry-2',
    ).description = 'Renamed';

    const again = await syncClockify(store, transport, reference, NOW);

    expect(again).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(store.resources.get(subject)![NAME]).toBe('Renamed');
    expect(store.resources.get(subject)!['did:ad:local-note']).toBe('mine');
  });

  it("does not adopt another installation's row with the same Clockify id", async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({ table: 'did:ad:table', proxy: proxy.request });
    store.resources.set('did:ad:elsewhere', {
      [PARENT]: 'did:ad:other-table',
      [row.entryId]: 'entry-1',
    });
    const transport = hostTransport(store, reference)!;

    const result = await syncClockify(store, transport, reference, NOW);

    expect(result.created).toBe(2);
    expect(store.resources.get('did:ad:elsewhere')).toEqual({
      [PARENT]: 'did:ad:other-table',
      [row.entryId]: 'entry-1',
    });
  });

  it('writes under the app with the fallback class when the host names no table', async () => {
    const proxy = fixtureProxy();
    const store = fakeStore({ proxy: proxy.request });

    await syncClockify(store, hostTransport(store, reference)!, reference, NOW);

    const rows = [...store.resources.values()].filter(
      r => r[PARENT] === 'did:ad:app',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0][IS_A]).toEqual([TIME_ENTRY_CLASS]);
  });

  it('surfaces a failing time-entries request and writes nothing', async () => {
    const store = fakeStore({ table: 'did:ad:table' });
    const transport: ProxyTransport = {
      request: async () => ({
        status: 401,
        body: { message: 'Reconnect Clockify' },
      }),
    };

    await expect(
      syncClockify(store, transport, reference, NOW),
    ).rejects.toThrow(/failed with 401: Reconnect Clockify/);
    expect(store.writes).toEqual([]);
  });

  it('pages until a short page', async () => {
    const store = fakeStore({ table: 'did:ad:table' });
    const entry = (i: number) => ({
      id: `e${i}`,
      description: `Entry ${i}`,
      type: 'REGULAR',
      timeInterval: {
        start: new Date(NOW - 3_600_000 - i * 1000).toISOString(),
        end: new Date(NOW - i * 1000).toISOString(),
      },
    });
    const pages: string[] = [];
    const transport: ProxyTransport = {
      async request(path, query) {
        if (!path.endsWith('/time-entries')) return { status: 404, body: {} };
        pages.push(query!.page);
        const page = Number(query!.page);
        const count = page === 1 ? 50 : 3;

        return {
          status: 200,
          body: Array.from({ length: count }, (_, i) =>
            entry((page - 1) * 50 + i),
          ),
        };
      },
    };

    const result = await syncClockify(store, transport, reference, NOW);

    expect(pages).toEqual(['1', '2']);
    expect(result.created).toBe(53);
  });
});
