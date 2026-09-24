// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { USER, WORKSPACE } from '../fixtures/clockify/scenario.mjs';
import { readSettings } from './config.js';
import { createController, describe as describeState } from './controller.js';
import { APP, fakeStore } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { ensureSchema } from './schema.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');

describe('readSettings', () => {
  const schema = {
    settings: { workspaceId: 'w', userId: 'u', lookbackDays: 'l' },
  };
  const get = (values: Record<string, unknown>) => (p: string) =>
    values[p] as string | number | undefined;

  it('accepts 7 or 30 days and nothing else', () => {
    expect(readSettings(get({ w: 'ws', u: 'me', l: 30 }), schema)).toEqual({
      ok: true,
      settings: { workspaceId: 'ws', userId: 'me', lookbackDays: 30 },
    });
    expect(readSettings(get({ w: 'ws', u: 'me', l: 90 }), schema)).toEqual({
      ok: false,
      missing: ['lookbackDays'],
      partial: { workspaceId: 'ws', userId: 'me' },
    });
  });

  it('names every missing field, and reads nothing when no Property exists yet', () => {
    expect(readSettings(get({ w: 'ws' }), { settings: {} })).toEqual({
      ok: false,
      missing: ['workspaceId', 'userId', 'lookbackDays'],
      partial: {},
    });
  });
});

describe('controller', () => {
  it('says so when the host offers no proxy relay, instead of falling back to a credential', async () => {
    const controller = createController(fakeStore());

    await controller.load();

    expect(controller.state().kind).toBe('no-proxy');
    expect(describeState(controller.state())).toMatch(
      /cannot reach the integration proxy/,
    );
  });

  it('asks to connect when the host holds no Clockify connection for this app', async () => {
    const proxy = fixtureProxy(NOW);
    const controller = createController(
      fakeStore({ proxy: proxy.request, connections: [] }),
    );

    await controller.load();

    expect(controller.state().kind).toBe('not-connected');
    expect(proxy.seen).toEqual([]);
    expect(await controller.connect()).toEqual({ kind: 'not-connected' });
  });

  it('sets up: offers the account and workspaces, stores only ids, then imports', async () => {
    const proxy = fixtureProxy(NOW);
    const store = fakeStore({ proxy: proxy.request });
    const kinds: string[] = [];
    const controller = createController(
      store,
      s => kinds.push(s.kind),
      () => NOW,
    );

    await controller.load();
    const setup = controller.state();
    expect(setup).toMatchObject({
      kind: 'setup',
      options: {
        user: { id: USER.id },
        workspaces: [{ id: WORKSPACE.id }, { name: 'Personal' }],
      },
    });
    // Nothing is written before the person chooses.
    expect(store.writes).toEqual([]);

    const done = await controller.saveSettings({
      workspaceId: WORKSPACE.id,
      lookbackDays: 7,
    });

    expect(describeState(done)).toMatch(
      /2 created, 0 updated, 0 unchanged, last 7 days\.$/,
    );
    const schema = await ensureSchema(store);
    const app = store.resources.get(APP)!;
    expect(readSettings(p => app[p], schema)).toEqual({
      ok: true,
      settings: {
        workspaceId: WORKSPACE.id,
        userId: USER.id,
        lookbackDays: 7,
      },
    });
    // No connection id, code or token on the App: only the three settings
    // and the pointer to the observation log.
    expect(Object.keys(app).sort()).toEqual(
      [...Object.values(schema.settings), schema.log.log].sort(),
    );
    expect(kinds).toEqual([
      'setup',
      'setup',
      'setup',
      'ready',
      'syncing',
      'ready',
    ]);
  });

  it('picks up settings that arrive after open (a stale local copy of the App)', async () => {
    const store = fakeStore({ proxy: fixtureProxy(NOW).request });
    const schema = await ensureSchema(store);
    const controller = createController(
      store,
      () => {},
      () => NOW,
    );
    await controller.load();
    expect(controller.state().kind).toBe('setup');
    // Nothing to do yet: the change was not the settings.
    expect(await controller.appChanged()).toEqual({});

    Object.assign(store.resources.get(APP)!, {
      [schema.settings.workspaceId]: WORKSPACE.id,
      [schema.settings.userId]: USER.id,
      [schema.settings.lookbackDays]: 7,
    });
    const { syncing } = await controller.appChanged();

    expect(describeState(await syncing!)).toMatch(/2 created/);
    // In any other state a change of the App does nothing.
    expect(await controller.appChanged()).toEqual({});
  });

  it('refuses a workspace that was not offered', async () => {
    const store = fakeStore({ proxy: fixtureProxy(NOW).request });
    const controller = createController(store);
    await controller.load();

    const state = await controller.saveSettings({
      workspaceId: 'not-mine',
      lookbackDays: 7,
    });

    expect(describeState(state)).toBe(
      'Setup failed: Choose one of the listed workspaces',
    );
  });

  it('reports setup options it cannot read, and retries from settings', async () => {
    let status = 401;
    const proxy = fixtureProxy(NOW);
    const store = fakeStore({
      proxy: async r =>
        status === 200 ? proxy.request(r) : { status, body: { message: 'no' } },
    });
    const controller = createController(store);

    await controller.load();
    expect(describeState(controller.state())).toBe(
      'Setup failed: Clockify request /api/v1/user failed with 401: no',
    );

    status = 200;
    expect((await controller.openSettings()).kind).toBe('setup');
    expect(controller.state()).toMatchObject({ options: { user: USER } });
  });

  it('syncs on open once configured, and keeps rows through a failed sync', async () => {
    const proxy = fixtureProxy(NOW);
    const store = fakeStore({ proxy: proxy.request });
    const first = createController(
      store,
      () => {},
      () => NOW,
    );
    await first.load();
    await first.saveSettings({ workspaceId: WORKSPACE.id, lookbackDays: 30 });

    // A reload: a fresh controller finds the settings and syncs by itself.
    const reloaded = createController(
      store,
      () => {},
      () => NOW,
    );
    const { syncing } = await reloaded.load();
    expect(describeState(await syncing!)).toMatch(
      /0 created, 0 updated, 3 unchanged, last 30 days\./,
    );

    proxy.fixture.state.failures = { count: 1, status: 502 };
    const rows = store.resources.size;
    const failed = await reloaded.sync();
    expect(describeState(failed)).toMatch(
      /^Import failed: .*failed with 502: Simulated Clockify failure\. Rows already in the table are kept\.$/,
    );
    expect(store.resources.size).toBe(rows);
    expect(describeState(await reloaded.sync())).toMatch(/3 unchanged/);
  });

  it('cannot run without a table to import into', async () => {
    const controller = createController(
      fakeStore({ proxy: fixtureProxy(NOW).request, withTable: false }),
    );

    await controller.load();

    expect(describeState(controller.state())).toMatch(
      /^This app cannot run: This app has no table/,
    );
  });
});
