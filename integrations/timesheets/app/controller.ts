// @wc-ignore-file
import type { LookbackDays } from '../localthought.js';
import {
  fetchSetupOptions,
  type RawNamed,
  type SetupOptions,
} from './clockifyApi.js';
import { readSettings, type Settings } from './config.js';
import { timesheetFromMirror } from './model/source.js';
import { browserTimeZone } from './model/time.js';
import type { Timesheet } from './model/types.js';
import { emptyMirror, type Mirror } from './observations.js';
import { classify, type Problem } from './problem.js';
import { ensureSchema, findSchema } from './schema.js';
import type { ConnectionReference, PluginStore } from './store.js';
import { syncClockify, type SyncResult } from './sync.js';
import { PLATFORM, relayTransport, type ProxyTransport } from './transport.js';
import { readMirror } from './viewData.js';

/**
 * Everything the view shows, as data, so it is testable without a DOM. The
 * DOM in `main.ts` only renders a `ViewState` and wires the controls.
 */
export type ViewState =
  | { kind: 'loading' }
  /** The host has no proxy relay (atomic-server#1624 not in this build). */
  | { kind: 'no-proxy' }
  | { kind: 'not-connected' }
  | { kind: 'connecting' }
  | {
      kind: 'setup';
      connection: ConnectionReference;
      /** What was stored before, if anything: preselected in the form. */
      draft: Partial<Settings>;
      options?: SetupOptions;
      busy?: 'options' | 'saving';
      error?: string;
    }
  | {
      kind: 'ready';
      connection: ConnectionReference;
      settings: Settings;
      last?: SyncOutcome;
    }
  | {
      kind: 'syncing';
      connection: ConnectionReference;
      settings: Settings;
      progress?: SyncProgressState;
    }
  /** The app itself cannot run: no table, a broken schema, a host error. */
  | { kind: 'failed'; message: string };

export type SyncOutcome =
  | { ok: true; result: SyncResult; at: number }
  | { ok: false; error: string; at: number; problem: Problem };

/** Design frame H: which page is being read, then which row is saved. */
export type SyncProgressState =
  | { phase: 'fetch'; page: number }
  | { phase: 'save'; done: number; total: number };

/** What the views were last given to show, besides the state (#89). */
interface SheetInput {
  mirror: Mirror;
  projects?: RawNamed[];
  members?: RawNamed[];
  weekStart?: string;
  /** Display names from the last sync. */
  userName?: string;
  workspaceName?: string;
}

export interface SettingsChoice {
  workspaceId: string;
  lookbackDays: LookbackDays;
}

export interface Controller {
  state(): ViewState;
  /** Resolves once the view knows what to show; an initial sync runs on. */
  load(): Promise<{ syncing?: Promise<ViewState> }>;
  /** The App resource changed: settings may have arrived. */
  appChanged(): Promise<{ syncing?: Promise<ViewState> }>;
  connect(): Promise<ViewState>;
  openSettings(): Promise<ViewState>;
  saveSettings(choice: SettingsChoice): Promise<ViewState>;
  sync(): Promise<ViewState>;
  /** Back from the settings form to `ready`, without saving (#89 frame M). */
  cancelSettings(): ViewState;
  /** Change only the look-back window, then sync (#89 frames I and J). */
  setLookback(days: LookbackDays): Promise<ViewState>;
  /** Ask the host to connect again after a 401 (#89 frame J). */
  reconnect(): Promise<ViewState>;
  /** Whether the host can forget the connection (`store.proxy.disconnect`). */
  canDisconnect(): boolean;
  disconnect(): Promise<ViewState>;
  /** The account and workspace names the last sync read, if any. */
  names(): { userName?: string; workspaceName?: string };
  /** The timesheet the views show, or undefined before anything was read. */
  sheet(now?: number): Timesheet | undefined;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createController(
  store: PluginStore,
  onChange: (state: ViewState) => void = () => {},
  now: () => number = Date.now,
): Controller {
  let current: ViewState = { kind: 'loading' };
  let running = false;
  let input: SheetInput | undefined;
  const timeZone = browserTimeZone();

  const settingsOf = (state: ViewState): Settings | undefined =>
    state.kind === 'ready' || state.kind === 'syncing'
      ? state.settings
      : state.kind === 'setup'
        ? readComplete(state.draft)
        : undefined;

  /** The log is read-only here; a failure only means nothing to show yet. */
  const readInput = async () => {
    try {
      input = { ...input, mirror: await readMirror(store, now) };
    } catch {
      input ??= { mirror: emptyMirror() };
    }
  };

  const set = (next: ViewState) => {
    current = next;
    onChange(next);

    return next;
  };

  const loadOptions = async (
    connection: ConnectionReference,
    draft: Partial<Settings>,
  ) => {
    const proxy = store.proxy!;
    set({ kind: 'setup', connection, draft, busy: 'options' });

    try {
      const options = await fetchSetupOptions(
        relayTransport(proxy, connection),
      );

      return set({ kind: 'setup', connection, draft, options });
    } catch (error) {
      return set({ kind: 'setup', connection, draft, error: message(error) });
    }
  };

  const controller: Controller = {
    state: () => current,

    async load() {
      const proxy = store.proxy;

      if (!proxy || typeof proxy.connections !== 'function') {
        // Entries imported earlier still show, read-only (#89 frame K).
        await readInput();
        set({ kind: 'no-proxy' });

        return {};
      }

      try {
        const [connection] = await proxy.connections({ platform: PLATFORM });

        if (!connection) {
          set({ kind: 'not-connected' });

          return {};
        }

        const schema = await findSchema(store);
        const app = await store.getResource(await store.getApp());
        const read = readSettings(p => app.get(p), schema);

        if (!read.ok) {
          await loadOptions(connection, read.partial);

          return {};
        }

        await readInput();
        set({ kind: 'ready', connection, settings: read.settings });

        return { syncing: controller.sync() };
      } catch (error) {
        set({ kind: 'failed', message: message(error) });

        return {};
      }
    },

    async appChanged() {
      // Only while waiting for settings. The host reads local-first, so on
      // open the App can come from a copy older than the settings saved
      // earlier (in this or another browser); the server's copy arrives as
      // a change. In any other state a change is this app's own write or
      // not a reason to interrupt a sync.
      if (current.kind !== 'setup' || current.busy) return {};
      const { connection } = current;

      try {
        const schema = await findSchema(store);
        const app = await store.getResource(await store.getApp());
        const read = readSettings(p => app.get(p), schema);
        if (!read.ok || current.kind !== 'setup' || current.busy) return {};
        set({ kind: 'ready', connection, settings: read.settings });

        return { syncing: controller.sync() };
      } catch {
        return {};
      }
    },

    async connect() {
      if (current.kind !== 'not-connected' || !store.proxy) return current;
      set({ kind: 'connecting' });

      try {
        // Connecting a new account navigates away and reloads this view;
        // picking an existing one resolves `connected`, with no reload.
        const result = await store.proxy.connect({ platform: PLATFORM });

        if (result?.status === 'connected') {
          await controller.load();

          return current;
        }

        return set({ kind: 'not-connected' });
      } catch (error) {
        return set({ kind: 'failed', message: message(error) });
      }
    },

    async openSettings() {
      if (current.kind !== 'ready' && current.kind !== 'setup') return current;
      const draft = current.kind === 'ready' ? current.settings : current.draft;

      return loadOptions(current.connection, draft);
    },

    async saveSettings(choice) {
      if (current.kind !== 'setup' || !current.options) return current;
      const { connection, options } = current;
      const draft = { ...choice, userId: options.user.id };
      set({ ...current, draft, busy: 'saving' });

      try {
        if (!options.workspaces.some(w => w.id === choice.workspaceId))
          throw new Error('Choose one of the listed workspaces');
        const schema = await ensureSchema(store);
        const app = await store.getResource(await store.getApp());
        app.set(schema.settings.workspaceId, choice.workspaceId);
        app.set(schema.settings.userId, options.user.id);
        app.set(schema.settings.lookbackDays, choice.lookbackDays);
        await app.save();
      } catch (error) {
        return set({
          kind: 'setup',
          connection,
          draft,
          options,
          error: message(error),
        });
      }

      set({ kind: 'ready', connection, settings: draft });

      return controller.sync();
    },

    async sync() {
      if (current.kind !== 'ready' || !store.proxy || running) return current;
      running = true;
      const { connection, settings } = current;
      set({ kind: 'syncing', connection, settings });

      const progress = (next: SyncProgressState) => {
        if (current.kind === 'syncing') set({ ...current, progress: next });
      };

      // Counts list pages as the sync reads them, for the progress line.
      const relay = relayTransport(store.proxy, connection);
      const transport: ProxyTransport = {
        request(path, query) {
          if (path.endsWith('/time-entries') && query?.page)
            progress({ phase: 'fetch', page: Number(query.page) });

          return relay.request(path, query);
        },
      };

      try {
        const schema = await ensureSchema(store);
        const result = await syncClockify(
          store,
          transport,
          settings,
          schema,
          now(),
          {
            clock: now,
            onProgress: ({ done, total }) =>
              progress({ phase: 'save', done, total }),
          },
        );
        input = {
          mirror: result.mirror,
          projects: result.projects,
          members: result.members,
          ...(result.account.weekStart
            ? { weekStart: result.account.weekStart }
            : {}),
          ...(result.account.userName
            ? { userName: result.account.userName }
            : {}),
          ...(result.account.workspaceName
            ? { workspaceName: result.account.workspaceName }
            : {}),
        };

        return set({
          kind: 'ready',
          connection,
          settings,
          last: { ok: true, result, at: now() },
        });
      } catch (error) {
        return set({
          kind: 'ready',
          connection,
          settings,
          last: {
            ok: false,
            error: message(error),
            at: now(),
            problem: classify(error, now()),
          },
        });
      } finally {
        running = false;
      }
    },

    cancelSettings() {
      if (current.kind !== 'setup' || current.busy) return current;
      const settings = readComplete(current.draft);
      if (!settings) return current;

      return set({ kind: 'ready', connection: current.connection, settings });
    },

    async setLookback(days) {
      if (current.kind !== 'ready') return current;
      const { connection } = current;
      const settings = { ...current.settings, lookbackDays: days };

      try {
        const schema = await ensureSchema(store);
        const app = await store.getResource(await store.getApp());
        app.set(schema.settings.lookbackDays, days);
        await app.save();
      } catch (error) {
        return set({
          ...current,
          last: {
            ok: false,
            error: message(error),
            at: now(),
            problem: classify(error, now()),
          },
        });
      }

      set({ kind: 'ready', connection, settings });

      return controller.sync();
    },

    async reconnect() {
      if (current.kind !== 'ready' || !store.proxy) return current;
      const before = current;
      set({ kind: 'connecting' });

      try {
        // As connect(): a new account reloads this view; a host that can
        // hand over an existing connection resolves `connected` instead.
        const result: unknown = await store.proxy.connect({
          platform: PLATFORM,
        });

        if ((result as { status?: unknown } | null)?.status === 'connected') {
          await controller.load();

          return current;
        }

        return set(before);
      } catch (error) {
        return set({ kind: 'failed', message: message(error) });
      }
    },

    canDisconnect: () => typeof store.proxy?.disconnect === 'function',

    async disconnect() {
      const proxy = store.proxy;
      if (typeof proxy?.disconnect !== 'function') return current;
      if (current.kind !== 'ready' && current.kind !== 'setup') return current;

      try {
        await proxy.disconnect({ platform: PLATFORM });
      } catch (error) {
        return set({ kind: 'failed', message: message(error) });
      }

      // Imported entries and settings stay; only the connection goes.
      return set({ kind: 'not-connected' });
    },

    names: () => ({
      ...(input?.userName ? { userName: input.userName } : {}),
      ...(input?.workspaceName ? { workspaceName: input.workspaceName } : {}),
    }),

    sheet(at = now()) {
      if (!input) return undefined;
      const settings = settingsOf(current);

      return timesheetFromMirror({
        mirror: input.mirror,
        ...(input.projects ? { projects: input.projects } : {}),
        ...(input.members ? { members: input.members } : {}),
        ...(settings ? { settings } : {}),
        now: at,
        timeZone,
        ...(input.weekStart ? { weekStart: input.weekStart } : {}),
      });
    },
  };

  return controller;
}

function readComplete(draft: Partial<Settings>): Settings | undefined {
  const { workspaceId, userId, lookbackDays } = draft;

  return workspaceId && userId && lookbackDays
    ? { workspaceId, userId, lookbackDays }
    : undefined;
}

/** `90 min`, `6 h`, `1.5 h`: how much of the window no complete read covers. */
const hours = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} min`;

  return `${Math.round(minutes / 6) / 10} h`;
};

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'no-proxy':
      return 'This host cannot reach the integration proxy on behalf of an app, so this app cannot import. Nothing was fetched.';
    case 'not-connected':
      return 'Not connected. Connect a Clockify account to import your completed time entries. Nothing is written to Clockify.';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'failed':
      return `This app cannot run: ${state.message}`;

    case 'setup':
      if (state.busy === 'options')
        return 'Connected. Reading your Clockify workspaces…';
      if (state.busy === 'saving') return 'Saving settings…';
      if (state.error) return `Setup failed: ${state.error}`;

      return 'Connected. Choose the workspace and how far back to import.';

    case 'syncing':
      return `Importing the last ${state.settings.lookbackDays} days…`;

    case 'ready': {
      if (!state.last)
        return `Ready to import the last ${state.settings.lookbackDays} days of Clockify entries.`;
      if (!state.last.ok)
        return `Import failed: ${state.last.error}. Rows already in the table are kept.`;
      const { created, updated, unchanged, removed, warnings, log } =
        state.last.result;

      return (
        `Last synced ${new Date(state.last.at).toLocaleTimeString()}: ` +
        `${created} created, ${updated} updated, ${unchanged} unchanged, ` +
        `last ${state.settings.lookbackDays} days.` +
        (removed ? ` ${removed} removed (deleted in Clockify).` : '') +
        (log.candidates
          ? ` ${log.candidates} missing from Clockify's list, re-checked on the next sync.`
          : '') +
        (log.unknownMs ? ` ${hours(log.unknownMs)} not loaded.` : '') +
        (state.last.result.account.forceProjects
          ? ' This workspace requires a project on every entry.'
          : '') +
        (warnings.length ? ` Warnings: ${warnings.join('; ')}` : '')
      );
    }
  }
}
