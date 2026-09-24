// @wc-ignore-file
/**
 * The controller as the #89 views use it: the timesheet it hands them,
 * progress while syncing, typed problems, and the settings, window,
 * reconnect and disconnect actions.
 */
import { describe, expect, it } from 'vitest';
import { USER, WORKSPACE } from '../fixtures/clockify/scenario.mjs';
import {
  createController,
  type SyncProgressState,
  type ViewState,
} from './controller.js';
import { APP, fakeStore } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { classify } from './problem.js';
import { ensureSchema } from './schema.js';
import type { PluginStore } from './store.js';
import { ProxyError } from './transport.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');

async function configured(lookbackDays = 30) {
  const proxy = fixtureProxy(NOW);
  const store = fakeStore({ proxy: proxy.request });
  const schema = await ensureSchema(store);
  const app = await store.getResource(APP);
  app.set(schema.settings.workspaceId, WORKSPACE.id);
  app.set(schema.settings.userId, USER.id);
  app.set(schema.settings.lookbackDays, lookbackDays);
  await app.save();

  return { proxy, store, schema };
}

async function ready(store: PluginStore, seen: ViewState[] = []) {
  const controller = createController(
    store,
    s => seen.push(s),
    () => NOW,
  );
  const { syncing } = await controller.load();
  await syncing;

  return controller;
}

describe('classify', () => {
  const err = (status: number, retryAfter?: string) =>
    new ProxyError('/api/v1/x', status, { message: 'm' }, retryAfter);

  it('maps statuses and relay failures to the banner kinds', () => {
    expect(classify(err(401))).toMatchObject({
      kind: 'reauth',
      detail: 'HTTP 401 on GET /api/v1/x "m"',
    });
    expect(classify(err(403)).kind).toBe('forbidden');
    expect(classify(err(500)).kind).toBe('other');
    expect(classify(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(
      classify(new Error('Clockify /x returned more than 200 pages')).kind,
    ).toBe('too-many');
    expect(
      classify(
        new Error(
          'The integration proxy refused this connection (unknown_connection). Connect again.',
        ),
      ).kind,
    ).toBe('reauth');
    expect(classify(new Error('Simulated write failure')).kind).toBe('other');
    expect(
      classify(
        new Error(
          'The integration proxy refused the request (capability_expired).',
        ),
      ).kind,
    ).toBe('reauth');
    expect(
      classify(Object.assign(new Error('refused'), { code: 'forbidden' })).kind,
    ).toBe('forbidden');
    expect(
      classify(
        new Error('The integration proxy refused the request (bad_signature).'),
      ).kind,
    ).toBe('other');
  });

  it('reads retry-after as seconds or a date, else 60', () => {
    expect(classify(err(429, '30')).retryAfterSeconds).toBe(30);
    expect(
      classify(err(429, new Date(NOW + 90_000).toUTCString()), NOW)
        .retryAfterSeconds,
    ).toBe(90);
    expect(classify(err(429)).retryAfterSeconds).toBe(60);
  });
});

describe('controller for the timesheet views', () => {
  it('reads the mirror before the first sync, then reports fetch and save progress', async () => {
    const { store } = await configured();
    const seen: ViewState[] = [];
    const controller = await ready(store, seen);

    const progress = seen
      .filter(s => s.kind === 'syncing' && s.progress)
      .map(s => (s as { progress: SyncProgressState }).progress);
    expect(progress[0]).toEqual({ phase: 'fetch', page: 1 });
    expect(progress.at(-1)).toEqual({ phase: 'save', done: 2, total: 3 });

    const sheet = controller.sheet()!;
    expect(sheet.entries).toHaveLength(3);
    expect(sheet.entries[0].project?.color).toBe('#0B8A8A');
    expect(sheet.running).toBe(1);
    expect(sheet.window).toEqual({ from: NOW - 30 * 86_400_000, to: NOW });
  });

  it('keeps showing imported entries when the host has no relay (frame K)', async () => {
    const { store } = await configured();
    await ready(store);
    const offline = createController({ ...store, proxy: undefined }, () => {});

    await offline.load();

    expect(offline.state().kind).toBe('no-proxy');
    // No settings are known without a connection: every entry shows.
    expect(offline.sheet()!.entries).toHaveLength(3);
  });

  it('types a 401 as reauth and a 429 with its retry-after', async () => {
    const { store, proxy } = await configured();
    const controller = await ready(store);

    proxy.fixture.state.failures = { count: 1, status: 401 };
    const failed = await controller.sync();
    expect(failed).toMatchObject({
      kind: 'ready',
      last: { ok: false, problem: { kind: 'reauth' } },
    });
    // The last good copy stays on screen.
    expect(controller.sheet()!.entries).toHaveLength(3);

    proxy.fixture.state.failures = {
      count: 1,
      status: 429,
      retryAfter: '30',
    } as typeof proxy.fixture.state.failures;
    expect(await controller.sync()).toMatchObject({
      last: {
        ok: false,
        problem: { kind: 'rate-limited', retryAfterSeconds: 30 },
      },
    });
  });

  it('cancels the settings form back to ready without saving', async () => {
    const { store } = await configured();
    const controller = await ready(store);
    const writes = store.writes.length;

    expect((await controller.openSettings()).kind).toBe('setup');
    expect(controller.cancelSettings()).toMatchObject({
      kind: 'ready',
      settings: { lookbackDays: 30 },
    });
    expect(store.writes.length).toBe(writes);
  });

  it('switches the window and imports again (frames I and J)', async () => {
    const { store, schema } = await configured(7);
    const controller = await ready(store);
    expect(controller.sheet()!.entries).toHaveLength(2);

    const after = await controller.setLookback(30);

    expect(after).toMatchObject({
      kind: 'ready',
      settings: { lookbackDays: 30 },
      last: { ok: true },
    });
    expect(store.resources.get(APP)![schema.settings.lookbackDays]).toBe(30);
    expect(controller.sheet()!.entries).toHaveLength(3);
  });

  it('reconnects through the host and returns when cancelled', async () => {
    const { store } = await configured();
    const seen: ViewState[] = [];
    const controller = await ready(store, seen);

    const back = await controller.reconnect();

    expect(seen.at(-2)?.kind).toBe('connecting');
    expect(back.kind).toBe('ready');
  });

  it('offers Disconnect only when the host can forget the connection', async () => {
    const { store } = await configured();
    const controller = await ready(store);
    expect(controller.canDisconnect()).toBe(false);
    expect((await controller.disconnect()).kind).toBe('ready');

    const forgotten: string[] = [];
    const withDisconnect = {
      ...store,
      proxy: {
        ...store.proxy!,
        disconnect: async ({ platform }: { platform: string }) => {
          forgotten.push(platform);
        },
      },
    };
    const other = await ready(withDisconnect);
    expect(other.canDisconnect()).toBe(true);
    expect((await other.disconnect()).kind).toBe('not-connected');
    expect(forgotten).toEqual(['clockify']);
  });
});
