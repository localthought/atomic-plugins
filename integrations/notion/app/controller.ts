// @wc-ignore-file
import type { OpenApiDocument } from 'syncables/browser';
import { classifyFailure, type ProviderFailure } from './errors.js';
import {
  loadRecord,
  loadSchema,
  saveRecord,
  toRecord,
  type Schema,
  type SyncRecord,
} from './record.js';
import { loadRows, type Row } from './rows.js';
import type { PluginStore } from './store.js';
import {
  NOTION_DOCUMENT,
  syncNotion,
  type SyncProgress,
  type SyncResult,
} from './sync.js';
import { PLATFORM, syncablesTransport } from './transport.js';

/** A sync older than this is repeated when the app opens (DESIGN.md §7). */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** What every state after a connection was found carries. */
export interface Connected {
  /** Absent when the connection is gone (`reauth` found on load). */
  connectionId?: string;
  /** The table's rows, as last read back from the drive. */
  rows: Row[];
  /** The last sync record that was saved, from this or an earlier open. */
  last?: SyncRecord;
  /** Rows the latest sync created or changed, for a short highlight. */
  changed?: string[];
}

/**
 * Everything the view shows, as data, so it is testable without a DOM.
 * `main.ts` renders a `ViewState` and wires the actions.
 */
export type ViewState =
  | { kind: 'loading' }
  | { kind: 'no-proxy' }
  | { kind: 'not-connected' }
  | { kind: 'connecting' }
  | ({ kind: 'ready' } & Connected)
  /** A sync over rows that stay usable. */
  | ({ kind: 'syncing'; progress: SyncProgress[] } & Connected)
  /** The first import: the table has no rows yet. */
  | ({ kind: 'importing'; progress: SyncProgress[] } & Connected)
  /** Connected, but Notion shares no database with the integration. */
  | ({ kind: 'no-databases' } & Connected)
  | ({ kind: 'reauth'; technical?: string } & Connected)
  /** No connection for this app, but rows from an earlier one are kept. */
  | ({ kind: 'disconnected' } & Connected)
  | ({
      kind: 'rate-limited';
      retryAt: number;
      pagesRead: number;
      technical: string;
    } & Connected)
  | ({
      kind: 'failed';
      title: string;
      message: string;
      technical: string;
    } & Connected);

export type ConnectedState = Extract<ViewState, Connected>;

export const isConnected = (state: ViewState): state is ConnectedState =>
  'rows' in state;

export const isRunning = (state: ViewState): boolean =>
  state.kind === 'syncing' || state.kind === 'importing';

export interface Controller {
  state(): ViewState;
  /** Reads the connection, the stored record and the rows. Fetches nothing from Notion. */
  load(): Promise<ViewState>;
  /** Whether the last sync is unknown or older than `STALE_AFTER_MS`. */
  isStale(): boolean;
  /**
   * Asks the host to connect (or reconnect, or re-open Notion's page
   * picker). A new account navigates the page away; an existing connection
   * picked in the host's bar reloads the state; a cancel restores it.
   */
  connect(): Promise<ViewState>;
  sync(): Promise<ViewState>;
  /**
   * Stops this app using Notion (`store.proxy.disconnect`): the delegation
   * goes, the rows and the sync record stay. Absent on older hosts.
   */
  disconnect?(): Promise<ViewState>;
  /** Re-reads the rows (after the table changed elsewhere). */
  refreshRows(): Promise<ViewState>;
}

const upstream = (doc: OpenApiDocument) =>
  new URL((doc as { servers?: { url: string }[] }).servers?.[0]?.url ?? '');

const fingerprint = (row: Row) => JSON.stringify(row.values);

export function createController(
  store: PluginStore,
  onChange: (state: ViewState) => void = () => {},
  now: () => number = Date.now,
  sync: typeof syncNotion = syncNotion,
): Controller {
  let current: ViewState = { kind: 'loading' };
  let schema: Schema | undefined;
  let running = false;

  const set = (next: ViewState) => {
    current = next;
    onChange(next);

    return next;
  };

  const base = (): Connected =>
    isConnected(current)
      ? {
          ...(current.connectionId
            ? { connectionId: current.connectionId }
            : {}),
          rows: current.rows,
          ...(current.last ? { last: current.last } : {}),
        }
      : { rows: [] };

  const readDrive = async () => {
    schema = await loadSchema(store);
    if (!schema) return { rows: [] as Row[], last: undefined };
    const [rows, last] = await Promise.all([
      loadRows(store, schema),
      loadRecord(store, schema).catch(() => undefined),
    ]);

    return { rows, last };
  };

  return {
    state: () => current,

    isStale() {
      if (!isConnected(current) || !current.last) return true;

      return now() - current.last.at > STALE_AFTER_MS;
    },

    async load() {
      const proxy = store.proxy;
      if (!proxy || typeof proxy.connections !== 'function')
        return set({ kind: 'no-proxy' });
      const [connections, drive] = await Promise.all([
        proxy.connections({ platform: PLATFORM }),
        readDrive(),
      ]);
      const [connection] = connections;
      const kept: Connected = {
        rows: drive.rows,
        ...(drive.last ? { last: drive.last } : {}),
      };

      // Disconnected on purpose, or the delegation was removed elsewhere:
      // either way the rows stay, and connecting again resumes syncing.
      if (!connection)
        return set(
          drive.rows.length || drive.last
            ? { kind: 'disconnected', ...kept }
            : { kind: 'not-connected' },
        );

      const connected = { ...kept, connectionId: connection.connectionId };

      return set(
        drive.last && drive.last.dataSources.length === 0
          ? { kind: 'no-databases', ...connected }
          : { kind: 'ready', ...connected },
      );
    },

    async connect() {
      const proxy = store.proxy;
      if (!proxy || running) return current;
      const before = current;
      if (current.kind === 'not-connected') set({ kind: 'connecting' });
      else if (!isConnected(current)) return current;
      // Connecting a new account navigates away and comes back to a fresh
      // view; picking an existing one resolves `connected`, with no reload
      // (#54 phase 2). Cancelling returns to the state it started from.
      const result = await proxy.connect({ platform: PLATFORM });

      return result?.status === 'connected' ? this.load() : set(before);
    },

    ...(store.proxy?.disconnect
      ? {
          async disconnect() {
            const proxy = store.proxy;
            if (!proxy?.disconnect || running || !isConnected(current))
              return current;
            await proxy.disconnect({ platform: PLATFORM });

            return this.load();
          },
        }
      : {}),

    async refreshRows() {
      if (!isConnected(current) || running || !schema) return current;
      const rows = await loadRows(store, schema);

      return set({ ...current, rows });
    },

    async sync() {
      const proxy = store.proxy;
      if (!proxy || running || !isConnected(current)) return current;
      const { connectionId } = current;
      if (!connectionId) return current;
      running = true;
      const before = base();
      const kind = before.rows.length ? 'syncing' : 'importing';
      const progress: SyncProgress[] = [];
      const failures: ProviderFailure[] = [];
      const startedAt = now();
      set({ kind, ...before, progress: [] });

      const transport = syncablesTransport(
        proxy,
        connectionId,
        upstream(NOTION_DOCUMENT),
        ({ method, path, status, headers, code }) => {
          if (status >= 200 && status < 300 && !code) return;
          failures.push({
            status,
            method,
            path,
            ...(code ? { code } : {}),
            ...(headers['retry-after']
              ? { retryAfter: headers['retry-after'] }
              : {}),
            at: now(),
          });
        },
      );

      let result: SyncResult | undefined;
      let error: unknown;

      try {
        result = await sync(store, transport, undefined, {
          onProgress: event => {
            const at = progress.findIndex(
              p => p.dataSource === event.dataSource,
            );
            if (at < 0) progress.push(event);
            else progress[at] = event;
            if (current.kind === kind)
              set({ ...current, progress: [...progress] });
          },
        });
      } catch (caught) {
        error = caught;
      }

      try {
        const failure = classifyFailure(
          failures,
          error ??
            (result?.readErrors.length
              ? new Error(result.readErrors.join('; '))
              : undefined),
          now(),
        );
        let last = before.last;

        // A sync that ended in a failure state keeps the previous record: it
        // would otherwise count as fresh (no re-sync on open for 15 minutes)
        // and carry a partial schema.
        if (result && !failure) {
          last = toRecord(result, startedAt, now());

          try {
            schema ??= await loadSchema(store);
            if (schema) schema = await saveRecord(store, schema, last);
          } catch (saving) {
            last.general.push(
              `The sync record could not be saved in the drive, so it is lost on reload: ${
                saving instanceof Error ? saving.message : String(saving)
              }`,
            );
          }
        }

        // Rows written before a failure are kept, so read them back either way.
        schema = (await loadSchema(store)) ?? schema;
        const rows = schema ? await loadRows(store, schema) : before.rows;
        const previous = new Map(
          before.rows.map(r => [r.subject, fingerprint(r)]),
        );
        const changed = before.rows.length
          ? rows
              .filter(r => previous.get(r.subject) !== fingerprint(r))
              .map(r => r.subject)
          : [];
        const after: Connected = {
          connectionId,
          rows,
          ...(last ? { last } : {}),
          ...(changed.length ? { changed } : {}),
        };
        if (failure?.kind === 'rate-limited')
          return set({
            ...after,
            ...failure,
            pagesRead: progress.reduce((n, p) => n + p.pages, 0),
          });
        if (failure) return set({ ...after, ...failure });
        if (result && result.dataSources === 0)
          return set({ kind: 'no-databases', ...after });

        return set({ kind: 'ready', ...after });
      } finally {
        running = false;
      }
    },
  };
}
