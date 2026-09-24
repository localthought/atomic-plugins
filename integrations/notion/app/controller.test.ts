// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { createController, STALE_AFTER_MS } from './controller.js';
import { classifyFailure, parseRetryAfter } from './errors.js';
import { fakeStore, fixtureProxy } from './fakeStore.js';
import { RECORD_SHORTNAME } from './record.js';
import type { HostProxy } from './store.js';

const T0 = Date.parse('2026-09-24T12:00:00.000Z');

const setup = (
  scenario = 'default',
  proxyOverrides: Partial<HostProxy> = {},
) => {
  const proxy = { ...fixtureProxy('conn-1', { scenario }), ...proxyOverrides };
  const store = fakeStore({ proxy });
  let clock = T0;
  const states: string[] = [];
  const controller = createController(
    store,
    s => states.push(s.kind),
    () => clock,
  );

  return {
    proxy,
    store,
    controller,
    states,
    advance: (ms: number) => (clock += ms),
  };
};

describe('parseRetryAfter', () => {
  it('reads delay-seconds and HTTP dates', () => {
    expect(parseRetryAfter('120', T0)).toBe(T0 + 120_000);
    expect(parseRetryAfter('Thu, 24 Sep 2026 12:32:00 GMT', T0)).toBe(
      Date.parse('2026-09-24T12:32:00Z'),
    );
    // A date in the past means "now", not a negative wait.
    expect(parseRetryAfter('Thu, 24 Sep 2026 11:00:00 GMT', T0)).toBe(T0);
    expect(parseRetryAfter('soon', T0)).toBeUndefined();
    expect(parseRetryAfter(undefined, T0)).toBeUndefined();
  });
});

describe('classifyFailure', () => {
  const f = (status: number, retryAfter?: string) => ({
    status,
    method: 'POST',
    path: '/v1/search',
    at: T0,
    ...(retryAfter ? { retryAfter } : {}),
  });
  const failed = new Error('Read incomplete');

  it('treats any 401 as reauth, even when the sync finished', () => {
    expect(classifyFailure([f(401)], undefined, T0)?.kind).toBe('reauth');
  });

  it('treats a 403 as reauth only when the sync failed', () => {
    expect(classifyFailure([f(403)], undefined, T0)).toBeUndefined();
    expect(classifyFailure([f(403)], failed, T0)?.kind).toBe('reauth');
  });

  it('reads the retry time from a 429 in both forms', () => {
    expect(classifyFailure([f(429, '30')], failed, T0)).toMatchObject({
      kind: 'rate-limited',
      retryAt: T0 + 30_000,
    });
    expect(
      classifyFailure([f(429, 'Thu, 24 Sep 2026 12:32:00 GMT')], failed, T0),
    ).toMatchObject({
      kind: 'rate-limited',
      retryAt: Date.parse('2026-09-24T12:32:00Z'),
    });
  });

  it('puts status and path in the technical details, not the message', () => {
    const state = classifyFailure([f(502)], failed, T0);
    expect(state).toMatchObject({ kind: 'failed' });
    if (state?.kind !== 'failed') return;
    expect(state.message).not.toMatch(/\/v1\//);
    expect(state.technical).toMatch(/POST \/v1\/search → 502/);
  });

  it('says the relay did not answer when the relay call threw', () => {
    expect(classifyFailure([f(0)], failed, T0)).toMatchObject({
      kind: 'failed',
      title: 'Atomic couldn’t reach Notion',
    });
  });
});

describe('controller (N2)', () => {
  it('reports a host without the relay and fetches nothing', async () => {
    const { controller } = setup();
    const store = fakeStore();
    const bare = createController(store);
    expect((await bare.load()).kind).toBe('no-proxy');
    expect(controller.state().kind).toBe('loading');
  });

  it('asks to connect when there is no connection and nothing was imported', async () => {
    const { controller } = setup('default', { connections: async () => [] });
    expect((await controller.load()).kind).toBe('not-connected');
    const connecting = controller.connect();
    expect(controller.state().kind).toBe('connecting');
    expect((await connecting).kind).toBe('not-connected');
  });

  it('imports first (importing), then syncs over rows (syncing)', async () => {
    const { controller, states } = setup();
    const loaded = await controller.load();
    expect(loaded).toMatchObject({ kind: 'ready', connectionId: 'conn-1', rows: [] });
    expect(controller.isStale()).toBe(true);
    const first = await controller.sync();
    expect(first.kind).toBe('ready');
    expect(states).toContain('importing');
    if (first.kind !== 'ready') return;
    expect(first.rows.map(r => r.name).sort()).toEqual([
      'Launch plan',
      'Retrospective',
      'Write changelog',
    ]);
    expect(first.last).toMatchObject({ created: 3, at: T0 });
    states.length = 0;
    await controller.sync();
    expect(states[0]).toBe('syncing');
  });

  it('reports progress per data source while importing', async () => {
    const { store, proxy } = setup();
    const seen: string[] = [];
    const controller = createController(
      store,
      s => {
        if (s.kind === 'importing' && s.progress.length)
          seen.push(s.progress.map(p => `${p.title}:${p.phase}:${p.pages}`).join());
      },
      () => T0,
    );
    void proxy;
    await controller.load();
    await controller.sync();
    expect(seen).toEqual([
      'Roadmap:listing:0',
      'Roadmap:reading:2',
      'Roadmap:reading:3',
      'Roadmap:writing:3',
      'Roadmap:done:3',
    ]);
  });

  it('keeps the last sync across a reload, and only re-syncs when stale', async () => {
    const { store, controller, advance } = setup();
    await controller.load();
    await controller.sync();
    // The record is a JSON string property on the table resource.
    const property = [...store.resources].find(
      ([, p]) => p['https://atomicdata.dev/properties/shortname'] === RECORD_SHORTNAME,
    )![0];
    expect(
      typeof store.resources.get('atomic:table')![property],
    ).toBe('string');

    let clock = T0 + 5 * 60 * 1000;
    const reopened = createController(store, () => {}, () => clock);
    const state = await reopened.load();
    expect(state).toMatchObject({ kind: 'ready', last: { at: T0, created: 3 } });
    if (state.kind === 'ready') expect(state.rows).toHaveLength(3);
    expect(reopened.isStale()).toBe(false);
    clock = T0 + STALE_AFTER_MS + 1;
    expect(reopened.isStale()).toBe(true);
    void advance;
  });

  it('goes to no-databases when Notion shares nothing, and remembers it', async () => {
    const { store, controller } = setup('empty');
    await controller.load();
    expect((await controller.sync()).kind).toBe('no-databases');
    const reopened = createController(store, () => {}, () => T0);
    expect((await reopened.load()).kind).toBe('no-databases');
  });

  it('goes to reauth on 401 and keeps the rows', async () => {
    const { controller, proxy } = setup();
    await controller.load();
    await controller.sync();
    proxy.api.setScenario('unauthorized');
    const state = await controller.sync();
    expect(state.kind).toBe('reauth');
    if (state.kind === 'reauth') expect(state.rows).toHaveLength(3);
  });

  it('goes to reauth on load when the connection is gone but rows exist', async () => {
    const { store, controller } = setup();
    await controller.load();
    await controller.sync();
    store.proxy!.connections = async () => [];
    const reopened = createController(store, () => {}, () => T0);
    const state = await reopened.load();
    expect(state).toMatchObject({ kind: 'reauth' });
    if (state.kind === 'reauth') expect(state.rows).toHaveLength(3);
  });

  it('goes to rate-limited with the retry time on a 429', async () => {
    const { controller } = setup('rate-limited');
    await controller.load();
    const state = await controller.sync();
    expect(state).toMatchObject({ kind: 'rate-limited', retryAt: T0 + 120_000 });
  });

  it('goes to failed with plain words on a 502', async () => {
    const { controller } = setup('bad-gateway');
    await controller.load();
    const state = await controller.sync();
    expect(state).toMatchObject({ kind: 'failed' });
    if (state.kind === 'failed') {
      expect(state.message).toMatch(/502/);
      expect(state.technical).toMatch(/\/v1\/search/);
    }
  });

  it('goes to failed when the relay itself throws', async () => {
    const { controller } = setup('default', {
      request: async () => {
        throw new Error('relay unavailable');
      },
    });
    await controller.load();
    expect(await controller.sync()).toMatchObject({
      kind: 'failed',
      title: 'Atomic couldn’t reach Notion',
    });
  });

  it('marks rows a later sync changed', async () => {
    const { controller, proxy } = setup();
    await controller.load();
    await controller.sync();
    proxy.api.setScenario('two-sources');
    const state = await controller.sync();
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') expect(state.changed).toHaveLength(2);
  });

  it('never runs two syncs at once', async () => {
    const { controller, proxy } = setup();
    await controller.load();
    const a = controller.sync();
    const b = controller.sync();
    await Promise.all([a, b]);
    expect(
      proxy.calls.filter(c => c.path === '/v1/search'),
    ).toHaveLength(1);
  });
});
