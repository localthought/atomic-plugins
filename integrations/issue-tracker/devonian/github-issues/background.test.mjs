import { expect, it } from 'vitest';
import * as devonian from 'devonian';
import { processLocks } from 'devonian';
import { Bridge } from './bridge.mjs';
import { createBackgroundSync, isPermanentSyncError } from './background.mjs';

const MINUTE = 60_000;

// Deterministic in-memory ports, the same contract bridge.test.mjs uses.
const makePort = scope => ({
  scope,
  rows: new Map(),
  receipts: new Map(),
  writes: 0,
  lose: false,
  async list(entity) {
    return [...this.rows.values()].filter(r => r.entity === entity);
  },
  async get(entity, id) {
    const row = this.rows.get(id);
    if (!row || row.entity !== entity) throw new Error('Missing record');

    return structuredClone(row);
  },
  async create(entity, value, key, metadata) {
    if (this.receipts.has(key)) return this.receipts.get(key);
    const id = this.rows.size + 1;
    const row = { id, entity, value: structuredClone(value), metadata };
    this.rows.set(id, row);
    this.receipts.set(key, row);
    this.writes++;

    if (this.lose) {
      this.lose = false;
      throw new Error('Lost response');
    }

    return row;
  },
  async update(entity, id, value) {
    const row = await this.get(entity, id);
    this.rows.set(id, { ...row, value: structuredClone(value) });
    this.writes++;
  },
});
const issue = (id, title = 'Title') => ({
  id,
  entity: 'issue',
  value: { title, body: '', status: 'Todo' },
});

/** Everything a browser host would persist in IndexedDB, shared by contexts. */
function host() {
  const idb = new Map();
  const local = makePort('https://atomic.example/tracker');
  const remote = makePort('https://github.com/acme/repo');
  let opened = 0;

  const openBridge = async () => {
    opened++;
    const saved = idb.get('bridge');

    return new Bridge({
      devonian,
      local,
      remote,
      base: 'https://bridge.example/sync',
      snapshot: saved && JSON.parse(saved),
      save: async s => {
        idb.set('bridge', JSON.stringify(s));
      },
    });
  };

  const store = {
    get: async k => idb.get(`schedule:${k}`),
    set: async (k, v) => {
      idb.set(`schedule:${k}`, v);
    },
  };

  return { idb, local, remote, openBridge, store, opened: () => opened };
}

function clock() {
  const c = { t: Date.parse('2026-09-23T09:00:00.000Z') };
  c.now = () => c.t;

  return c;
}

it('keeps syncing on schedule from the persisted checkpoint, in whichever context ticks', async () => {
  const h = host();
  const c = clock();
  const locks = processLocks();
  const context = () =>
    createBackgroundSync({
      openBridge: h.openBridge,
      store: h.store,
      locks,
      intervalMs: MINUTE,
      now: c.now,
    });
  const tab = context();
  h.remote.rows.set(1, issue(1));
  expect((await tab.tick()).outcome).toBe('ran');
  expect(h.local.rows.get(1).value.title).toBe('Title');

  // The tab closes; a service worker wakes later with only the stored state.
  h.remote.rows.get(1).value.title = 'Edited on GitHub';
  const worker = context();
  expect((await worker.tick()).outcome).toBe('not-due');
  c.t += MINUTE;
  expect((await worker.tick()).outcome).toBe('ran');
  expect(h.local.rows.get(1).value.title).toBe('Edited on GitHub');

  // A due pass with nothing changed writes nothing, and each pass used a
  // Bridge freshly opened from the checkpoint.
  const writes = h.local.writes + h.remote.writes;
  c.t += MINUTE;
  expect((await context().tick()).outcome).toBe('ran');
  expect(h.local.writes + h.remote.writes).toBe(writes);
  expect(h.opened()).toBe(3);
});

it('backs off after a lost receipt and resumes the saved create without duplicating it', async () => {
  const h = host();
  const c = clock();
  const sync = createBackgroundSync({
    openBridge: h.openBridge,
    store: h.store,
    locks: processLocks(),
    intervalMs: MINUTE,
    now: c.now,
  });
  h.local.rows.set(1, issue(1));
  h.remote.lose = true;
  const failed = await sync.tick();
  expect(failed.outcome).toBe('failed');
  expect(failed.error).toBe('Lost response');
  c.t += MINUTE;
  expect((await sync.tick()).outcome).toBe('ran');
  expect(h.remote.rows.size).toBe(1);
  expect(h.remote.writes).toBe(1);
});

it('pauses on a conflict, leaves both sides untouched, and runs again after resume', async () => {
  const h = host();
  const c = clock();
  const sync = createBackgroundSync({
    openBridge: h.openBridge,
    store: h.store,
    locks: processLocks(),
    intervalMs: MINUTE,
    now: c.now,
  });
  h.remote.rows.set(1, issue(1));
  await sync.tick();
  h.local.rows.get(1).value.title = 'A';
  h.remote.rows.get(1).value.title = 'B';
  c.t += MINUTE;
  const paused = await sync.tick();
  expect(paused.outcome).toBe('paused');
  expect(paused.state.paused).toMatch(/^Conflict on .*: title$/);
  c.t += 60 * MINUTE;
  expect((await sync.tick()).outcome).toBe('paused');
  expect(h.local.rows.get(1).value.title).toBe('A');
  expect(h.remote.rows.get(1).value.title).toBe('B');
  h.local.rows.get(1).value.title = 'B'; // a person picks a side
  await sync.resume();
  expect((await sync.tick()).outcome).toBe('ran');
});

it('classifies human-action failures as permanent and everything else as transient', () => {
  for (const message of [
    'Conflict on https://x: title',
    'Conflict during saved operation on https://x',
    'Concurrent edit after write on https://x',
    'Missing local record: https://x',
    'State belongs to another connection',
    'Duplicate external identity',
    'Recovered Atomic create was edited; reconcile before retry',
    'Atomic write rejected: forbidden',
    'Uncertain GitHub write (create_issue). Inspect its outcome before retrying; it will not be resent.',
    'Operation identity reused with different arguments',
    'Connect to the proxy or supply a fresh connection code',
    'Proxy did not expose X-Connection-Code. Enable CORS exposure and reconnect.',
    'GitHub list_issues returned 401',
  ])
    expect(isPermanentSyncError(new Error(message)), message).toBe(true);
  for (const message of [
    'GitHub list_issues returned 502',
    'GitHub list_issues returned 403',
    'Proxy request failed. Check CORS and reconnect; an uncertain write will not be resent.',
    'AtomicServer disconnected',
    'Atomic drive has not finished syncing: https://drive.example',
    'Atomic write not acknowledged: https://drive.example/r',
    'Lost response',
  ])
    expect(isPermanentSyncError(new Error(message)), message).toBe(false);
});

it('requires an openBridge factory rather than a long-lived Bridge', () => {
  expect(() =>
    createBackgroundSync({ store: host().store, intervalMs: MINUTE }),
  ).toThrow('openBridge');
});
