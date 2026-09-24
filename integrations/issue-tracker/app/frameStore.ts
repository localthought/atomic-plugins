// @wc-ignore-file
/**
 * The frame's `PluginStore`, shaped as the data-browser store that
 * `AtomicPort` and `target.mjs` (devonian/github-issues) were written
 * against, so the bridge's Atomic side runs unchanged inside the app.
 *
 * What the host does at the pin (atomic-server bae5cdbe3), and what this
 * adapter adds because of it:
 *
 * - Writes. `newResource` and `save` are signed POSTs to `/app-write` that
 *   the host page awaits and rejects on any non-2xx (hostStore.ts
 *   `writeAsApp`). A resolved call means AtomicServer accepted the commit;
 *   a rejection surfaces as the host's error, never as a queued write. So a
 *   resource reports `idle` unless it has a `set` that no resolved `save`
 *   has sent yet, and nothing is ever local-only.
 * - Reads do not see the app's own writes. `getResource` and `query` are
 *   answered from the host page's store, and the e2e showed a resource the
 *   page had already loaded still reading its old values 5 s after the app
 *   saved it (a property the app wrote, on a row a person had edited in the
 *   page). Without a correction, the Bridge's verify-after-write would call
 *   that a concurrent edit. So every value the app saves is kept in
 *   `overlay` with the value it replaced: a read that still shows the
 *   replaced value gets the saved one instead; a read that shows the saved
 *   value, or anything else (someone changed it since), drops the entry and
 *   is believed. Known gap: someone setting the value back to exactly what
 *   the app replaced looks like a stale read until the page catches up.
 *   `overlay` should live as long as the view (the page's cache does).
 * - `query` is OPFS-first (`Collection.fetchPage`): it can miss a resource
 *   the page has not synced yet, and it swallows a failed server fallback.
 *   So every subject this adapter has created or listed is remembered per
 *   `(property, value)` in `known` (persisted by the caller) and added back
 *   when the host leaves it out, after re-reading it and checking the
 *   property still has that value. That keeps a bound row from looking
 *   deleted and a created row from being created twice. Rows the page has
 *   never seen show up on a later pass; the Bridge never treats absence as
 *   deletion.
 *
 * Not verified beyond the e2e: repositories past the Collection's
 * 500-per-page paging, and whether the page's cache ever catches up by
 * itself (the overlay does not depend on it).
 */
import type { JSONValue, PluginResource, PluginStore } from './store.js';

export interface FrameResource {
  readonly subject: string;
  readonly error: undefined;
  get(property: string): JSONValue;
  set(property: string, value: JSONValue): FrameResource;
  save(): Promise<undefined>;
  getLoroDoc(): void;
}

/** `${property}\n${value}` -> subjects, as plain JSON for persistence. */
export type KnownSubjects = Record<string, string[]>;

/**
 * subject -> property -> what the app last saved, and every value the page
 * may still show instead (what the app replaced, and its own earlier saves).
 */
export type Overlay = Map<
  string,
  Map<string, { stale: JSONValue[]; after: JSONValue }>
>;

export interface FrameAtomicStore {
  isLocalOnlyDrive(drive: string): boolean;
  hasCompletedDriveSyncFor(drive: string): boolean;
  getSaveState(resource: FrameResource): { kind: 'idle' | 'pending' };
  queryLocalDb(args: {
    drive: string;
    property: string;
    value: string;
    limit?: number;
  }): Promise<{ count: number; subjects: string[] }>;
  getResource(subject: string): Promise<FrameResource>;
  newResource(args: {
    parent?: string;
    isA?: string[];
    propVals?: Record<string, JSONValue>;
  }): Promise<FrameResource>;
  /** Host writes made through this adapter, for the pass summary. */
  readonly writes: { creates: number; saves: number };
}

export interface FrameStoreOptions {
  /** Mutated in place; persist it with the sync state. */
  known?: KnownSubjects;
  /** Properties whose values are remembered for `query`. */
  indexed?: string[];
  /** Mutated in place; keep it for the life of the view. */
  overlay?: Overlay;
}

const PARENT = 'https://atomicdata.dev/properties/parent';
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const keyOf = (property: string, value: string) => `${property}\n${value}`;

export function frameStore(
  store: PluginStore,
  { known = {}, indexed = [], overlay = new Map() }: FrameStoreOptions = {},
): FrameAtomicStore {
  /** Per wrapped resource: property -> the value it had before `set`. */
  const unsent = new Map<FrameResource, Map<string, JSONValue>>();
  const writes = { creates: 0, saves: 0 };

  const remember = (property: string, value: JSONValue, subject: string) => {
    if (typeof value !== 'string' || !indexed.includes(property)) return;
    const list = (known[keyOf(property, value)] ??= []);
    if (!list.includes(subject)) list.push(subject);
  };

  /** A host read, corrected for the app's own saves; see the module comment. */
  const read = async (subject: string): Promise<PluginResource> => {
    const resource = await store.getResource(subject);
    const saved = overlay.get(subject);
    if (!saved) return resource;

    for (const [property, { stale, after }] of saved) {
      const now = resource.get(property);
      if (!same(now, after) && stale.some(value => same(value, now)))
        resource.set(property, after);
      else saved.delete(property);
    }

    if (!saved.size) overlay.delete(subject);

    return resource;
  };

  const wrap = (inner: PluginResource): FrameResource => {
    const resource: FrameResource = {
      subject: inner.subject,
      error: undefined,
      get: property => inner.get(property),
      set(property, value) {
        const pending = unsent.get(resource) ?? new Map<string, JSONValue>();
        if (!pending.has(property)) pending.set(property, inner.get(property));
        unsent.set(resource, pending);
        inner.set(property, value);

        return resource;
      },
      async save() {
        // A just-created resource was already written by `create`; saving
        // it again unchanged would be a second, empty commit.
        const pending = unsent.get(resource);
        if (!pending) return undefined;
        await inner.save();
        writes.saves++;
        unsent.delete(resource);
        const saved = overlay.get(inner.subject) ?? new Map();

        for (const [property, before] of pending) {
          const after = inner.get(property);
          const earlier = saved.get(property);
          saved.set(property, {
            stale: earlier ? [...earlier.stale, earlier.after] : [before],
            after,
          });
          remember(property, after, inner.subject);
        }

        overlay.set(inner.subject, saved);

        return undefined;
      },
      getLoroDoc() {},
    };

    return resource;
  };

  return {
    writes,
    isLocalOnlyDrive: () => false,
    hasCompletedDriveSyncFor: () => true,
    getSaveState: resource => ({
      kind: unsent.has(resource) ? 'pending' : 'idle',
    }),
    async queryLocalDb({ property, value }) {
      const listed = await store.query({ property, value: String(value) });
      const subjects = [...listed];

      for (const subject of known[keyOf(property, String(value))] ?? []) {
        if (subjects.includes(subject)) continue;
        const resource = await read(subject).catch(() => undefined);
        if (resource && same(resource.get(property), value))
          subjects.push(subject);
      }

      for (const subject of listed) remember(property, String(value), subject);

      return { count: subjects.length, subjects };
    },
    async getResource(subject) {
      return wrap(await read(subject));
    },
    async newResource({ parent, isA, propVals = {} }) {
      const created = await store.newResource({ parent, isA, propVals });
      writes.creates++;
      if (parent) remember(PARENT, parent, created.subject);
      for (const [property, value] of Object.entries(propVals))
        remember(property, value, created.subject);

      return wrap(created);
    },
  };
}
