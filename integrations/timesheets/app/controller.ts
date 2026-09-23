// @wc-ignore-file
import { readConnectionReference, type ConnectionReference } from './config.js';
import type { PluginStore } from './store.js';
import { syncClockify, type SyncResult } from './sync.js';
import { hostTransport, type ProxyTransport } from './transport.js';

/**
 * Everything the view shows, as data, so it is testable without a DOM. The
 * DOM in `main.ts` only renders a `ViewState` and wires the one button.
 */
export type ViewState =
  | { kind: 'loading' }
  | { kind: 'unconfigured'; missing: string[] }
  | { kind: 'no-proxy'; reference: ConnectionReference }
  | { kind: 'ready'; reference: ConnectionReference; last?: SyncOutcome }
  | { kind: 'syncing'; reference: ConnectionReference };

export type SyncOutcome =
  | { ok: true; result: SyncResult; at: number }
  | { ok: false; error: string; at: number };

export interface Controller {
  state(): ViewState;
  load(): Promise<ViewState>;
  sync(): Promise<ViewState>;
}

export function createController(
  store: PluginStore,
  onChange: (state: ViewState) => void = () => {},
  now: () => number = Date.now,
): Controller {
  let current: ViewState = { kind: 'loading' };
  let transport: ProxyTransport | undefined;
  let running = false;

  const set = (next: ViewState) => {
    current = next;
    onChange(next);

    return next;
  };

  return {
    state: () => current,

    async load() {
      const app = await store.getApp();
      const resource = await store.getResource(app);
      const config = readConnectionReference(p => resource.get(p));
      if (!config.ok)
        return set({ kind: 'unconfigured', missing: config.missing });
      transport = hostTransport(store, config.reference);
      if (!transport)
        return set({ kind: 'no-proxy', reference: config.reference });
      const last = current.kind === 'ready' ? current.last : undefined;

      return set({
        kind: 'ready',
        reference: config.reference,
        ...(last ? { last } : {}),
      });
    },

    async sync() {
      if (current.kind !== 'ready' || !transport || running) return current;
      running = true;
      const { reference } = current;
      set({ kind: 'syncing', reference });

      try {
        const result = await syncClockify(store, transport, reference, now());

        return set({
          kind: 'ready',
          reference,
          last: { ok: true, result, at: now() },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return set({
          kind: 'ready',
          reference,
          last: { ok: false, error: message, at: now() },
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
    case 'unconfigured':
      return `Not connected yet. This app has no Clockify connection reference (missing: ${state.missing.join(', ')}). Connecting happens on the Integrations page, not inside this app.`;
    case 'no-proxy':
      return 'This host cannot reach the integration proxy on behalf of an app yet, so this app cannot sync. Nothing was fetched.';
    case 'syncing':
      return `Syncing the last ${state.reference.lookbackDays} days…`;

    case 'ready': {
      if (!state.last)
        return `Ready to import the last ${state.reference.lookbackDays} days of Clockify entries.`;
      if (!state.last.ok) return `Sync failed: ${state.last.error}`;
      const { created, updated, unchanged, warnings } = state.last.result;

      return (
        `Synced: ${created} created, ${updated} updated, ${unchanged} unchanged.` +
        (warnings.length ? ` Warnings: ${warnings.join('; ')}` : '')
      );
    }
  }
}
