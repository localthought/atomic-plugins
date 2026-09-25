// @wc-ignore-file
import { describe as describePlatform } from 'vitest';
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createController, describe, type ViewState } from './controller.js';
import { fakeStore, ONTOLOGY, ROW_CLASS, TABLE } from './fakeStore.js';
import {
  DATATYPE,
  NAME,
  PARENT,
  PETS_DOCUMENT,
  PROPERTIES,
  RECOMMENDS,
  SHORTNAME,
  syncPets,
} from './sync.js';
import { relayTransport } from './transport.js';

const DT = 'https://atomicdata.dev/datatypes';
/** The demo provider on GitHub Pages, as the app's document names it. */
const UPSTREAM = (PETS_DOCUMENT as unknown as { servers: { url: string }[] })
  .servers[0].url;
/** Its base path, which the proxy wants kept in every request path. */
const BASE = new URL(UPSTREAM).pathname;
const transportFor = (store: ReturnType<typeof fakeStore>) =>
  relayTransport(
    store.proxy!,
    { platform: 'pets', connectionId: 'c1' },
    UPSTREAM,
  );

describePlatform('syncPets', () => {
  it('imports every page, typed, into the app table', async () => {
    const store = fakeStore();
    const summary = await syncPets(store, transportFor(store));
    expect(summary).toEqual({
      total: 5,
      added: 5,
      updated: 0,
      unchanged: 0,
      errors: [],
    });
    // Two pages: the second came from the provider's Link header, relayed
    // as a proxy path (with the API base path), never as an absolute URL.
    expect(store.calls.map(c => c.path)).toEqual([
      `${BASE}/pets`,
      `${BASE}/pets?page=2`,
    ]);
    expect(store.calls.every(c => c.connectionId === 'c1')).toBe(true);

    const props = Object.fromEntries(
      (store.resources.get(ONTOLOGY)![PROPERTIES] as string[]).map(s => {
        const p = store.resources.get(s)!;

        return [p[NAME], [p[SHORTNAME], p[DATATYPE], p[PARENT]]];
      }),
    );
    expect(props).toMatchObject({
      Id: ['id', `${DT}/integer`, ONTOLOGY],
      Age: ['age', `${DT}/integer`, ONTOLOGY],
      Vaccinated: ['vaccinated', `${DT}/boolean`, ONTOLOGY],
      Weight: ['weight', `${DT}/float`, ONTOLOGY],
      'Updated at': ['updated-at', `${DT}/timestamp`, ONTOLOGY],
      Species: ['species', `${DT}/string`, ONTOLOGY],
    });
    const klass = store.resources.get(ROW_CLASS)!;
    expect(klass[NAME]).toBe('Pet');
    expect((klass[RECOMMENDS] as string[])[0]).toBe(NAME);
    expect(klass[RECOMMENDS]).toHaveLength(7);
    expect(store.resources.get(TABLE)![NAME]).toBe('Pets');

    const rows = [...store.resources.values()].filter(r => r[PARENT] === TABLE);
    expect(rows.map(r => r[NAME]).sort()).toEqual(
      ['Bubbles', 'Nibbles', 'Rex', 'Tweety', 'Whiskers'].sort(),
    );
    const byName = (name: string) => rows.find(r => r[NAME] === name)!;
    const valueOf = (row: Record<string, unknown>, shortname: string) =>
      row[
        [...store.resources.entries()].find(
          ([, p]) => p[SHORTNAME] === shortname,
        )![0]
      ];
    expect(valueOf(byName('Rex'), 'age')).toBe(1);
    expect(valueOf(byName('Rex'), 'vaccinated')).toBe(true);
    expect(valueOf(byName('Whiskers'), 'weight')).toBe(1.5);
    expect(valueOf(byName('Rex'), 'updated-at')).toBe(
      Date.parse('2026-09-09T00:00:00Z'),
    );
  });

  it('writes nothing on an unchanged re-sync', async () => {
    const store = fakeStore();
    await syncPets(store, transportFor(store));
    const before = store.writes.length;
    expect(await syncPets(store, transportFor(store))).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 5,
    });
    expect(store.writes.length).toBe(before);
  });
});

describePlatform('relayTransport', () => {
  it('refuses URLs outside the upstream', async () => {
    const store = fakeStore();
    const transport = relayTransport(
      store.proxy!,
      { platform: 'pets', connectionId: 'c1' },
      'https://pets.example/v1',
    );
    for (const url of [
      'https://evil.example/v1/pets',
      'https://pets.example/v10/pets',
      'https://pets.example/pets',
    ])
      await expect(
        transport({ url: new URL(url), method: 'GET', headers: {} }),
      ).rejects.toThrow('outside');
    await transport({
      url: new URL('https://pets.example/v1/pets?page=2'),
      method: 'GET',
      headers: {},
    });
    // The proxy matches catalog paths after the server's base path, so the
    // base path is kept; only the origin is dropped.
    expect(store.calls.at(-1)!.path).toBe('/v1/pets?page=2');
  });

  it('asks for exactly the path the proxy catalog allows for the demo provider', async () => {
    // The proxy's `pets` platform is overlays/pets-demo/1.0.0/openapi.json
    // (overlays/catalog.json); the app bundles the same document.
    const published = JSON.parse(
      readFileSync(
        new URL(
          '../../../overlays/pets-demo/1.0.0/openapi.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(PETS_DOCUMENT).toEqual(published);
    expect(UPSTREAM).toBe(
      'https://ontola.github.io/atomic-plugins/overlays/pets-demo/1.0.0/api',
    );
    // What GitHub Pages serves at that path: the demo provider's one page.
    const served = JSON.parse(
      readFileSync(
        new URL('../../../overlays/pets-demo/1.0.0/api/pets', import.meta.url),
        'utf8',
      ),
    );
    const store = fakeStore();
    await transportFor(store)({
      url: new URL(`${UPSTREAM}/pets`),
      method: 'GET',
      headers: {},
    });
    expect(store.calls.at(-1)!.path).toBe(
      '/atomic-plugins/overlays/pets-demo/1.0.0/api/pets',
    );
    // The same five pets as the e2e fixture, in one page (no Link header).
    const { pets } = await import('../fixtures/pets/scenario.mjs');
    expect(served).toEqual(pets);
  });

  it("throws the integration proxy's own refusals instead of passing them on as Pets' answer", async () => {
    const answer = (status: number, body: unknown) =>
      relayTransport(
        {
          request: async () => ({ status, headers: {}, body }),
          connections: async () => [],
          connect: async () => ({ status: 'cancelled' as const }),
        },
        { platform: 'pets', connectionId: 'c1' },
        'https://pets.example/v1',
      )({
        url: new URL('https://pets.example/v1/pets'),
        method: 'GET',
        headers: {},
      });
    await expect(
      answer(403, { error: 'not_delegated', message: 'no delegation' }),
    ).rejects.toThrow(
      'The integration proxy refused this connection (not_delegated: no delegation). Connect again.',
    );
    await expect(answer(401, { error: 'stale_timestamp' })).rejects.toThrow(
      'The integration proxy refused the request (stale_timestamp).',
    );
    // A provider's own error body is Pets' answer, passed on as is.
    expect((await answer(404, { error: 'Not found' })).status).toBe(404);
  });
});

describePlatform('controller', () => {
  const run = async (store: ReturnType<typeof fakeStore>) => {
    const states: ViewState[] = [];
    const controller = createController(store, s => states.push(s));
    const { syncing } = await controller.load();
    await syncing;

    return { controller, states };
  };

  it('syncs once on load when the app has a connection', async () => {
    const { states } = await run(fakeStore());
    expect(states.map(s => s.kind)).toEqual(['ready', 'syncing', 'synced']);
    expect(describe(states.at(-1)!)).toMatch(
      /^Last synced .*: 5 pets \(5 added, 0 updated, 0 unchanged\)\.$/,
    );
  });

  it('offers to connect, and says so when the host has no relay', async () => {
    expect((await run(fakeStore({ connected: false }))).states).toEqual([
      { kind: 'disconnected' },
    ]);
    expect((await run(fakeStore({ relay: false }))).states).toEqual([
      { kind: 'no-relay' },
    ]);
  });
});
