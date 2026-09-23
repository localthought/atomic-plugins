import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackgroundSync,
  processLocks,
  webLocks,
  type BackgroundSyncOptions,
  type SyncStateStore,
  type WebLockManagerLike,
} from '../../../src/background/index.js';

const MINUTE = 60_000;

/** An async store, like IndexedDB, shared by every "context" in a test. */
function sharedStore(): SyncStateStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value);
    },
  };
}

function clock(start = Date.parse('2026-09-23T09:00:00.000Z')) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => (c.t += ms) };
  return c;
}

function schedule(
  overrides: Partial<BackgroundSyncOptions> &
    Pick<BackgroundSyncOptions, 'run'>,
  shared: { store: SyncStateStore; locks: ReturnType<typeof processLocks> },
  now: () => number,
) {
  return new BackgroundSync({
    name: 'conn-1',
    intervalMs: MINUTE,
    store: shared.store,
    locks: shared.locks,
    now,
    ...overrides,
  });
}

describe('BackgroundSync', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs when due, persists the next due time, and skips until then — across restarts', async () => {
    const c = clock();
    const shared = { store: sharedStore(), locks: processLocks() };
    let runs = 0;
    const run = async () => {
      runs++;
    };
    expect((await schedule({ run }, shared, c.now).tick()).outcome).toBe('ran');
    // A new instance (tab reopened, service worker restarted) sees the state.
    const reopened = schedule({ run }, shared, c.now);
    expect((await reopened.tick()).outcome).toBe('not-due');
    c.advance(MINUTE - 1);
    expect((await reopened.tick()).outcome).toBe('not-due');
    c.advance(1);
    const result = await reopened.tick();
    expect(result.outcome).toBe('ran');
    expect(runs).toBe(2);
    expect(result.state).toEqual({
      failures: 0,
      lastAttemptAt: '2026-09-23T09:01:00.000Z',
      lastSuccessAt: '2026-09-23T09:01:00.000Z',
      nextDueAt: '2026-09-23T09:02:00.000Z',
    });
    expect(JSON.parse(shared.store.data.get('conn-1')!)).toEqual(result.state);
  });

  it('never overlaps two contexts: a tick while another holds the lease is skipped', async () => {
    const c = clock();
    const shared = { store: sharedStore(), locks: processLocks() };
    let release!: () => void;
    let running = 0;
    let maxRunning = 0;
    const run = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((r) => (release = r));
      running--;
    };
    const tab = schedule({ run }, shared, c.now);
    const worker = schedule({ run }, shared, c.now);
    const first = tab.tick();
    await vi.waitFor(() => expect(running).toBe(1));
    expect((await worker.tick()).outcome).toBe('busy');
    release();
    expect((await first).outcome).toBe('ran');
    // The worker re-reads the state: the tab's pass already covered it.
    expect((await worker.tick()).outcome).toBe('not-due');
    expect(maxRunning).toBe(1);
  });

  it('re-checks due time inside the lease so a queued sync-now after a pass still runs but a tick does not', async () => {
    const c = clock();
    const shared = { store: sharedStore(), locks: processLocks() };
    let runs = 0;
    const s = schedule(
      {
        run: async () => {
          runs++;
        },
      },
      shared,
      c.now,
    );
    await s.tick();
    expect((await s.tick()).outcome).toBe('not-due');
    expect((await s.syncNow()).outcome).toBe('ran');
    expect(runs).toBe(2);
  });

  it('backs off exponentially on transient failures, capped, and resets on success', async () => {
    const c = clock();
    const shared = { store: sharedStore(), locks: processLocks() };
    let fail = true;
    const s = schedule(
      {
        maxBackoffMs: 4 * MINUTE,
        run: async () => {
          if (fail) throw new Error('GitHub list_issues returned 502');
        },
      },
      shared,
      c.now,
    );
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await s.tick();
      expect(r.outcome).toBe('failed');
      expect(r.error).toBe('GitHub list_issues returned 502');
      const delay = Date.parse(r.state.nextDueAt!) - c.now();
      delays.push(delay);
      expect((await s.tick()).outcome).toBe('not-due');
      c.advance(delay);
    }
    expect(delays).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE, 4 * MINUTE]);
    fail = false;
    const ok = await s.tick();
    expect(ok.outcome).toBe('ran');
    expect(ok.state.failures).toBe(0);
    expect(ok.state.lastError).toBeUndefined();
  });

  it('pauses on a permanent failure until resumed, even across restarts and sync-now', async () => {
    const c = clock();
    const shared = { store: sharedStore(), locks: processLocks() };
    let runs = 0;
    let conflict = true;
    const options = {
      isPermanent: (e: unknown) => String(e).includes('Conflict'),
      run: async () => {
        runs++;
        if (conflict) throw new Error('Conflict on https://x/1: title');
      },
    };
    const r = await schedule(options, shared, c.now).tick();
    expect(r.outcome).toBe('paused');
    expect(r.state.paused).toBe('Conflict on https://x/1: title');
    c.advance(24 * 60 * MINUTE);
    const reopened = schedule(options, shared, c.now);
    expect((await reopened.tick()).outcome).toBe('paused');
    expect((await reopened.syncNow()).outcome).toBe('paused');
    expect(runs).toBe(1);
    conflict = false; // a person resolved it
    const resumed = await reopened.resume();
    expect(resumed.paused).toBeUndefined();
    expect(resumed.lastError).toBe('Conflict on https://x/1: title');
    expect((await reopened.tick()).outcome).toBe('ran');
    expect(runs).toBe(2);
  });

  it('withLock excludes background passes for other uses of the connection', async () => {
    const c = clock();
    const shared = { store: sharedStore(), locks: processLocks() };
    const s = schedule({ run: async () => {} }, shared, c.now);
    let inside!: () => void;
    const held = s.withLock(() => new Promise<void>((r) => (inside = r)));
    expect((await s.tick()).outcome).toBe('busy');
    inside();
    await held;
    expect((await s.tick()).outcome).toBe('ran');
  });

  it('start() checks on an interval and only runs due passes', async () => {
    vi.useFakeTimers();
    const c = clock();
    const shared = { store: sharedStore(), locks: processLocks() };
    let runs = 0;
    const s = schedule(
      {
        run: async () => {
          runs++;
        },
      },
      shared,
      c.now,
    );
    s.start(MINUTE / 4);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    for (let i = 0; i < 3; i++) {
      c.advance(MINUTE / 4);
      await vi.advanceTimersByTimeAsync(MINUTE / 4);
    }
    expect(runs).toBe(1);
    c.advance(MINUTE / 4);
    await vi.advanceTimersByTimeAsync(MINUTE / 4);
    expect(runs).toBe(2);
    s.stop();
  });

  it('rejects invalid options and corrupt state', async () => {
    const shared = { store: sharedStore(), locks: processLocks() };
    expect(
      () =>
        new BackgroundSync({
          name: 'x',
          intervalMs: 0,
          run: async () => {},
          store: shared.store,
        }),
    ).toThrow('intervalMs');
    shared.store.data.set('conn-1', '{"nope":1}');
    await expect(
      schedule({ run: async () => {} }, shared, Date.now).tick(),
    ).rejects.toThrow('Corrupt background sync state');
  });
});

describe('webLocks', () => {
  it('maps ifAvailable leases onto a Web Locks manager', async () => {
    const held = new Set<string>();
    const manager: WebLockManagerLike = {
      async request<T>(
        name: string,
        a: { ifAvailable?: boolean } | ((lock: unknown) => Promise<T>),
        b?: (lock: unknown) => Promise<T>,
      ): Promise<T> {
        const options = typeof a === 'function' ? {} : a;
        const callback = (typeof a === 'function' ? a : b)!;
        if (held.has(name)) {
          if (options.ifAvailable) return callback(null);
          throw new Error('test manager does not queue');
        }
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      },
    } as WebLockManagerLike;
    const locks = webLocks(manager);
    const outer = await locks.tryWith('a', async () =>
      locks.tryWith('a', async () => 'inner'),
    );
    expect(outer).toEqual({ acquired: true, value: { acquired: false } });
    expect(await locks.with('a', async () => 7)).toBe(7);
  });
});
