// @wc-ignore-file
/**
 * The Bridge's snapshot and the transport's write journal, kept as JSON text
 * on the app's sync resource (see tracker.ts). A null-origin frame has no
 * IndexedDB or localStorage, so this is the only durable place the app has.
 *
 * Write ordering, which is what makes this safe to resume:
 * - A journal entry is written before its GitHub request leaves
 *   (`saveJournal`, called by `proxyTransport` before and after each write).
 * - A Bridge checkpoint that carries a pending operation is written before
 *   that operation touches either side (`saveSnapshot`). Checkpoints without
 *   one (a baseline moving after both sides already agree) are only marked
 *   dirty and written by `flush()` at the end of the pass: losing them
 *   costs a re-check next pass, never a duplicate write.
 *
 * Not guarded: two tabs or devices syncing the same app at the same moment.
 * The resource syncs across devices and `/app-write` has no compare-and-swap,
 * so the last writer's state wins. One syncing tab per app is assumed.
 */
import type { KnownSubjects } from './frameStore.js';
import type { PluginResource } from './store.js';

/** What the view remembers per installation; never a credential. */
export interface ViewPrefs {
  /** An explicit Board/List choice; absent means "by width". */
  layout?: 'board' | 'list';
  search?: string;
  label?: string;
}

export interface PersistedState {
  version: 1;
  snapshot?: unknown;
  journal: Record<string, unknown>;
  known: KnownSubjects;
  /** Connection ids that GitHub or the host refused; skipped on load. */
  stale: string[];
  /** Board/List choice and filters (IT-14). Kept here, not in frame storage, which a null-origin frame lacks. */
  view?: ViewPrefs;
}

const empty = (): PersistedState => ({
  version: 1,
  journal: {},
  known: {},
  stale: [],
});

export function parseState(text: unknown): PersistedState {
  if (typeof text !== 'string' || !text) return empty();
  const value = JSON.parse(text) as Partial<PersistedState>;
  if (value.version !== 1) throw new Error('Unsupported sync state version');

  return {
    ...empty(),
    ...value,
    journal: value.journal ?? {},
    known: value.known ?? {},
    stale: value.stale ?? [],
  } as PersistedState;
}

const hasPending = (snapshot: unknown) =>
  Object.values(
    (snapshot as { records?: Record<string, { pending?: unknown }> })
      ?.records ?? {},
  ).some(record => record.pending);

export class SyncState {
  readonly state: PersistedState;
  private dirty = false;
  /** Serialises saves: the host's `save` sends the whole resource. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private resource: PluginResource,
    private property: string,
  ) {
    this.state = parseState(resource.get(property));
  }

  async saveSnapshot(snapshot: unknown): Promise<void> {
    this.state.snapshot = snapshot;
    if (hasPending(snapshot)) await this.flush();
    else this.dirty = true;
  }

  async saveJournal(): Promise<void> {
    await this.flush();
  }

  async flushIfDirty(): Promise<void> {
    if (this.dirty) await this.flush();
  }

  flush(): Promise<void> {
    const next = this.chain.then(async () => {
      this.dirty = false;
      this.resource.set(this.property, JSON.stringify(this.state));
      await this.resource.save();
    });
    this.chain = next.catch(() => {});

    return next;
  }
}
