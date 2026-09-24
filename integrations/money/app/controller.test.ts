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

describe('Money controller: annotations', () => {
  const opened = async (options: Parameters<typeof fakeStore>[0] = {}) => {
    const store = fakeStore({
      rows: [row('-23.47', '2026-09-22')],
      ...options,
    });
    const { controller } = harness(store);
    await controller.load();
    const subject = controller.state().rows[0].subject;
    controller.select(subject);

    return { store, controller, subject };
  };

  it('saves a category and a note on the row, and says Saved', async () => {
    const { store, controller, subject } = await opened({ rowsWritable: true });
    await controller.saveNote('category', '  Groceries ');
    await controller.saveNote('note', 'Team lunch\nwith receipts');
    expect(store.saves).toEqual([
      {
        subject,
        propVals: {
          'did:ad:ontology/property/money-category': 'Groceries',
        },
      },
      {
        subject,
        propVals: {
          'did:ad:ontology/property/money-note': 'Team lunch\nwith receipts',
        },
      },
    ]);
    const state = controller.state();
    expect(state.rows[0]).toMatchObject({
      category: 'Groceries',
      note: 'Team lunch\nwith receipts',
    });
    expect(state.edits.category?.status).toBe('saved');
  });

  it('does not write when nothing changed', async () => {
    const { store, controller } = await opened({ rowsWritable: true });
    await controller.saveNote('category', '');
    expect(store.saves).toEqual([]);
  });

  it('removes the property when a category is cleared', async () => {
    const { store, controller, subject } = await opened({ rowsWritable: true });
    await controller.saveNote('category', 'Travel');
    await controller.saveNote('category', ' ');
    expect(
      store.resources.get(subject)?.['did:ad:ontology/property/money-category'],
    ).toBeUndefined();
    expect(controller.state().rows[0].category).toBe('');
  });

  it('keeps the typed value on failure and saves it on retry', async () => {
    const { store, controller } = await opened({ rowsWritable: true });
    store.failSaves(1, 'The host did not answer save in time.');
    await controller.saveNote('category', 'Office supplies');
    expect(controller.state().edits.category).toEqual({
      value: 'Office supplies',
      status: 'error',
      message: "Your server didn't respond.",
      details: 'The host did not answer save in time.',
    });
    expect(controller.state().rows[0].category).toBe('');
    await controller.saveNote('category', 'Office supplies');
    expect(controller.state().edits.category?.status).toBe('saved');
    expect(controller.state().rows[0].category).toBe('Office supplies');
  });

  it("explains the host's app-scope refusal (the table is not under the app)", async () => {
    const { controller } = await opened();
    await controller.saveNote('note', 'x');
    expect(controller.state().edits.note).toMatchObject({
      status: 'error',
      message:
        "This app isn't allowed to write to the importer's table yet. Your text is kept here.",
    });
  });

  it('never writes annotations the row class does not declare', async () => {
    const { store, controller } = await opened({
      rowsWritable: true,
      notes: false,
    });
    await controller.saveNote('category', 'Travel');
    expect(store.saves).toEqual([]);
  });

  it('keeps drafts across renders and drops them with the row', async () => {
    const { controller } = await opened();
    controller.draft('note', 'half-typed');
    controller.setFilters({ query: 'x' });
    expect(controller.state().drafts.note).toBe('half-typed');
    controller.select(undefined);
    expect(controller.state().drafts).toEqual({});
  });
});
