// @wc-ignore-file
import type { OpenApiDocument } from 'syncables/browser';
import type { PluginStore } from './store.js';
import { NOTION_DOCUMENT, syncNotion, type SyncResult } from './sync.js';
import { PLATFORM, syncablesTransport } from './transport.js';

/**
 * Everything the view shows, as data, so it is testable without a DOM.
 * `main.ts` only renders a `ViewState` and wires the button.
 */
export type ViewState =
  | { kind: 'loading' }
  | { kind: 'no-proxy' }
  | { kind: 'not-connected' }
  | { kind: 'connecting' }
  | { kind: 'ready'; connectionId: string; last?: SyncOutcome }
  | { kind: 'syncing'; connectionId: string };

export type SyncOutcome =
  | { ok: true; result: SyncResult; at: number }
  | { ok: false; error: string; at: number };

export interface Controller {
  state(): ViewState;
  load(): Promise<ViewState>;
  connect(): Promise<ViewState>;
  sync(): Promise<ViewState>;
}

const upstream = (doc: OpenApiDocument) =>
  new URL((doc as { servers?: { url: string }[] }).servers?.[0]?.url ?? '');

export function createController(
  store: PluginStore,
  onChange: (state: ViewState) => void = () => {},
  now: () => number = Date.now,
  sync: typeof syncNotion = syncNotion,
): Controller {
  let current: ViewState = { kind: 'loading' };
  let running = false;

  const set = (next: ViewState) => {
    current = next;
    onChange(next);

    return next;
  };

  return {
    state: () => current,

    async load() {
      const proxy = store.proxy;
      if (!proxy || typeof proxy.connections !== 'function')
        return set({ kind: 'no-proxy' });
      const [connection] = await proxy.connections({ platform: PLATFORM });
      if (!connection) return set({ kind: 'not-connected' });
      const last =
        current.kind === 'ready' &&
        current.connectionId === connection.connectionId
          ? current.last
          : undefined;

      return set({
        kind: 'ready',
        connectionId: connection.connectionId,
        ...(last ? { last } : {}),
      });
    },

    async connect() {
      if (current.kind !== 'not-connected' || !store.proxy) return current;
      set({ kind: 'connecting' });
      // Resolves only if the user cancels; on Connect the page navigates
      // away and comes back to a fresh view.
      await store.proxy.connect({ platform: PLATFORM });

      return set({ kind: 'not-connected' });
    },

    async sync() {
      if (current.kind !== 'ready' || !store.proxy || running) return current;
      running = true;
      const { connectionId } = current;
      set({ kind: 'syncing', connectionId });

      try {
        const transport = syncablesTransport(
          store.proxy,
          connectionId,
          upstream(NOTION_DOCUMENT),
        );
        const result = await sync(store, transport);

        return set({
          kind: 'ready',
          connectionId,
          last: { ok: true, result, at: now() },
        });
      } catch (error) {
        return set({
          kind: 'ready',
          connectionId,
          last: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            at: now(),
          },
        });
      } finally {
        running = false;
      }
    },
  };
}

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'no-proxy':
      return 'This host cannot reach the integration proxy on behalf of an app, so this app cannot import. Nothing was fetched.';
    case 'not-connected':
      return 'Not connected. Connect a Notion account to import the pages of the databases you share with it.';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'syncing':
      return 'Importing from Notion…';

    case 'ready': {
      if (!state.last)
        return 'Connected. Import copies the pages of every shared Notion database into this table. Nothing is written to Notion. Edits made in the table are kept; a value changed in both places is reported.';
      if (!state.last.ok) return `Import failed: ${state.last.error}`;
      const { created, updated, unchanged, conflicts, dataSources, warnings } =
        state.last.result;

      return (
        `Last synced ${new Date(state.last.at).toLocaleString()}: ` +
        `${created} created, ${updated} updated, ${unchanged} unchanged, from ${dataSources} ` +
        `${dataSources === 1 ? 'database' : 'databases'}.` +
        (conflicts.length
          ? ` Kept your edits where Notion also changed: ${conflicts
              .map(c => `${c.name} (${c.fields.join(', ')})`)
              .join('; ')}.`
          : '') +
        (warnings.length ? ` Warnings: ${warnings.join('; ')}` : '')
      );
    }
  }
}

/** The one button's label for a state, or `undefined` for no button. */
export function action(
  state: ViewState,
): 'Connect Notion' | 'Sync now' | undefined {
  if (state.kind === 'not-connected') return 'Connect Notion';
  if (state.kind === 'ready' || state.kind === 'syncing') return 'Sync now';

  return undefined;
}
