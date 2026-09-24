// @wc-ignore-file
import { listCalendars, PLATFORM, type CalendarEntry } from './relay.js';
import type { ConnectionReference, PluginStore } from './store.js';
import {
  chooseCalendar,
  chosenCalendar,
  refresh,
  send,
  type ImportSummary,
  type Outcome,
} from './sync.js';

export type ViewState =
  | { kind: 'loading' }
  /** The host has no proxy relay (atomic-server#1657 not in this build). */
  | { kind: 'no-relay' }
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'choosing'; calendars: CalendarEntry[] }
  | { kind: 'refreshing' }
  | { kind: 'ready'; at: Date; summary: ImportSummary; outcomes: Outcome[] }
  | { kind: 'sending'; summary: ImportSummary }
  | {
      kind: 'error';
      message: string;
      /** The relay has no usable connection left: offer Connect. */
      reconnect: boolean;
      outcomes?: Outcome[];
    };

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'no-relay':
      return 'This host cannot reach the integration proxy for apps yet, so nothing was fetched.';
    case 'disconnected':
      return 'Not connected. Connect Google Calendar to import one calendar.';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'choosing':
      return 'Choose the calendar to import. Recurring events aren’t imported yet.';
    case 'refreshing':
      return 'Reading your calendar…';
    case 'sending':
      return `Sending ${plural(state.summary.review.length, 'change')} to Google…`;

    case 'ready': {
      const s = state.summary;
      const parts = [
        `Last refreshed ${state.at.toLocaleTimeString()}: ${plural(s.total, 'event')} (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged).`,
        `Not imported: ${s.skipped.recurring} recurring, ${s.skipped.cancelled} cancelled.`,
      ];
      if (s.conflicts.length)
        parts.push(`${plural(s.conflicts.length, 'conflict')} left as is.`);
      if (s.review.length)
        parts.push(`${plural(s.review.length, 'change')} to review.`);
      if (s.invalid.length)
        parts.push(
          `${plural(s.invalid.length, 'row')} can’t be sent as edited.`,
        );
      if (s.localOnly)
        parts.push(
          `${plural(s.localOnly, 'row')} made here won’t be sent: creating events isn’t supported.`,
        );

      return parts.join(' ');
    }

    case 'error':
      return `Failed: ${state.message}`;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Relay refusals that mean "this connection is spent", not "Google said no". */
const spent = (error: unknown) =>
  /connect again|reconnect/i.test(message(error));

export function createController(
  store: PluginStore,
  render: (state: ViewState) => void,
  options: { maxPages?: number } = {},
) {
  let state: ViewState = { kind: 'loading' };
  /** Newest last; a spent one is dropped and the next one tried. */
  let connections: ConnectionReference[] = [];
  let calendarId: string | undefined;

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  /** Runs `op` with a usable connection, falling back past spent ones. */
  async function withConnection<T>(
    op: (connectionId: string) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const connection = connections.at(-1);
      if (!connection)
        throw Object.assign(new Error('Reconnect Google Calendar.'), {
          reconnect: true,
        });

      try {
        return await op(connection.connectionId);
      } catch (error) {
        if (!spent(error)) throw error;
        connections = connections.slice(0, -1);
      }
    }
  }

  const fail = (error: unknown, outcomes?: Outcome[]) =>
    set({
      kind: 'error',
      message: message(error),
      reconnect:
        connections.length === 0 ||
        (error as { reconnect?: boolean }).reconnect === true ||
        spent(error),
      ...(outcomes ? { outcomes } : {}),
    });

  const controller = {
    state: () => state,

    /**
     * Finds this app's connection and calendar, and starts one refresh when
     * both are known. Resolves once that is decided, not when the refresh
     * ends, so the host sees the view as rendered straight away.
     */
    async load(): Promise<{ refreshing?: Promise<void> }> {
      const proxy = store.proxy;
      if (!proxy) return (set({ kind: 'no-relay' }), {});
      connections = await proxy.connections({ platform: PLATFORM });
      if (!connections.length) return (set({ kind: 'disconnected' }), {});
      calendarId = await chosenCalendar(store);

      if (!calendarId) {
        await controller.listCalendars();

        return {};
      }

      return { refreshing: controller.refresh() };
    },

    async listCalendars(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'refreshing' });

      try {
        const calendars = await withConnection(id => listCalendars(proxy, id));
        set({ kind: 'choosing', calendars });
      } catch (error) {
        fail(error);
      }
    },

    async choose(id: string): Promise<void> {
      if (state.kind !== 'choosing') return;
      const calendar = state.calendars.find(c => c.id === id);
      if (!calendar) return;

      try {
        await chooseCalendar(store, calendar);
        calendarId = calendar.id;
      } catch (error) {
        return fail(error);
      }

      await controller.refresh();
    },

    async connect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'connecting' });

      try {
        // Connecting a new account navigates away and reloads this view;
        // picking an existing one resolves `connected`, with no reload.
        const result = await proxy.connect({ platform: PLATFORM });
        if (result?.status === 'connected') await controller.load();
        else set({ kind: 'disconnected' });
      } catch (error) {
        fail(error);
      }
    },

    async refresh(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      if (state.kind === 'refreshing' || state.kind === 'sending') return;
      if (!calendarId) return controller.listCalendars();
      set({ kind: 'refreshing' });

      try {
        const summary = await withConnection(id =>
          refresh(store, proxy, id, options),
        );
        set({ kind: 'ready', at: new Date(), summary, outcomes: [] });
      } catch (error) {
        fail(error);
      }
    },

    /** Sends the reviewed edits of the current preview; nothing else. */
    async send(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy || state.kind !== 'ready' || !state.summary.review.length)
        return;
      const { summary, at } = state;
      set({ kind: 'sending', summary });
      let outcomes: Outcome[];

      try {
        outcomes = await withConnection(id =>
          send(store, proxy, id, summary.calendarId, summary.review),
        );
      } catch (error) {
        return fail(error);
      }

      const uncertain = outcomes.find(o => o.status === 'uncertain');
      if (uncertain && uncertain.status === 'uncertain')
        return fail(new Error(uncertain.message), outcomes);
      // The reviewed plan is used up either way: whatever was not sent is
      // reviewed again from a fresh preview.
      set({
        kind: 'ready',
        at,
        summary: { ...summary, review: [] },
        outcomes,
      });
    },
  };

  return controller;
}
