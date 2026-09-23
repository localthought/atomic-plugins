// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { USER, WORKSPACE } from '../../localthought/mock-clockify.mjs';
import { readConnectionReference } from './config.js';
import { createController, describe as describeState } from './controller.js';
import { fakeStore } from './fakeStore.js';
import { config } from './ontology.js';

const configured = {
  [config.connectionId]: 'conn-1',
  [config.workspaceId]: WORKSPACE.id,
  [config.userId]: USER.id,
};

describe('readConnectionReference', () => {
  it('defaults the look-back to 7 days and accepts 30', () => {
    const get = (extra: Record<string, unknown>) => (p: string) =>
      ({ ...configured, ...extra })[p] as string | number | undefined;

    expect(readConnectionReference(get({}))).toMatchObject({
      ok: true,
      reference: { lookbackDays: 7 },
    });
    expect(
      readConnectionReference(get({ [config.lookbackDays]: 30 })),
    ).toMatchObject({
      ok: true,
      reference: { lookbackDays: 30 },
    });
    expect(readConnectionReference(get({ [config.lookbackDays]: 90 }))).toEqual(
      {
        ok: false,
        missing: ['lookbackDays'],
      },
    );
  });

  it('names every missing field', () => {
    expect(readConnectionReference(() => undefined)).toEqual({
      ok: false,
      missing: ['connectionId', 'workspaceId', 'userId'],
    });
  });
});

describe('controller', () => {
  it('reports an unconfigured app without touching the proxy', async () => {
    const calls: unknown[] = [];
    const store = fakeStore({
      proxy: async r => (calls.push(r), { status: 200, body: [] }),
    });

    const state = await createController(store).load();

    expect(state.kind).toBe('unconfigured');
    expect(describeState(state)).toMatch(/Not connected yet/);
    expect(calls).toEqual([]);
  });

  it('says so when the host offers no proxy op, instead of falling back to a credential', async () => {
    const store = fakeStore({ appProps: configured });

    const state = await createController(store).load();

    expect(state.kind).toBe('no-proxy');
    expect(describeState(state)).toMatch(/cannot reach the integration proxy/);
  });

  it('syncs when ready and reports the outcome, including failures', async () => {
    let status = 200;
    const store = fakeStore({
      table: 'did:ad:table',
      appProps: configured,
      proxy: async ({ path }) =>
        path.endsWith('/time-entries')
          ? { status, body: status === 200 ? [] : { message: 'nope' } }
          : { status: 404, body: {} },
    });
    const seen: string[] = [];
    const controller = createController(
      store,
      s => seen.push(s.kind),
      () => 0,
    );

    expect((await controller.load()).kind).toBe('ready');
    const ok = await controller.sync();
    expect(describeState(ok)).toMatch(
      /^Synced: 0 created, 0 updated, 0 unchanged\. Warnings:/,
    );

    status = 500;
    const failed = await controller.sync();
    expect(describeState(failed)).toBe(
      'Sync failed: Clockify request /api/v1/workspaces/' +
        `${WORKSPACE.id}/user/${USER.id}/time-entries failed with 500: nope`,
    );
    expect(seen).toEqual(['ready', 'syncing', 'ready', 'syncing', 'ready']);
  });
});
