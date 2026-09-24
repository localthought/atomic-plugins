// @wc-ignore-file
/**
 * Moneybird read-only contacts (atomic-plugins#102) against the SYNTHETIC
 * fixture in ../fixtures/moneybird/ (not a recording; see synthetic.mjs).
 *
 *   browser/node_modules/.bin/vitest run --config integrations/money/vitest.config.ts
 */
import { describe, expect, it } from 'vitest';
import { contacts } from '../fixtures/moneybird/synthetic.mjs';
import { PAGE_CAP } from '../fixtures/moneybird/scenario.mjs';
import { CONTACT_FIELDS, contactName, contactValues } from './contacts.js';
import { createController, describe as say } from './controller.js';
import { APP, fakeStore, TABLE } from './fakeStore.js';
import {
  nextLink,
  readAdministrations,
  readContacts,
  type MoneybirdGet,
} from './read.js';
import { NAME, PARENT, PROPERTIES, relayGet, syncContacts } from './sync.js';
import type { PluginStore } from './store.js';

const A = '100000000000000001';
const B = '100000000000000002';
const connection = { platform: 'moneybird', connectionId: 'c1' };
const get = (store: PluginStore): MoneybirdGet =>
  relayGet(store.proxy!, connection);

const rows = (store: ReturnType<typeof fakeStore>) =>
  [...store.resources.entries()].filter(([, p]) => p[PARENT] === TABLE);

const shortnameOf = (store: ReturnType<typeof fakeStore>) => {
  const ontology = store.resources.get('did:ad:ontology')!;
  const byShortname = new Map<string, string>();

  for (const subject of ontology[PROPERTIES] as string[])
    byShortname.set(
      store.resources.get(subject)![
        'https://atomicdata.dev/properties/shortname'
      ] as string,
      subject,
    );

  return byShortname;
};

describe('reading', () => {
  it('lists administrations with string identifiers', async () => {
    const store = fakeStore();
    expect(await readAdministrations(get(store))).toEqual([
      { id: A, name: 'Synthetic Studio B.V.', currency: 'EUR' },
      { id: B, name: 'Synthetic Side Project', currency: 'EUR' },
    ]);
  });

  it('follows Link rel="next" across pages, archived contacts included', async () => {
    const store = fakeStore();
    const read = await readContacts(get(store), A);
    expect(read.map(c => c.id)).toEqual(contacts[A].map(c => c.id));
    const paths = store.calls.map(c => c.path);
    expect(paths).toHaveLength(Math.ceil(contacts[A].length / PAGE_CAP));
    expect(paths[0]).toBe(
      `/${A}/contacts.json?per_page=100&include_archived=true`,
    );
    expect(paths[1]).toContain('page=2');
  });

  it('refuses a next link outside the collection', async () => {
    const hostile: MoneybirdGet = async () => ({
      status: 200,
      headers: { link: '<https://evil.example/steal>; rel="next"' },
      body: [],
    });
    await expect(readContacts(hostile, A)).rejects.toThrow(/Refusing/);
    const sideways: MoneybirdGet = async () => ({
      status: 200,
      headers: {
        link: `<https://moneybird.com/api/v2/${B}/contacts.json?page=2>; rel="next"`,
      },
      body: [],
    });
    await expect(readContacts(sideways, A)).rejects.toThrow(/Refusing/);
  });

  it('stops a provider that never stops paging', async () => {
    const loop: MoneybirdGet = async path => ({
      status: 200,
      headers: {
        link: `<https://moneybird.com/api/v2${path.split('?')[0]}?page=9>; rel="next"`,
      },
      body: [],
    });
    await expect(readContacts(loop, A, { maxPages: 3 })).rejects.toThrow(
      /Stopped after 3 pages/,
    );
  });

  it('parses Link headers with several relations', () => {
    expect(
      nextLink(
        '<https://x/a?page=1>; rel="prev", <https://x/a?page=3>; rel="next"',
      ),
    ).toBe('https://x/a?page=3');
    expect(nextLink('<https://x/a?page=1>; rel="prev"')).toBeUndefined();
    expect(nextLink(undefined)).toBeUndefined();
  });

  it('maps only the declared fields, typed, and never writes null', () => {
    const [bakery, anna, , archived] = contacts[A];
    expect(contactName(bakery)).toBe('Fictief Bakkerij B.V.');
    expect(contactName(anna)).toBe('Anna Voorbeeld');
    const values = contactValues(archived);
    expect(values['moneybird-archived']).toBe(true);
    expect(values['moneybird-version']).toBe(archived.version);
    expect(values['moneybird-administration-id']).toBe(A);
    expect(values).not.toHaveProperty('moneybird-company-name', null);
    expect(
      Object.keys(values).every(k =>
        CONTACT_FIELDS.some(f => f.shortname === k),
      ),
    ).toBe(true);
  });
});

describe('importing', () => {
  it('creates typed rows once, and a repeat import writes nothing', async () => {
    const store = fakeStore({ outage: false });
    const first = await syncContacts(store, get(store), A);
    expect(first).toEqual({ total: 5, added: 5, updated: 0, unchanged: 0 });
    expect(rows(store)).toHaveLength(5);
    expect(
      rows(store)
        .map(([, p]) => p[NAME])
        .sort(),
    ).toContain('Testcafé & Co');
    const properties = shortnameOf(store);
    const datatype = (s: string) =>
      store.resources.get(properties.get(s)!)![
        'https://atomicdata.dev/properties/datatype'
      ];
    expect(datatype('moneybird-archived')).toBe(
      'https://atomicdata.dev/datatypes/boolean',
    );
    expect(datatype('moneybird-version')).toBe(
      'https://atomicdata.dev/datatypes/integer',
    );

    const writes = store.writes.length;
    const again = await syncContacts(store, get(store), A);
    expect(again).toEqual({ total: 5, added: 0, updated: 0, unchanged: 5 });
    expect(store.writes.length).toBe(writes);
    expect(rows(store)).toHaveLength(5);
  });

  it('identifies rows by administration and id, so two administrations do not collide', async () => {
    const store = fakeStore({ outage: false });
    await syncContacts(store, get(store), A);
    await syncContacts(store, get(store), B);
    expect(rows(store)).toHaveLength(6);
  });

  it('updates a contact that changed on Moneybird in place', async () => {
    const store = fakeStore({ outage: false });
    await syncContacts(store, get(store), A);
    const original = contacts[A][1];
    const changed = {
      ...original,
      city: 'Haarlem',
      version: original.version + 1,
    };
    const read = async () =>
      contacts[A].map(c => (c.id === original.id ? changed : c));
    expect(await syncContacts(store, get(store), A, read)).toEqual({
      total: 5,
      added: 0,
      updated: 1,
      unchanged: 4,
    });
    expect(rows(store)).toHaveLength(5);
  });

  it('writes nothing when a refresh fails part-way', async () => {
    const store = fakeStore();
    await syncContacts(store, get(store), A);
    const before = structuredClone([...store.resources]);
    const writes = store.writes.length;
    // The fixture's second read fails on page 2 (synthetic outage).
    await expect(syncContacts(store, get(store), A)).rejects.toThrow(/503/);
    expect(store.writes.length).toBe(writes);
    expect([...store.resources]).toEqual(before);
  });
});

describe('controller', () => {
  it('connects, asks for an administration, imports, and keeps rows when a refresh fails', async () => {
    const store = fakeStore();
    const states: string[] = [];
    const controller = createController(store, s => states.push(s.kind));
    await controller.load();
    const choosing = controller.state();
    expect(choosing.kind).toBe('choosing');
    expect(say(choosing)).toMatch(/Choose the Moneybird administration/);

    await controller.select(A);
    expect(controller.state().kind).toBe('synced');
    expect(rows(store)).toHaveLength(5);
    const stored = Object.values(store.resources.get(APP)!);
    expect(stored).toContain(A);

    // A new view (reload) finds the stored administration and syncs; the
    // fixture's second read fails, and the rows stay.
    const reloaded = createController(store, () => {});
    await (
      await reloaded.load()
    ).syncing;
    expect(reloaded.state().kind).toBe('error');
    expect(say(reloaded.state())).toMatch(/503.*kept/);
    expect(rows(store)).toHaveLength(5);

    await reloaded.sync();
    expect(reloaded.state().kind).toBe('synced');
    expect(rows(store)).toHaveLength(5);
  });

  it('says so when the host has no relay or no connection', async () => {
    const noRelay = createController(fakeStore({ relay: false }), () => {});
    await noRelay.load();
    expect(noRelay.state().kind).toBe('no-relay');
    const offline = createController(fakeStore({ connected: false }), () => {});
    await offline.load();
    expect(offline.state().kind).toBe('disconnected');
  });
});
