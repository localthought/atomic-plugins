// @wc-ignore-file
import { endpoint } from '../devonian/github-issues/adapter.js';
import { frameStore } from './frameStore.js';
import { SyncState, type ViewPrefs } from './state.js';
import type { Overlay } from './frameStore.js';
import type { PluginResource, PluginStore } from './store.js';
import {
  describeConflict,
  readRows,
  resolveConflict,
  runPass,
  type ConflictField,
  type Held,
  type IssueRow,
  type PassError,
  type PassResult,
  type Side,
  type Status,
} from './sync.js';
import {
  ABOUT,
  DESCRIPTION,
  LOCAL_ID,
  MESSAGE,
  NAME,
  PARENT,
  boundRepository,
  provision,
  type Tracker,
} from './tracker.js';
import { listRepositories, PLATFORM, type Repository } from './transport.js';

/**
 * Everything the view shows, as data, so it is testable without a DOM.
 * `main.ts` renders a `ViewState` and wires the buttons.
 */
export type PausedReason =
  /** A GitHub write got no answer; it may or may not have landed. */
  | 'uncertain'
  /** A record bound on both sides is gone from one of them. */
  | 'missing'
  /** AtomicServer refused a write into the table. */
  | 'rejected'
  | 'other';

export type Problem =
  /** Same field changed on both sides; `keep`/`resolve` settles it. */
  | {
      kind: 'conflict';
      message: string;
      subject: string;
      fields: string[];
      /** The table row (or comment Message) it is about. */
      local?: string;
    }
  /** GitHub or the host refused the connection: connect again. */
  | { kind: 'reconnect'; message: string }
  /** A person must look first (uncertain write, missing record, …). */
  | { kind: 'paused'; message: string; reason: PausedReason }
  /** Anything else; "Sync now" retries. */
  | { kind: 'failed'; message: string };

export type Busy = 'syncing' | 'sending' | 'resolving';

export type RepositoryListing =
  | { kind: 'loading' }
  | { kind: 'listed'; repositories: Repository[] }
  /** The proxy would not list them; the person types owner/name instead. */
  | { kind: 'unavailable'; message: string };

export type ViewState =
  | { kind: 'loading' }
  | { kind: 'no-proxy' }
  | { kind: 'not-connected' }
  | { kind: 'connecting' }
  | {
      kind: 'choose-repository';
      connectionId: string;
      error?: string;
      /** Creating the table's columns for this repository. */
      settingUp?: string;
      listing?: RepositoryListing;
    }
  | {
      kind: 'ready';
      connectionId: string;
      repository: string;
      busy?: Busy;
      last?: { at: number; result: PassResult };
      problem?: Problem;
      /**
       * Rows edited in this view that no pass has seen yet, so the view can
       * mark them "Waiting to send" before the pass that holds them returns.
       */
      touched?: string[];
    };

export type Ready = Extract<ViewState, { kind: 'ready' }>;

export interface IssueInput {
  title: string;
  body: string;
  status: Status;
}

export interface Controller {
  state(): ViewState;
  load(): Promise<ViewState>;
  connect(): Promise<ViewState>;
  /** Lists the connection's repositories for the picker (state 3). */
  listRepositories(): Promise<ViewState>;
  choose(repository: string): Promise<ViewState>;
  sync(): Promise<ViewState>;
  /** Approve every write the last pass held, then sync once. */
  send(): Promise<ViewState>;
  keep(side: Side): Promise<ViewState>;
  /** The paused conflict, field by field; undefined when there is none. */
  conflict(): Promise<ConflictField[] | undefined>;
  /** Settles the paused conflict for one side, or one side per field, then syncs. */
  resolve(choices: Side | Record<string, Side>): Promise<ViewState>;
  /** Writes an edit into the row, shows it at once, then syncs (held for review). */
  edit(subject: string, patch: Partial<IssueInput>): Promise<ViewState>;
  /** Adds a comment Message about the row, then syncs (held for review). */
  comment(subject: string, body: string): Promise<ViewState>;
  /** Adds a row to the table; resolves with its subject once written. */
  create(input: IssueInput): Promise<{ state: ViewState; subject?: string }>;
  /** Board/list choice and filters, kept per installation. */
  prefs(): ViewPrefs;
  savePrefs(prefs: ViewPrefs): Promise<void>;
}

const RECONNECT = [
  /^GitHub \S+ returned 401$/,
  /is delegated to this app/,
  /^The integration proxy refused this connection/,
];
const PAUSED: [RegExp, PausedReason][] = [
  [/^Uncertain GitHub write/, 'uncertain'],
  [/^Proxy request failed/, 'uncertain'],
  [/^Operation identity reused/, 'other'],
  [/^Missing (local|remote) record/, 'missing'],
  [/^State belongs to another connection/, 'other'],
  [/^Duplicate /, 'other'],
  [/^Recovered Atomic create was edited/, 'other'],
  [/^Conflict during saved operation/, 'other'],
  [/^Concurrent edit after write/, 'other'],
  [/^Choose exactly one Todo\/Doing\/Done status/, 'other'],
  [/^Invalid Atomic issue/, 'other'],
  [/^Atomic write (rejected|not acknowledged)/, 'rejected'],
  [/may only write its own data/, 'rejected'],
  // Signature, capability or access refusals: retrying on a timer would
  // only repeat them, so they pause with the proxy's code in Details.
  [/^The integration proxy refused the request/, 'other'],
];

export function classify(error: unknown): Problem {
  const e = error as PassError;
  const message = error instanceof Error ? error.message : String(error);
  if (e?.subject && Array.isArray(e.fields))
    return {
      kind: 'conflict',
      message,
      subject: e.subject,
      fields: e.fields,
      ...(e.local ? { local: e.local } : {}),
    };
  if (RECONNECT.some(p => p.test(message)))
    return { kind: 'reconnect', message };
  const paused = PAUSED.find(([p]) => p.test(message));
  if (paused) return { kind: 'paused', message, reason: paused[1] };

  return { kind: 'failed', message };
}

interface Session {
  tracker: Tracker;
  sync: PluginResource;
  state: SyncState;
  overlay: Overlay;
}

const statusOf = (value: unknown): Status | undefined =>
  value === 'Todo' || value === 'Doing' || value === 'Done' ? value : undefined;

export function createController(
  store: PluginStore,
  onChange: (state: ViewState) => void = () => {},
  now: () => number = Date.now,
): Controller {
  let current: ViewState = { kind: 'loading' };
  /**
   * One pass or table write at a time. Edits made while a pass runs wait
   * for it, so the Bridge never sees a row change under its own write.
   */
  let queue: Promise<unknown> = Promise.resolve();
  /**
   * Built on the first pass and kept for the life of the view. The host's
   * reads can lag the app's own writes (see frameStore.ts), so re-reading
   * the sync resource between passes could resume from an older checkpoint.
   */
  let session: Session | undefined;
  let conflict: Problem | undefined;
  let prefs: ViewPrefs = {};
  /** Optimistic changes per touched row, re-applied until a pass has seen it. */
  const changes = new Map<string, (row: IssueRow) => IssueRow>();

  const set = (next: ViewState) => {
    current = next;
    onChange(next);

    return next;
  };

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});

    return next;
  };

  const open = async (repository?: string): Promise<Session> => {
    if (session) return session;
    const provisioned = await provision(store, repository);
    const state = new SyncState(
      provisioned.sync,
      provisioned.tracker.properties.syncState,
    );
    session = {
      tracker: provisioned.tracker,
      sync: provisioned.sync,
      state,
      overlay: new Map(),
    };
    prefs = { ...state.state.view };

    return session;
  };

  const passOptions = (
    s: Session,
    connectionId: string,
    repository: string,
  ) => ({
    store,
    proxy: store.proxy!,
    connectionId,
    repository,
    tracker: s.tracker,
    state: s.state,
    overlay: s.overlay,
  });

  /** The frame store the Bridge uses, so the app's own edits read back. */
  const tableStore = (s: Session) =>
    frameStore(store, {
      known: s.state.state.known,
      indexed: [PARENT, ABOUT, LOCAL_ID],
      overlay: s.overlay,
    });

  const latest = (fallback: Ready): Ready =>
    current.kind === 'ready' ? current : fallback;

  /** One guarded run; `work` returns the new `last`, or throws. */
  const run = (
    busy: Busy,
    work: (s: Session, ready: Ready) => Promise<PassResult | undefined>,
  ) =>
    serial(async () => {
      if (current.kind !== 'ready' || !store.proxy) return current;
      const ready = current;
      set({ ...ready, busy });

      try {
        const s = await open(ready.repository);
        const result = await work(s, ready);
        conflict = undefined;
        const after = latest(ready);
        // Rows touched while this pass ran are not in its result yet.
        const touched = (after.touched ?? []).filter(
          t => !(ready.touched ?? []).includes(t),
        );
        for (const subject of changes.keys())
          if (!touched.includes(subject)) changes.delete(subject);

        return set({
          kind: 'ready',
          connectionId: ready.connectionId,
          repository: ready.repository,
          ...(result
            ? { last: { at: now(), result: withChanges(result) } }
            : after.last
              ? { last: after.last }
              : {}),
          ...(touched.length ? { touched } : {}),
        });
      } catch (error) {
        const problem = classify(error);
        if (problem.kind === 'conflict') conflict = problem;
        const after = latest(ready);
        let last = after.last;

        // Still show the table as it is now, e.g. after a reload into a
        // paused sync. `at: 0` (no completed pass) keeps moving disabled.
        if (session) {
          try {
            const rows = await readRows(
              passOptions(session, ready.connectionId, ready.repository),
            );
            last = {
              at: after.last?.at ?? 0,
              result: withChanges({
                ...(after.last?.result ?? emptyResult()),
                rows,
              }),
            };
          } catch {
            // Keep what was shown.
          }
        }

        return set({
          kind: 'ready',
          connectionId: ready.connectionId,
          repository: ready.repository,
          ...(last ? { last } : {}),
          ...(after.touched?.length ? { touched: after.touched } : {}),
          problem,
        });
      }
    });

  const apply = (
    rows: IssueRow[],
    subject: string,
    change: (row: IssueRow) => IssueRow,
  ) =>
    rows.some(r => r.subject === subject)
      ? rows.map(r => (r.subject === subject ? change(r) : r))
      : [...rows, change(blankRow(subject))];

  /** A pass result with the edits it has not seen yet laid over it. */
  const withChanges = (result: PassResult): PassResult => {
    let rows = result.rows;
    for (const [subject, change] of changes)
      rows = apply(rows, subject, change);

    return rows === result.rows ? result : { ...result, rows };
  };

  /** Shows `change` on the row at once, marked as touched. */
  const optimistic = (subject: string, change: (row: IssueRow) => IssueRow) => {
    if (current.kind !== 'ready') return;
    const ready = current;
    const earlier = changes.get(subject);
    changes.set(subject, earlier ? row => change(earlier(row)) : change);
    set({
      ...ready,
      last: {
        at: ready.last?.at ?? 0,
        result: {
          ...(ready.last?.result ?? emptyResult()),
          rows: apply(ready.last?.result.rows ?? [], subject, change),
        },
      },
      touched: [...new Set([...(ready.touched ?? []), subject])],
    });
  };

  /** A table write, in turn with passes; a refusal becomes the problem. */
  const write = async (
    ready: Ready,
    work: (s: Session) => Promise<void>,
  ): Promise<boolean> => {
    try {
      await serial(async () => work(await open(ready.repository)));

      return true;
    } catch (error) {
      set({ ...latest(ready), problem: classify(error) });

      return false;
    }
  };

  const controller: Controller = {
    state: () => current,

    async load() {
      const proxy = store.proxy;
      if (!proxy || typeof proxy.connections !== 'function')
        return set({ kind: 'no-proxy' });
      const repository = await boundRepository(store);
      let stale: string[] = [];

      if (repository) {
        const s = await open(repository);
        stale = s.state.state.stale;
      }

      const connection = (await proxy.connections({ platform: PLATFORM })).find(
        c => !stale.includes(c.connectionId),
      );
      if (!connection) return set({ kind: 'not-connected' });
      if (!repository)
        return set({
          kind: 'choose-repository',
          connectionId: connection.connectionId,
        });

      return set({
        kind: 'ready',
        connectionId: connection.connectionId,
        repository,
      });
    },

    async connect() {
      if (!store.proxy) return current;
      // A refused connection is not offered again after the reload.
      if (
        current.kind === 'ready' &&
        current.problem?.kind === 'reconnect' &&
        session
      ) {
        session.state.state.stale.push(current.connectionId);
        await session.state.flush();
      } else if (current.kind !== 'not-connected') return current;
      set({ kind: 'connecting' });
      // Resolves when the person cancels or picks an existing connection;
      // connecting a new account navigates away and the view comes back
      // fresh. Either way, the connections decide what shows next.
      await store.proxy.connect({ platform: PLATFORM });

      return this.load();
    },

    async listRepositories() {
      if (current.kind !== 'choose-repository' || !store.proxy) return current;
      const { connectionId } = current;
      set({ ...current, listing: { kind: 'loading' } });
      let listing: RepositoryListing;

      try {
        listing = {
          kind: 'listed',
          repositories: await listRepositories(store.proxy, connectionId),
        };
      } catch (error) {
        listing = {
          kind: 'unavailable',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      if (current.kind !== 'choose-repository') return current;

      return set({ ...current, listing });
    },

    async choose(repository) {
      if (current.kind !== 'choose-repository' || current.settingUp)
        return current;
      const { connectionId, listing } = current;
      const keep = listing ? { listing } : {};
      const name = repository.trim();

      try {
        endpoint(name);
      } catch {
        return set({
          kind: 'choose-repository',
          connectionId,
          ...keep,
          error:
            'Enter the repository as owner/name, for example octocat/hello-world.',
        });
      }

      set({
        kind: 'choose-repository',
        connectionId,
        ...keep,
        settingUp: name,
      });

      try {
        await open(name);
      } catch (error) {
        return set({
          kind: 'choose-repository',
          connectionId,
          ...keep,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      set({ kind: 'ready', connectionId, repository: name });

      return this.sync();
    },

    sync() {
      return run('syncing', (s, ready) =>
        runPass(passOptions(s, ready.connectionId, ready.repository)),
      );
    },

    send() {
      const held = current.kind === 'ready' ? current.last?.result.held : [];

      return run('sending', (s, ready) =>
        runPass({
          ...passOptions(s, ready.connectionId, ready.repository),
          approved: new Set((held ?? []).map(h => h.key)),
        }),
      );
    },

    keep(side) {
      return this.resolve(side);
    },

    async conflict() {
      const paused = conflict;
      if (paused?.kind !== 'conflict' || current.kind !== 'ready')
        return undefined;
      const ready = current;

      return serial(async () => {
        const s = await open(ready.repository);

        return describeConflict(
          passOptions(s, ready.connectionId, ready.repository),
          paused.subject,
        );
      });
    },

    resolve(choices) {
      const settled = conflict;
      if (settled?.kind !== 'conflict') return Promise.resolve(current);

      return run('resolving', async (s, ready) => {
        const options = passOptions(s, ready.connectionId, ready.repository);
        await resolveConflict(options, settled.subject, choices);

        return runPass(options);
      });
    },

    async edit(subject, patch) {
      if (current.kind !== 'ready') return current;
      const ready = current;
      optimistic(subject, row => ({
        ...row,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      }));
      const ok = await write(ready, async s => {
        const row = await tableStore(s).getResource(subject);
        if (patch.title !== undefined) row.set(NAME, patch.title);
        if (patch.body !== undefined) row.set(DESCRIPTION, patch.body);
        const status = statusOf(patch.status);
        if (status)
          row.set(s.tracker.properties.status, [s.tracker.tags[status]]);
        await row.save();
      });

      return ok ? this.sync() : current;
    },

    async comment(subject, body) {
      if (current.kind !== 'ready' || !body.trim()) return current;
      const ready = current;
      let created = '';
      const ok = await write(ready, async s => {
        const message = await tableStore(s).newResource({
          parent: s.tracker.commentsFolder,
          isA: [MESSAGE],
          propVals: { [DESCRIPTION]: body, [ABOUT]: subject },
        });
        created = message.subject;
      });
      if (!ok) return current;
      optimistic(subject, row => ({
        ...row,
        comments: [...row.comments, { subject: created, body }],
      }));

      return this.sync();
    },

    async create(input) {
      if (current.kind !== 'ready') return { state: current };
      const ready = current;
      let subject = '';
      const ok = await write(ready, async s => {
        const row = await tableStore(s).newResource({
          parent: s.tracker.table,
          isA: [s.tracker.rowClass],
          propVals: {
            [NAME]: input.title,
            [DESCRIPTION]: input.body,
            [s.tracker.properties.status]: [s.tracker.tags[input.status]],
          },
        });
        subject = row.subject;
      });
      if (!ok) return { state: current };
      optimistic(subject, row => ({ ...row, ...input }));

      return { state: await this.sync(), subject };
    },

    prefs: () => ({ ...prefs }),

    async savePrefs(next) {
      prefs = { ...next };
      if (!session) return;
      const s = session;
      s.state.state.view = { ...next };
      await serial(() => s.state.flush());
    },
  };

  return controller;
}

function emptyResult(): PassResult {
  return {
    issues: 0,
    comments: 0,
    addedHere: 0,
    updatedHere: 0,
    sentToGitHub: 0,
    held: [],
    rows: [],
  };
}

function blankRow(subject: string): IssueRow {
  return {
    subject,
    title: '',
    status: 'Todo',
    body: '',
    labels: [],
    assignees: [],
    comments: [],
  };
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'no-proxy':
      return 'This host cannot reach the integration proxy on behalf of an app, so this app cannot sync. Nothing was fetched.';
    case 'not-connected':
      return 'Not connected. Connect a GitHub account to sync one repository’s issues and comments with this table.';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'choose-repository':
      if (state.settingUp)
        return `Setting up this table for ${state.settingUp}…`;

      return (
        state.error ??
        'Connected. Choose the repository to sync with this table.'
      );

    case 'ready': {
      if (state.busy === 'syncing') return `Syncing with ${state.repository}…`;
      if (state.busy === 'sending')
        return `Sending approved changes to ${state.repository}…`;
      if (state.busy === 'resolving')
        return 'Settling the conflict, then syncing…';

      if (state.problem) {
        const { kind, message } = state.problem;
        if (kind === 'conflict')
          return `Sync paused: ${state.problem.fields.join(', ')} changed both here and on GitHub since the last sync. Keep one side to continue. (${message})`;
        if (kind === 'reconnect')
          return `GitHub no longer accepts this connection. Your issues are still here. Reconnect to continue. (${message})`;
        if (kind === 'paused')
          return `Sync paused: ${message}. Nothing is resent automatically; check the issue on GitHub before syncing again.`;

        return `Sync failed: ${message}`;
      }

      if (!state.last)
        return `Bound to ${state.repository}. Sync imports its issues and comments into this table. Nothing is sent to GitHub without your review.`;
      const r = state.last.result;

      return (
        `Last synced ${new Date(state.last.at).toLocaleString()}: ` +
        `${plural(r.issues, 'issue')} and ${plural(r.comments, 'comment')} in sync with ${state.repository}; ` +
        `${r.addedHere} added and ${r.updatedHere} updated here, ${r.sentToGitHub} sent to GitHub.` +
        (r.held.length
          ? ` ${plural(r.held.length, 'change')} waiting for your review before ${r.held.length === 1 ? 'it is' : 'they are'} sent to GitHub.`
          : '')
      );
    }
  }
}

/** One line per held write, in the words the review list shows. */
export function describeHeld(held: Held): string {
  const line = describeChange(held);

  return held.unconfirmed
    ? `${line}. GitHub did not confirm the last attempt, so it may already be there: check GitHub before sending again`
    : line;
}

function describeChange(held: Held): string {
  if (held.entity !== 'issue') {
    const on = held.issueNumber ? `#${held.issueNumber}` : 'a new issue';

    return held.remoteId === undefined
      ? `Add a comment on ${on}: “${held.after.body}”`
      : `Edit comment ${held.remoteId} on ${on} to “${held.after.body}”`;
  }

  if (held.remoteId === undefined)
    return `Create issue “${held.after.title}” (${held.after.status})`;
  const changes: string[] = [];
  const before = held.before;
  if (before?.title !== held.after.title)
    changes.push(`title “${before?.title ?? ''}” → “${held.after.title}”`);
  if (before?.body !== held.after.body) changes.push('description');

  if (before?.status !== held.after.status) {
    const verb =
      held.after.status === 'Done'
        ? 'close it'
        : before?.status === 'Done'
          ? 'reopen it'
          : held.after.status === 'Doing'
            ? 'add the atomic:doing label'
            : 'remove the atomic:doing label';
    changes.push(
      `status ${before?.status ?? '?'} → ${held.after.status} (${verb})`,
    );
  }

  return `Update #${held.remoteId}: ${changes.join('; ') || 'no visible change'}`;
}

/** The primary button's label for a state, or `undefined` for none. */
export function action(
  state: ViewState,
): 'Connect GitHub' | 'Reconnect GitHub' | 'Sync now' | undefined {
  if (state.kind === 'not-connected') return 'Connect GitHub';
  if (state.kind !== 'ready') return undefined;
  if (state.problem?.kind === 'reconnect') return 'Reconnect GitHub';

  return 'Sync now';
}
