// @wc-ignore-file
import { NAME } from './ontology.js';
import {
  comparePositions,
  diffObservation,
  emptyMirror,
  fold,
  isEmpty,
  mergeCoverage,
  type CoverageSegment,
  type Incremental,
  type Mirror,
  type Observation,
  type Position,
} from './observations.js';
import type { CompleteSchema } from './schema.js';
import type { PluginStore } from './store.js';

/**
 * The observation log stored as Atomic resources in the app's own subtree
 * (#97 §6.2 option A, answer 4):
 *
 *     App ── clockify-observation-log ──▶ head   (clockify-log-head: HeadState)
 *                                          ├── snapshot…  (clockify-snapshot)
 *                                          └── incremental… (clockify-observation)
 *
 * - One resource per non-empty incremental, never edited afterwards. An
 *   observation that changed nothing is not stored: it only moves the
 *   coverage's `confirmedAt` in the head.
 * - The head lists the incrementals after the current snapshot (`tail`).
 * - Compaction writes a new snapshot of the mirror once the tail reaches 50
 *   incrementals or 256 KB of JSON (#97 §2.5; both numbers are placeholders).
 *   Nothing is pruned (#97 answer 1): each snapshot names the incrementals it
 *   absorbed and the snapshot before it, so the whole log can be replayed.
 * - Every resource is found from the head, never through `query`.
 *
 * Not solved here (M5): two devices saving the head at the same moment. The
 * head is re-read and merged just before each save, which narrows that race
 * but, without compare-and-swap on `/app-write`, does not close it; an
 * incremental dropped from the head that way is not folded until it is read
 * again. Whether atomic-server accepts a snapshot string of ~1 MB in one
 * commit is not verified.
 */

export const COMPACT_AFTER_INCREMENTALS = 50;
export const COMPACT_AFTER_BYTES = 256 * 1024;

export interface TailEntry extends Position {
  subject: string;
  /** Length of the stored JSON text. */
  bytes: number;
}

export interface HeadState {
  v: 1;
  snapshot: string;
  /** The last position the snapshot includes. */
  cut: Position | null;
  tail: TailEntry[];
  /** Coverage, including confirmations that stored no incremental. */
  coverage: CoverageSegment[];
  /** `receivedAt` of the last complete range read. */
  lastComplete?: string;
}

export interface SnapshotState {
  v: 1;
  mirror: Mirror;
  cut: Position | null;
  /** The snapshot this one replaced, or null for the first. */
  previous: string | null;
  /** The incrementals folded into this snapshot since `previous`. */
  compacted: TailEntry[];
  writtenAt: string;
}

export interface LogOptions {
  clock: () => number;
}

const parse = <T>(text: unknown, what: string): T => {
  if (typeof text !== 'string') throw new Error(`The ${what} is missing.`);

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The ${what} is not valid JSON.`);
  }
};

const after = (entry: Position, cut: Position | null) =>
  !cut || comparePositions(entry, cut) > 0;

export class ObservationLog {
  /** Incrementals stored by this instance, for reports and tests. */
  appended = 0;
  snapshotsWritten = 0;
  private dirty = false;

  private constructor(
    private readonly store: PluginStore,
    private readonly fields: CompleteSchema['log'],
    private readonly options: LogOptions,
    private headSubject: string | undefined,
    private head: HeadState | undefined,
    private current: Mirror,
  ) {}

  /** Reads the log and folds it. Writes nothing, even for a new app. */
  static async open(
    store: PluginStore,
    schema: CompleteSchema,
    options: LogOptions,
  ): Promise<ObservationLog> {
    const fields = schema.log;
    const app = await store.getResource(await store.getApp());
    const headSubject = app.get(fields.log);

    if (typeof headSubject !== 'string' || !headSubject)
      return new ObservationLog(
        store,
        fields,
        options,
        undefined,
        undefined,
        emptyMirror(),
      );

    const head = parse<HeadState>(
      (await store.getResource(headSubject)).get(fields.head),
      'Clockify log head',
    );
    const snapshot = await readSnapshot(store, fields, head.snapshot);
    const tail = await readIncrementals(store, fields, head.tail);
    // An incremental that sorts before the snapshot's cut (another device's,
    // arriving late) cannot be folded on top of it: replay the whole log.
    const late = head.tail.some(entry => !after(entry, snapshot.cut));
    const mirror = late
      ? fold(emptyMirror(), [
          ...(await readChain(store, fields, snapshot)),
          ...tail,
        ])
      : fold(snapshot.mirror, tail);
    mirror.coverage = mergeCoverage(mirror.coverage, head.coverage);

    return new ObservationLog(
      store,
      fields,
      options,
      headSubject,
      head,
      mirror,
    );
  }

  /**
   * Folds every incremental ever stored, ignoring snapshots: the full log is
   * kept (#97 answer 1), so this is always possible. For checks and
   * debugging; `open` is the fast path.
   */
  static async replay(
    store: PluginStore,
    schema: CompleteSchema,
  ): Promise<Mirror> {
    const fields = schema.log;
    const app = await store.getResource(await store.getApp());
    const headSubject = app.get(fields.log);
    if (typeof headSubject !== 'string' || !headSubject) return emptyMirror();
    const head = parse<HeadState>(
      (await store.getResource(headSubject)).get(fields.head),
      'Clockify log head',
    );
    const snapshot = await readSnapshot(store, fields, head.snapshot);
    const mirror = fold(emptyMirror(), [
      ...(await readChain(store, fields, snapshot)),
      ...(await readIncrementals(store, fields, head.tail)),
    ]);
    mirror.coverage = mergeCoverage(mirror.coverage, head.coverage);

    return mirror;
  }

  get mirror(): Mirror {
    return this.current;
  }

  get lastComplete(): string | undefined {
    return this.head?.lastComplete;
  }

  /** The incrementals after the current snapshot. */
  get tail(): readonly TailEntry[] {
    return this.head?.tail ?? [];
  }

  /**
   * Diffs `observation` against the mirror, stores the incremental if it
   * changed anything, and folds it in. The head is saved by `flush()`.
   */
  async append(observation: Observation): Promise<Incremental> {
    const incremental = diffObservation(this.current, observation);
    const head = await this.ensureHead();

    if (!isEmpty(incremental)) {
      const text = JSON.stringify(incremental);
      const created = await this.store.newResource({
        parent: this.headSubject,
        propVals: {
          [NAME]: `Clockify ${incremental.kind} read ${incremental.receivedAt}`,
          [this.fields.observation]: text,
        },
      });
      head.tail.push({
        subject: created.subject,
        id: incremental.id,
        receivedAt: incremental.receivedAt,
        bytes: text.length,
      });
      this.appended++;
    }

    this.current = fold(this.current, [incremental]);

    if (incremental.complete && incremental.scope.type === 'range') {
      head.coverage = mergeCoverage(
        head.coverage,
        this.current.coverage.filter(
          c => c.confirmedAt === incremental.receivedAt,
        ),
      );
      head.lastComplete = incremental.receivedAt;
    }

    this.dirty = true;

    return incremental;
  }

  /** Writes a snapshot when the tail is long enough (#97 §2.5). */
  async compactIfNeeded(): Promise<boolean> {
    if (!this.head) return false;
    const bytes = this.head.tail.reduce((sum, e) => sum + e.bytes, 0);
    if (
      this.head.tail.length < COMPACT_AFTER_INCREMENTALS &&
      bytes < COMPACT_AFTER_BYTES
    )
      return false;
    await this.writeSnapshot();

    return true;
  }

  /** Saves the head if anything changed since the last save. */
  async flush(): Promise<void> {
    if (!this.dirty || !this.headSubject || !this.head) return;
    const resource = await this.store.getResource(this.headSubject);
    const stored = (() => {
      try {
        return parse<HeadState>(resource.get(this.fields.head), 'log head');
      } catch {
        return undefined;
      }
    })();

    // Keep what another device appended since this one read the head.
    if (stored && stored.snapshot === this.head.snapshot) {
      const known = new Set(this.head.tail.map(e => e.id));
      this.head.tail.push(...stored.tail.filter(e => !known.has(e.id)));
      this.head.coverage = mergeCoverage(this.head.coverage, stored.coverage);
    }

    resource.set(this.fields.head, JSON.stringify(this.head));
    await resource.save();
    this.dirty = false;
  }

  private async ensureHead(): Promise<HeadState> {
    if (this.head) return this.head;
    const app = await this.store.getResource(await this.store.getApp());
    const created = await this.store.newResource({
      parent: app.subject,
      propVals: { [NAME]: 'Clockify observation log' },
    });
    this.headSubject = created.subject;
    const first = await this.store.newResource({
      parent: created.subject,
      propVals: {
        [NAME]: 'Clockify snapshot (empty)',
        [this.fields.snapshot]: JSON.stringify({
          v: 1,
          mirror: emptyMirror(),
          cut: null,
          previous: null,
          compacted: [],
          writtenAt: new Date(this.options.clock()).toISOString(),
        } satisfies SnapshotState),
      },
    });
    this.head = {
      v: 1,
      snapshot: first.subject,
      cut: null,
      tail: [],
      coverage: [],
    };
    created.set(this.fields.head, JSON.stringify(this.head));
    await created.save();
    app.set(this.fields.log, created.subject);
    await app.save();

    return this.head;
  }

  private async writeSnapshot() {
    const head = this.head!;
    const cut = [
      ...head.tail,
      ...(head.cut ? [head.cut] : []),
    ].reduce<Position | null>(
      (max, e) => (!max || comparePositions(e, max) > 0 ? e : max),
      null,
    );
    const writtenAt = new Date(this.options.clock()).toISOString();
    const state: SnapshotState = {
      v: 1,
      mirror: this.current,
      cut: cut && { receivedAt: cut.receivedAt, id: cut.id },
      previous: head.snapshot,
      compacted: head.tail,
      writtenAt,
    };
    const created = await this.store.newResource({
      parent: this.headSubject,
      propVals: {
        [NAME]: `Clockify snapshot ${writtenAt}`,
        [this.fields.snapshot]: JSON.stringify(state),
      },
    });
    this.head = {
      ...head,
      snapshot: created.subject,
      cut: state.cut,
      tail: [],
    };
    this.snapshotsWritten++;
    this.dirty = true;
  }
}

async function readSnapshot(
  store: PluginStore,
  fields: CompleteSchema['log'],
  subject: string,
): Promise<SnapshotState> {
  return parse<SnapshotState>(
    (await store.getResource(subject)).get(fields.snapshot),
    'Clockify snapshot',
  );
}

async function readIncrementals(
  store: PluginStore,
  fields: CompleteSchema['log'],
  entries: readonly TailEntry[],
): Promise<Incremental[]> {
  const out: Incremental[] = [];

  for (const entry of entries)
    out.push(
      parse<Incremental>(
        (await store.getResource(entry.subject)).get(fields.observation),
        'Clockify observation',
      ),
    );

  return out;
}

/** Every incremental any snapshot in the chain absorbed. */
async function readChain(
  store: PluginStore,
  fields: CompleteSchema['log'],
  newest: SnapshotState,
): Promise<Incremental[]> {
  const all: Incremental[] = [];
  let snapshot: SnapshotState | undefined = newest;

  while (snapshot) {
    all.push(...(await readIncrementals(store, fields, snapshot.compacted)));
    snapshot = snapshot.previous
      ? await readSnapshot(store, fields, snapshot.previous)
      : undefined;
  }

  return all;
}
