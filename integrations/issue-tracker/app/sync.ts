// @wc-ignore-file
/**
 * One sync pass: the Devonian GitHub issues Bridge between the app's table
 * and one GitHub repository, with the host's relay as its only network and
 * the app's own sync resource as its only storage.
 *
 * GitHub writes go through `reviewGate`: a pass never sends a create or an
 * update to GitHub that a person has not approved in this view, content
 * included (see devonian/github-issues/review.mjs). Everything the pass
 * would send is returned as `held`. Writes into the app's own table (the
 * import) are not gated, as for pets and notion.
 */
import {
  AtomicIdentityMap,
  AtomicLens,
  AtomicSchema,
  AtomicStore,
} from 'devonian/atomic';
import { Datatype } from '@tomic/lib';
// Plain JS modules of the lens; see devonian/github-issues/README.md.
import { Bridge } from '../devonian/github-issues/bridge.mjs';
import { AtomicPort, GitHubPort } from '../devonian/github-issues/ports.mjs';
import { proxyTransport } from '../devonian/github-issues/proxy.mjs';
import { reviewGate } from '../devonian/github-issues/review.mjs';
import {
  frameStore,
  type FrameAtomicStore,
  type Overlay,
} from './frameStore.js';
import type { SyncState } from './state.js';
import type { HostProxy, PluginStore } from './store.js';
import {
  ABOUT,
  DESCRIPTION,
  LOCAL_ID,
  PARENT,
  type Tracker,
} from './tracker.js';
import { relayDispatch, type Dispatch } from './transport.js';

/** Stable, so saved snapshots keep binding (`Bridge` checks `binding.base`). */
export const BRIDGE_BASE = 'https://github-issues-app.invalid/bridge';

export type Status = 'Todo' | 'Doing' | 'Done';

export interface Held {
  subject: string;
  /** `issue`, or `comment:<issue subject>`. */
  entity: string;
  /** GitHub issue number or comment id; undefined for a create. */
  remoteId?: number;
  before?: { title?: string; body: string; status?: Status };
  after: { title?: string; body: string; status?: Status };
  key: string;
  /** For a comment: its issue's GitHub number, when the issue has one. */
  issueNumber?: number;
  /** An earlier approved attempt got no answer; it may have reached GitHub. */
  unconfirmed?: boolean;
  /** The Atomic resource this write comes from: a table row or a Message. */
  local?: string;
}

export interface Label {
  name: string;
  color?: string;
}

export interface CommentRow {
  subject: string;
  body: string;
  /** GitHub login; absent until GitHub has the comment. */
  author?: string;
  createdAt?: string;
  url?: string;
}

export interface IssueRow {
  subject: string;
  number?: number;
  title: string;
  status: Status;
  body: string;
  labels: Label[];
  assignees: string[];
  /** GitHub's `updated_at`, exact ISO text. */
  updatedAt?: string;
  url?: string;
  author?: string;
  /** Comments in this table (GitHub's plus any waiting to be sent), oldest first. */
  comments: CommentRow[];
}

/** One field of a conflict: last synced value and both sides' current ones. */
export interface ConflictField {
  field: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}

export interface PassResult {
  issues: number;
  comments: number;
  /** Resources the pass created or changed in this drive. */
  addedHere: number;
  updatedHere: number;
  /** Creates and updates sent to GitHub (approved ones only). */
  sentToGitHub: number;
  held: Held[];
  /** The table's issues after the pass, as the Bridge reads them. */
  rows: IssueRow[];
}

/** Error from a pass, with what the view needs to offer a way out. */
export interface PassError extends Error {
  subject?: string;
  entity?: string;
  fields?: string[];
}

/**
 * `AtomicPort` over the frame store. Two app-specific narrowings:
 * - Comments are the Messages in the app's own comments folder. A comment
 *   made in the data-browser's comment panel on a row lives in the drive's
 *   comments folder, outside the app's subtree, which the app cannot write
 *   back to; it is left alone instead of failing every pass.
 * - The GitHub source is stored as JSON text (a string property), so its
 *   key order, which the Bridge compares, survives the round trip.
 */
class FrameAtomicPort extends AtomicPort {
  declare store: FrameAtomicStore;
  declare config: { commentsFolder: string; provenance: string };

  async subjects(property: string, value: string): Promise<string[]> {
    const subjects: string[] = await super.subjects(property, value);
    if (property !== ABOUT) return subjects;
    const own: string[] = [];

    for (const subject of subjects) {
      const resource = await this.store.getResource(subject);
      if (resource.get(PARENT) === this.config.commentsFolder)
        own.push(subject);
    }

    return own;
  }

  values(
    entity: string,
    value: unknown,
    metadata: unknown,
    context: unknown,
  ): ReturnType<AtomicPort['values']> {
    const values = super.values(entity, value, metadata, context);
    const all = values as Record<string, unknown>;
    const provenance = this.config.provenance;
    if (all[provenance] !== undefined)
      all[provenance] = JSON.stringify(all[provenance]);

    return values;
  }
}

const devonian = {
  AtomicIdentityMap,
  AtomicLens,
  AtomicSchema,
  AtomicStore,
  Datatype,
};

type Port = {
  scope: string;
  list(...args: unknown[]): Promise<unknown[]>;
  get(...args: unknown[]): Promise<unknown>;
  create(...args: unknown[]): Promise<unknown>;
  update(...args: unknown[]): Promise<unknown>;
};

/** Counts writes that reached a side; `list`/`get` pass through. */
function counted(port: Port, count: { value: number }): Port {
  return {
    get scope() {
      return port.scope;
    },
    list: (...args) => port.list(...args),
    get: (...args) => port.get(...args),
    async create(...args) {
      const result = await port.create(...args);
      count.value++;

      return result;
    },
    async update(...args) {
      const result = await port.update(...args);
      count.value++;

      return result;
    },
  };
}

export interface PassOptions {
  store: PluginStore;
  proxy: HostProxy;
  connectionId: string;
  repository: string;
  tracker: Tracker;
  state: SyncState;
  /** Proposal keys a person approved in this view. */
  approved?: Set<string>;
  /** The app's own saves, corrected for on read; lives as long as the view. */
  overlay?: Overlay;
  /** Tests inject the relay directly. */
  dispatch?: Dispatch;
}

function bridgeFor(options: PassOptions) {
  const { store, repository, tracker, state } = options;
  const atomicStore = frameStore(store, {
    known: state.state.known,
    indexed: [PARENT, ABOUT, LOCAL_ID],
    ...(options.overlay ? { overlay: options.overlay } : {}),
  });
  const local = new FrameAtomicPort(atomicStore, {
    connection: {
      drive: tracker.app,
      table: tracker.table,
      rowClass: tracker.rowClass,
      body: 'https://atomicdata.dev/properties/description',
      status: tracker.properties.status,
      number: tracker.properties.number,
      tags: tracker.tags,
    },
    provenance: tracker.properties.provenance,
    commentsFolder: tracker.commentsFolder,
  });
  const transport = proxyTransport({
    repository,
    journal: state.state.journal,
    save: () => state.saveJournal(),
    dispatch:
      options.dispatch ?? relayDispatch(options.proxy, options.connectionId),
  });
  const remote = new GitHubPort(undefined, { repository }, transport);
  const sent = { value: 0 };
  const bridge = new Bridge({
    devonian,
    local,
    remote: reviewGate(counted(remote, sent), options.approved ?? new Set()),
    base: BRIDGE_BASE,
    snapshot: state.state.snapshot,
    save: (snapshot: unknown) => state.saveSnapshot(snapshot),
  });

  return { bridge, atomicStore, sent, local };
}

async function summary(
  bridge: Bridge,
  atomicStore: FrameAtomicStore,
  sent: { value: number },
  local: FrameAtomicPort,
  options: PassOptions,
): Promise<PassResult> {
  const writes = { ...atomicStore.writes };
  const comments = await commentsByIssue(atomicStore, options);
  const rows = (
    (await local.list('issue')) as {
      id: string;
      remoteId?: number;
      value: { title: string; body: string; status: Status };
      metadata?: Record<string, unknown>;
    }[]
  ).map(row => issueRow(row, comments.get(row.id) ?? []));
  const bound = Object.entries(
    bridge.records as Record<string, { entity: string }>,
  ).filter(
    ([subject, record]) =>
      bridge.id('local', record.entity, subject) !== undefined &&
      bridge.id('remote', record.entity, subject) !== undefined,
  );

  return {
    issues: bound.filter(([, r]) => r.entity === 'issue').length,
    comments: bound.filter(([, r]) => r.entity !== 'issue').length,
    addedHere: writes.creates,
    updatedHere: writes.saves,
    sentToGitHub: sent.value,
    held: [...(bridge.held as Map<string, Held>).values()].map(held => {
      const at = bridge.id('local', held.entity, held.subject);
      const withLocal = typeof at === 'string' ? { ...held, local: at } : held;
      if (held.entity === 'issue') return withLocal;
      const issue = held.entity.slice('comment:'.length);
      const issueNumber = bridge.id('remote', 'issue', issue);

      return issueNumber === undefined
        ? withLocal
        : { ...withLocal, issueNumber };
    }),
    rows,
  };
}

/** One pass. Throws a `PassError`; the state is flushed either way. */
export async function runPass(options: PassOptions): Promise<PassResult> {
  const { bridge, atomicStore, sent, local } = bridgeFor(options);

  // Always written at the end: `known` subjects change on every pass.
  try {
    await bridge.sync();
  } catch (error) {
    // Keep the pass's own error; a failing flush would only hide it.
    await options.state.flush().catch(() => {});
    throw error;
  }

  await options.state.flush();

  return summary(bridge, atomicStore, sent, local, options);
}

/** Per-field detail of a conflict the last pass reported. Reads only. */
export async function describeConflict(
  options: PassOptions,
  subject: string,
): Promise<ConflictField[]> {
  const { bridge } = bridgeFor(options);

  return bridge.describeConflict(subject);
}

export type Side = 'local' | 'remote';

/**
 * Settles a conflict the last pass reported, for one side or per field;
 * writes nothing to either side.
 */
export async function resolveConflict(
  options: PassOptions,
  subject: string,
  keep: Side | Record<string, Side>,
): Promise<string[]> {
  const { bridge } = bridgeFor(options);

  try {
    return await bridge.resolveConflict(subject, keep);
  } finally {
    await options.state.flushIfDirty();
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function issueRow(
  row: {
    id: string;
    remoteId?: number;
    value: { title: string; body: string; status: Status };
    metadata?: Record<string, unknown>;
  },
  comments: CommentRow[],
): IssueRow {
  const m = row.metadata ?? {};
  const labels = Array.isArray(m.labels)
    ? (m.labels as Label[]).filter(l => typeof l?.name === 'string')
    : [];
  const optional = {
    updatedAt: text(m.updatedAt),
    url: text(m.url),
    author: text(m.author),
  };

  return {
    subject: row.id,
    ...(row.remoteId === undefined ? {} : { number: row.remoteId }),
    title: row.value.title,
    status: row.value.status,
    body: row.value.body ?? '',
    labels,
    assignees: Array.isArray(m.assignees)
      ? (m.assignees as unknown[]).filter(
          (a): a is string => typeof a === 'string',
        )
      : [],
    ...Object.fromEntries(
      Object.entries(optional).filter(([, v]) => v !== undefined),
    ),
    comments,
  };
}

/**
 * The Messages in the app's comments folder, by the row they are about,
 * oldest first (GitHub's creation time; not yet sent ones last).
 */
async function commentsByIssue(
  atomicStore: FrameAtomicStore,
  options: PassOptions,
): Promise<Map<string, CommentRow[]>> {
  const { tracker } = options;
  const out = new Map<string, CommentRow[]>();
  const { subjects } = await atomicStore.queryLocalDb({
    drive: tracker.app,
    property: PARENT,
    value: tracker.commentsFolder,
  });

  for (const subject of subjects) {
    const r = await atomicStore.getResource(subject);
    const about = r.get(ABOUT);
    if (typeof about !== 'string') continue;
    let source: Record<string, unknown> = {};

    try {
      const raw = r.get(tracker.properties.provenance);
      if (typeof raw === 'string') source = JSON.parse(raw);
    } catch {
      // Unreadable provenance: shown without an author.
    }

    const comment: CommentRow = {
      subject,
      body: text(r.get(DESCRIPTION)) ?? '',
      ...(text(source.author) ? { author: text(source.author) } : {}),
      ...(text(source.createdAt) ? { createdAt: text(source.createdAt) } : {}),
      ...(text(source.url) ? { url: text(source.url) } : {}),
    };
    const list = out.get(about) ?? [];
    list.push(comment);
    out.set(about, list);
  }

  for (const list of out.values())
    list.sort((a, b) =>
      (a.createdAt ?? '\uffff').localeCompare(b.createdAt ?? '\uffff'),
    );

  return out;
}
