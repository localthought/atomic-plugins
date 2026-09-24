// @wc-ignore-file
import { endpoint } from '../devonian/github-issues/adapter.js';
import { SyncState } from './state.js';
import type { Overlay } from './frameStore.js';
import type { PluginResource, PluginStore } from './store.js';
import {
  resolveConflict,
  runPass,
  type Held,
  type PassError,
  type PassResult,
} from './sync.js';
import { boundRepository, provision, type Tracker } from './tracker.js';
import { PLATFORM } from './transport.js';

/**
 * Everything the view shows, as data, so it is testable without a DOM.
 * `main.ts` renders a `ViewState` and wires the buttons.
 */
export type Problem =
  /** Same field changed on both sides; `keep` settles it. */
  | { kind: 'conflict'; message: string; subject: string; fields: string[] }
  /** GitHub or the host refused the connection: connect again. */
  | { kind: 'reconnect'; message: string }
  /** A person must look first (uncertain write, missing record, …). */
  | { kind: 'paused'; message: string }
  /** Anything else; "Sync now" retries. */
  | { kind: 'failed'; message: string };

export type Busy = 'syncing' | 'sending' | 'resolving';

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
    }
  | {
      kind: 'ready';
      connectionId: string;
      repository: string;
      busy?: Busy;
      last?: { at: number; result: PassResult };
      problem?: Problem;
    };

export interface Controller {
  state(): ViewState;
  load(): Promise<ViewState>;
  connect(): Promise<ViewState>;
  choose(repository: string): Promise<ViewState>;
  sync(): Promise<ViewState>;
  /** Approve every write the last pass held, then sync once. */
  send(): Promise<ViewState>;
  keep(side: 'local' | 'remote'): Promise<ViewState>;
}

const RECONNECT = [
  /^GitHub \S+ returned 401$/,
  /connection for this app/,
  /^Reconnect before retrying an uncertain request/,
];
const PAUSED = [
  /^Uncertain GitHub write/,
  /^Operation identity reused/,
  /^Missing (local|remote) record/,
  /^State belongs to another connection/,
  /^Duplicate /,
  /^Recovered Atomic create was edited/,
  /^Conflict during saved operation/,
  /^Concurrent edit after write/,
  /^Choose exactly one Todo\/Doing\/Done status/,
  /^Invalid Atomic issue/,
  /may only write its own data/,
  /^Proxy request failed/,
];

export function classify(error: unknown): Problem {
  const e = error as PassError;
  const message = error instanceof Error ? error.message : String(error);
  if (e?.subject && Array.isArray(e.fields))
    return { kind: 'conflict', message, subject: e.subject, fields: e.fields };
  if (RECONNECT.some(p => p.test(message)))
    return { kind: 'reconnect', message };
  if (PAUSED.some(p => p.test(message))) return { kind: 'paused', message };

  return { kind: 'failed', message };
}

interface Session {
  tracker: Tracker;
  sync: PluginResource;
  state: SyncState;
  overlay: Overlay;
}

export function createController(
  store: PluginStore,
  onChange: (state: ViewState) => void = () => {},
  now: () => number = Date.now,
): Controller {
  let current: ViewState = { kind: 'loading' };
  let running = false;
  /**
   * Built on the first pass and kept for the life of the view. The host's
   * reads can lag the app's own writes (see frameStore.ts), so re-reading
   * the sync resource between passes could resume from an older checkpoint.
   */
  let session: Session | undefined;
  let conflict: Problem | undefined;

  const set = (next: ViewState) => {
    current = next;
    onChange(next);

    return next;
  };

  const open = async (repository?: string): Promise<Session> => {
    if (session) return session;
    const provisioned = await provision(store, repository);
    session = {
      tracker: provisioned.tracker,
      sync: provisioned.sync,
      state: new SyncState(
        provisioned.sync,
        provisioned.tracker.properties.syncState,
      ),
      overlay: new Map(),
    };

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

  /** One guarded run; `work` returns the new `last`, or throws. */
  const run = async (
    busy: Busy,
    work: (
      s: Session,
      ready: Extract<ViewState, { kind: 'ready' }>,
    ) => Promise<PassResult | undefined>,
  ) => {
    if (current.kind !== 'ready' || running || !store.proxy) return current;
    running = true;
    const ready = current;
    set({ ...ready, busy });

    try {
      const s = await open(ready.repository);
      const result = await work(s, ready);
      conflict = undefined;

      return set({
        kind: 'ready',
        connectionId: ready.connectionId,
        repository: ready.repository,
        ...(result
          ? { last: { at: now(), result } }
          : ready.last
            ? { last: ready.last }
            : {}),
      });
    } catch (error) {
      const problem = classify(error);
      if (problem.kind === 'conflict') conflict = problem;

      return set({
        kind: 'ready',
        connectionId: ready.connectionId,
        repository: ready.repository,
        ...(ready.last ? { last: ready.last } : {}),
        problem,
      });
    } finally {
      running = false;
    }
  };

  return {
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
      // Resolves only if the person cancels; on Connect the page navigates
      // away and the view comes back fresh.
      await store.proxy.connect({ platform: PLATFORM });

      return this.load();
    },

    async choose(repository) {
      if (current.kind !== 'choose-repository' || current.settingUp)
        return current;
      const { connectionId } = current;
      const name = repository.trim();

      try {
        endpoint(name);
      } catch {
        return set({
          kind: 'choose-repository',
          connectionId,
          error:
            'Enter the repository as owner/name, for example octocat/hello-world.',
        });
      }

      set({ kind: 'choose-repository', connectionId, settingUp: name });

      try {
        await open(name);
      } catch (error) {
        return set({
          kind: 'choose-repository',
          connectionId,
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
      const settled = conflict;
      if (settled?.kind !== 'conflict') return Promise.resolve(current);

      return run('resolving', async (s, ready) => {
        const options = passOptions(s, ready.connectionId, ready.repository);
        await resolveConflict(options, settled.subject, side);

        return runPass(options);
      });
    },
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
