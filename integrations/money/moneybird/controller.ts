// @wc-ignore-file
import { readAdministrations, type Administration } from './read.js';
import {
  ADMINISTRATION,
  ensureProperties,
  PLATFORM,
  relayGet,
  syncContacts,
  type SyncSummary,
} from './sync.js';
import type { ConnectionReference, PluginStore } from './store.js';

export type ViewState =
  | { kind: 'loading' }
  /** The host has no proxy relay (atomic-server#1624 not in this build). */
  | { kind: 'no-relay' }
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | {
      kind: 'choosing';
      connection: ConnectionReference;
      administrations: Administration[];
    }
  | { kind: 'syncing'; connection: ConnectionReference; administration: string }
  | {
      kind: 'synced';
      connection: ConnectionReference;
      administration: string;
      at: Date;
      summary: SyncSummary;
    }
  | {
      kind: 'error';
      message: string;
      connection?: ConnectionReference;
      administration?: string;
    };

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'no-relay':
      return 'This host cannot reach the integration proxy for apps yet.';
    case 'disconnected':
      return 'Not connected. Connect Moneybird to import your contacts (read-only).';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'choosing':
      return state.administrations.length
        ? 'Choose the Moneybird administration to import contacts from.'
        : 'This Moneybird account has no administrations to import from.';
    case 'syncing':
      return 'Importing contacts…';

    case 'synced': {
      const s = state.summary;

      return `Last synced ${state.at.toLocaleTimeString()}: ${s.total} contacts (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged).`;
    }

    case 'error':
      return `Refresh failed: ${state.message} Contacts imported earlier are kept.`;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createController(
  store: PluginStore,
  render: (state: ViewState) => void,
) {
  let state: ViewState = { kind: 'loading' };

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  const chosen = async (): Promise<string | undefined> => {
    const property = (await ensureProperties(store, [ADMINISTRATION])).get(
      ADMINISTRATION.shortname,
    )!;
    const value = (await store.getResource(await store.getApp())).get(property);

    return typeof value === 'string' && value ? value : undefined;
  };

  const choose = async (connection: ConnectionReference) => {
    const administrations = await readAdministrations(
      relayGet(store.proxy!, connection),
    );
    set({ kind: 'choosing', connection, administrations });
  };

  return {
    state: () => state,

    /**
     * Finds this app's connection and administration, then starts one sync.
     * Resolves once that is known, not when the sync ends.
     */
    async load(): Promise<{ syncing?: Promise<void> }> {
      const proxy = store.proxy;
      if (!proxy) return (set({ kind: 'no-relay' }), {});
      const [connection] = await proxy.connections({ platform: PLATFORM });
      if (!connection) return (set({ kind: 'disconnected' }), {});

      try {
        const administration = await chosen();

        if (!administration) {
          await choose(connection);

          return {};
        }

        return { syncing: this.sync(connection, administration) };
      } catch (error) {
        set({ kind: 'error', connection, message: message(error) });

        return {};
      }
    },

    async connect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'connecting' });

      try {
        // On consent the host navigates away and this view reloads; the
        // promise only settles when the person cancels.
        await proxy.connect({ platform: PLATFORM });
        set({ kind: 'disconnected' });
      } catch (error) {
        set({ kind: 'error', message: message(error) });
      }
    },

    /** Stores the administration on the App resource, then imports it. */
    async select(administration: string): Promise<void> {
      if (state.kind !== 'choosing') return;
      const { connection } = state;

      try {
        const property = (await ensureProperties(store, [ADMINISTRATION])).get(
          ADMINISTRATION.shortname,
        )!;
        await (
          await store.getResource(await store.getApp())
        )
          .set(property, administration)
          .save();
      } catch (error) {
        return set({ kind: 'error', connection, message: message(error) });
      }

      await this.sync(connection, administration);
    },

    async change(): Promise<void> {
      if (!('connection' in state) || !state.connection) return;
      const { connection } = state;

      try {
        await choose(connection);
      } catch (error) {
        set({ kind: 'error', connection, message: message(error) });
      }
    },

    async sync(
      connection = 'connection' in state ? state.connection : undefined,
      administration = 'administration' in state
        ? state.administration
        : undefined,
    ): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      if (!connection || !administration || state.kind === 'syncing') return;
      set({ kind: 'syncing', connection, administration });

      try {
        const summary = await syncContacts(
          store,
          relayGet(proxy, connection),
          administration,
        );
        set({
          kind: 'synced',
          connection,
          administration,
          at: new Date(),
          summary,
        });
      } catch (error) {
        set({
          kind: 'error',
          connection,
          administration,
          message: message(error),
        });
      }
    },
  };
}
