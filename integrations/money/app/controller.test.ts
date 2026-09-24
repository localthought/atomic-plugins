// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createController,
  NOT_A_BANK_TABLE,
  type State,
} from './controller.js';
import { fakeStore, seedRow as row, TABLE } from './fakeStore.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(store = fakeStore()) {
  const seen: State[] = [];
  const controller = createController(store, s => seen.push(s));

  return { store, controller, seen };
}

describe('Money controller: loading', () => {
  it('starts loading and settles empty for an empty table', async () => {
    const { controller, seen } = harness();
    expect(controller.state().view.kind).toBe('loading');
    await controller.load();
    expect(seen[0].view.kind).toBe('loading');
    expect(controller.state().view).toEqual({ kind: 'empty' });
  });

  it('reads the rows under their shortnames and settles populated', async () => {
    const store = fakeStore({
      rows: [row('-84.30', '2026-09-18'), row('2420', '2026-09-19')],
    });
    const { controller } = harness(store);
    await controller.load();
    const state = controller.state();
    expect(state.view).toEqual({ kind: 'populated', count: 2 });
    expect(state.rows.map(r => r.amount).sort()).toEqual(['-84.30', '2420']);
    expect(state.rows[0]).toMatchObject({
      account: 'NL42BUNQ0123456789',
      currency: 'EUR',
      format: 'mt940',
      category: '',
    });
  });

  it('refuses a table that is not a Bank transactions table', async () => {
    for (const data of ['none', 'other'] as const) {
      const { controller } = harness(fakeStore({ data }));
      await controller.load();
      expect(controller.state().view).toEqual({
        kind: 'error',
        message: NOT_A_BANK_TABLE,
      });
    }
  });

  it('reports a failing host as an error, not an empty ledger', async () => {
    const store = fakeStore();

    store.getData = async () => {
      throw new Error('The host did not answer data in time.');
    };

    const { controller } = harness(store);
    await controller.load();
    expect(controller.state().view).toEqual({
      kind: 'error',
      message: 'The host did not answer data in time.',
    });
  });

  it('reports progress while many rows load', async () => {
    const store = fakeStore({
      rows: Array.from({ length: 120 }, (_, i) =>
        row(`-${i + 1}`, '2026-09-01'),
      ),
    });
    const { controller, seen } = harness(store);
    await controller.load();
    expect(
      seen.some(
        s => s.view.kind === 'loading' && s.view.total === 120 && s.view.loaded,
      ),
    ).toBe(true);
    expect(controller.state().view).toEqual({ kind: 'populated', count: 120 });
  });

  it('picks up rows an import adds, without a reload', async () => {
    const store = fakeStore();
    const { controller } = harness(store);
    await controller.load();
    expect(store.subscribed.has(TABLE)).toBe(true);
    store.addRows([row('-12.34', '2026-09-02'), row('20', '2026-09-03')]);
    await settle();
    await settle();
    expect(controller.state().view).toEqual({ kind: 'populated', count: 2 });
    controller.dispose();
    expect(store.subscribed.has(TABLE)).toBe(false);
  });
});
