/**
 * A persisted, cross-context background sync scheduler.
 *
 * One due-time + lease model shared by every trigger a host has: a timer in a
 * tab, a service worker's `periodicsync`/`sync` event, or a cron in a Node
 * process. Its state (next due time, failure count, pause reason) lives in a
 * host-supplied store, so it survives the tab closing and is shared by every
 * context that opens the same store; a lease (Web Locks by default) makes
 * sure only one context runs a pass at a time.
 *
 * This module has no Node or DOM imports so it also loads in a service worker.
 */

/**
 * Async-tolerant string→string store. The reflect `KvStore`s satisfy it; a
 * browser host normally passes an IndexedDB-backed one so a service worker
 * and the tabs share the state.
 */
export interface SyncStateStore {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, value: string): void | Promise<void>;
}

/** Exclusive named leases, shared across every context that must not overlap. */
export interface SyncLocks {
  /** Runs `fn` only if the lease is free right now; never queues. */
  tryWith<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  /** Waits for the lease, then runs `fn`. */
  with<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** The subset of the Web Locks API (`navigator.locks`) this module uses. */
export interface WebLockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
  request<T>(name: string, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

/**
 * Leases backed by the Web Locks API. They are shared by all tabs and
 * workers of one origin and are released by the browser when the holding
 * context dies, so a closed tab or a terminated service worker never leaves
 * a stale lease behind.
 */
export function webLocks(manager: WebLockManagerLike): SyncLocks {
  return {
    tryWith: <T>(name: string, fn: () => Promise<T>) =>
      manager.request(name, { ifAvailable: true }, async (lock) =>
        lock
          ? { acquired: true as const, value: await fn() }
          : { acquired: false as const },
      ),
    with: <T>(name: string, fn: () => Promise<T>) =>
      manager.request(name, () => fn()),
  };
}

/**
 * In-process leases, for Node hosts and tests. They do NOT exclude other
 * processes: a host running more than one process against one store must
 * supply its own cross-process `SyncLocks`.
 */
export function processLocks(): SyncLocks {
  const held = new Map<string, Promise<unknown>>();
  const run = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => (release = resolve));
    held.set(name, settled); // before fn runs, so fn itself cannot re-enter
    try {
      return await fn();
    } finally {
      held.delete(name);
      release();
    }
  };
  return {
    async tryWith<T>(
      name: string,
      fn: () => Promise<T>,
    ): Promise<{ acquired: true; value: T } | { acquired: false }> {
      if (held.has(name)) return { acquired: false };
      return { acquired: true, value: await run(name, fn) };
    },
    async with<T>(name: string, fn: () => Promise<T>): Promise<T> {
      while (held.has(name)) await held.get(name);
      return run(name, fn);
    },
  };
}

/** Web Locks when the global `navigator.locks` exists, else in-process. */
export function defaultLocks(): SyncLocks {
  const manager = (globalThis as { navigator?: { locks?: WebLockManagerLike } })
    .navigator?.locks;
  return manager ? webLocks(manager) : processLocks();
}

/** What is persisted under the scheduler's `name`. Times are ISO 8601 strings. */
export interface BackgroundSyncState {
  failures: number;
  nextDueAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  /** Set when a failure needs a person; only {@link BackgroundSync.resume} clears it. */
  paused?: string;
}

export type TickOutcome = 'ran' | 'not-due' | 'busy' | 'paused' | 'failed';

export interface TickResult {
  outcome: TickOutcome;
  state: BackgroundSyncState;
  error?: string;
}

export interface BackgroundSyncOptions {
  /** Store key and lease name; one per connection being synced. */
  name: string;
  /** Wanted time between successful passes. */
  intervalMs: number;
  /** One sync pass. Build fresh state inside it; another context may have run since. */
  run: () => Promise<void>;
  store: SyncStateStore;
  locks?: SyncLocks;
  now?: () => number;
  /** Cap for exponential backoff after transient failures. Default: max(intervalMs, 1 hour). */
  maxBackoffMs?: number;
  /** Failures that need a person pause the schedule instead of backing off. */
  isPermanent?: (error: unknown) => boolean;
  /** Reports errors from the {@link BackgroundSync.start} loop itself (e.g. a failing store). */
  onError?: (error: unknown) => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class BackgroundSync {
  readonly name: string;
  readonly lockName: string;
  private readonly options: BackgroundSyncOptions;
  private readonly locks: SyncLocks;
  private readonly now: () => number;
  private readonly maxBackoffMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: BackgroundSyncOptions) {
    if (!options.name) throw new Error('A background sync name is required');
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0)
      throw new Error('intervalMs must be a positive integer');
    this.options = options;
    this.name = options.name;
    this.lockName = `devonian-background-sync:${options.name}`;
    this.locks = options.locks ?? defaultLocks();
    this.now = options.now ?? Date.now;
    this.maxBackoffMs =
      options.maxBackoffMs ?? Math.max(options.intervalMs, 60 * 60 * 1000);
  }

  /** The persisted state, as every context sees it. */
  async status(): Promise<BackgroundSyncState> {
    const raw = await this.options.store.get(this.name);
    if (raw === undefined) return { failures: 0 };
    const parsed = JSON.parse(raw) as BackgroundSyncState;
    if (!parsed || typeof parsed !== 'object' || !(parsed.failures >= 0))
      throw new Error(`Corrupt background sync state: ${this.name}`);
    return parsed;
  }

  private async write(state: BackgroundSyncState): Promise<void> {
    await this.options.store.set(this.name, JSON.stringify(state));
  }

  private due(state: BackgroundSyncState): boolean {
    return (
      state.nextDueAt === undefined || this.now() >= Date.parse(state.nextDueAt)
    );
  }

  /**
   * One scheduled check: runs a pass only if it is due, nobody else holds the
   * lease, and the schedule is not paused. Safe to call from any trigger as
   * often as wanted. Resolves with the outcome; a pass's own failure is
   * recorded and reported, not thrown.
   */
  async tick(): Promise<TickResult> {
    const before = await this.status();
    if (before.paused) return { outcome: 'paused', state: before };
    if (!this.due(before)) return { outcome: 'not-due', state: before };
    const result = await this.locks.tryWith(this.lockName, () =>
      this.attempt(false),
    );
    return result.acquired
      ? result.value
      : { outcome: 'busy', state: await this.status() };
  }

  /**
   * A person's "sync now": waits for any running pass, then runs regardless
   * of the due time. Still refuses while paused — call {@link resume} first.
   */
  async syncNow(): Promise<TickResult> {
    return this.locks.with(this.lockName, () => this.attempt(true));
  }

  private async attempt(force: boolean): Promise<TickResult> {
    // Re-read inside the lease: another context may have just run or paused.
    const state = await this.status();
    if (state.paused) return { outcome: 'paused', state };
    if (!force && !this.due(state)) return { outcome: 'not-due', state };
    const started = this.now();
    try {
      await this.options.run();
    } catch (error) {
      const failures = state.failures + 1;
      const permanent = this.options.isPermanent?.(error) ?? false;
      const next: BackgroundSyncState = {
        ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
        failures,
        lastAttemptAt: new Date(started).toISOString(),
        lastError: message(error),
        ...(permanent
          ? { paused: message(error) }
          : {
              nextDueAt: new Date(
                this.now() +
                  Math.min(
                    this.options.intervalMs * 2 ** (failures - 1),
                    this.maxBackoffMs,
                  ),
              ).toISOString(),
            }),
      };
      await this.write(next);
      return {
        outcome: permanent ? 'paused' : 'failed',
        state: next,
        error: message(error),
      };
    }
    const next: BackgroundSyncState = {
      failures: 0,
      lastAttemptAt: new Date(started).toISOString(),
      lastSuccessAt: new Date(this.now()).toISOString(),
      nextDueAt: new Date(this.now() + this.options.intervalMs).toISOString(),
    };
    await this.write(next);
    return { outcome: 'ran', state: next };
  }

  /** Clears a pause after a person resolved its cause; the next tick is due at once. */
  async resume(): Promise<BackgroundSyncState> {
    return this.locks.with(this.lockName, async () => {
      const next: BackgroundSyncState = { ...(await this.status()) };
      delete next.paused;
      delete next.nextDueAt;
      next.failures = 0;
      await this.write(next);
      return next;
    });
  }

  /**
   * Runs `fn` under this schedule's lease. A host puts every other use of the
   * same connection (interactive writes, anything that spends a rotating
   * proxy code) under it so it never overlaps a background pass.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.with(this.lockName, fn);
  }

  /**
   * Checks every `pollMs` (default: `intervalMs`) while this context lives,
   * starting now. Only due passes run, so several contexts may all call it.
   */
  start(pollMs = this.options.intervalMs): void {
    if (this.timer) return;
    const check = (): void => {
      void this.tick().catch((error) => {
        (this.options.onError ?? console.error)(error);
      });
    };
    check();
    this.timer = setInterval(check, pollMs);
    const timer = this.timer as { unref?: () => void };
    if (typeof timer.unref === 'function') timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
