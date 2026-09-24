// @wc-ignore-file
import { describePlatform } from 'syncables/browser';
import { PETS_DOCUMENT, PLATFORM, syncPets, type SyncSummary } from './sync.js';
import { relayTransport } from './transport.js';
import type { ConnectionReference, PluginStore } from './store.js';

export type ViewState =
  | { kind: 'loading' }
  /** The host has no proxy relay (atomic-server#1624 not in this build). */
  | { kind: 'no-relay' }
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'ready'; connection: ConnectionReference }
  | { kind: 'syncing'; connection: ConnectionReference }
  | {
      kind: 'synced';
      connection: ConnectionReference;
      at: Date;
      summary: SyncSummary;
    }
  | { kind: 'error'; message: string; connection?: ConnectionReference };

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'no-relay':
      return 'This host cannot reach the integration proxy for apps yet.';
    case 'disconnected':
      return 'Not connected. Connect your Pets account to import your pets.';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'ready':
      return 'Connected.';
    case 'syncing':
      return 'Syncing…';

    case 'synced': {
      const s = state.summary;
      const errors = s.errors.length ? ` Skipped: ${s.errors.join('; ')}` : '';

      return `Last synced ${state.at.toLocaleTimeString()}: ${s.total} pets (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged).${errors}`;
    }

    case 'error':
      return `Sync failed: ${state.message}`;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createController(
  store: PluginStore,
  render: (state: ViewState) => void,
  sync: typeof syncPets = syncPets,
) {
  let state: ViewState = { kind: 'loading' };

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  const upstream = describePlatform(PETS_DOCUMENT).upstream;

  return {
    state: () => state,

    /**
     * Finds this app's connection and starts one sync when there is one.
     * Resolves once the connection is known, not when the sync ends, so the
     * host sees the view as rendered straight away.
     */
    async load(): Promise<{ syncing?: Promise<void> }> {
      const proxy = store.proxy;

      if (!proxy) {
        set({ kind: 'no-relay' });

        return {};
      }

      const [connection] = await proxy.connections({ platform: PLATFORM });

      if (!connection) {
        set({ kind: 'disconnected' });

        return {};
      }

      set({ kind: 'ready', connection });

      return { syncing: this.sync() };
    },

    async connect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'connecting' });

      try {
        // Connecting a new account navigates away and reloads this view;
        // picking an existing one resolves `connected`, with no reload.
        const result = await proxy.connect({ platform: PLATFORM });
        if (result?.status === 'connected') await this.load();
        else set({ kind: 'disconnected' });
      } catch (error) {
        set({ kind: 'error', message: message(error) });
      }
    },

    async sync(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      if (!('connection' in state) || !state.connection) return;
      if (state.kind === 'syncing') return;
      const connection = state.connection;
      set({ kind: 'syncing', connection });

      try {
        const summary = await sync(
          store,
          relayTransport(proxy, connection, upstream),
        );
        set({ kind: 'synced', connection, at: new Date(), summary });
      } catch (error) {
        set({ kind: 'error', connection, message: message(error) });
      }
    },
  };
}
