import {
  discoverResources,
  type ResourceRoute,
} from '../resources/discover.js';
import type {
  OpenApiDocument,
  OperationObject,
  SchemaObject,
} from '../openapi/types.js';
import { findRoute } from '../routing/router.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import {
  buildQuery,
  nextCursor,
  type PageCursor,
} from '../pagination/request-builder.js';
import { parsePaginationState } from '../pagination/response-parser.js';
import { locateItemsField } from '../pagination/items.js';
import { InMemoryStorageAdapter, type StorageAdapter } from './storage.js';

export interface RetryOptions {
  /** Delay before the first retry of a failed write, in milliseconds. Doubles on each subsequent attempt. Default 200. */
  baseDelayMs?: number;
  /** Ceiling for the exponential backoff between retries, in milliseconds. Default 30000. */
  maxDelayMs?: number;
  /** Stop auto-retrying a write after this many attempts. Default is unlimited (keep retrying until it succeeds). */
  maxAttempts?: number;
}

export interface ApiClientOptions {
  baseUrl: string;
  storage?: StorageAdapter;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  /**
   * Record property that holds a resource's identity — the value used as the
   * local storage key, read back from a create response to reconcile the
   * server-assigned id, and substituted into the item URL's path variable.
   * Defaults to `id`. Set this when the API addresses a resource by a
   * different field (e.g. GitHub issues are keyed by `number`, not the
   * global `id` the payload also carries).
   */
  identityField?: string;
}

export interface PaginateOptions {
  /** Page size to request. Falls back to the server's own default when omitted. */
  pageSize?: number;
}

export interface SyncResult {
  /** Collection paths whose local copy was actually added to, updated, or pruned by this sync. */
  changed: string[];
}

export interface PollOptions {
  /** How often to call `sync()`, in milliseconds. An initial sync runs immediately. */
  intervalMs: number;
  /** Called after every sync while polling, including ones where nothing changed. */
  onSync?: (result: SyncResult) => void;
  /** Called when a sync throws while polling; polling continues on the next interval. */
  onError?: (error: unknown) => void;
}

export interface PollingHandle {
  /** Stops future polling. Does not cancel a sync already in flight. */
  stop(): void;
}

export type PendingWriteType = 'create' | 'update' | 'delete';

export interface PendingWriteInfo {
  resource: string;
  /** The id the write is filed under locally. For an unsettled `create`, this is the client-generated id, not (yet) whatever the server assigns. */
  id: string;
  type: PendingWriteType;
  /**
   * How many attempts to reach the server have failed so far. If
   * `ApiClientOptions.retry.maxAttempts` is set and reached, this stops
   * growing and the write stops auto-retrying — it stays listed here
   * (with `lastError` set) until `create`/`update`/`remove` is called
   * again for the same record.
   */
  attempts: number;
  /** The most recent failure, if at least one attempt has failed. */
  lastError?: string;
}

export interface ApiClient {
  resources: string[];
  sync(): Promise<SyncResult>;
  /**
   * Calls `sync()` on `options.intervalMs`, skipping a tick if the previous
   * sync is still running. Returns a handle whose `stop()` cancels it.
   */
  startPolling(options: PollOptions): PollingHandle;
  list(resource: string): Promise<Record<string, unknown>[]>;
  get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined>;
  /**
   * Writes `data` to local storage immediately, under a client-generated id
   * (or `data.id`, if already set) and returns without waiting on the
   * network. The write to the server happens in the background and is
   * retried on failure — see `pendingWrites()` for its outcome so far. If
   * the server assigns a different id than the one used locally, the
   * record is moved to it once the write settles.
   */
  create(
    resource: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /**
   * Merges `data` into the local copy of `id` immediately and returns
   * without waiting on the network; the corresponding `PUT` is sent (and
   * retried on failure) in the background.
   */
  update(
    resource: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /**
   * Removes `id` from local storage immediately and returns without
   * waiting on the network; the corresponding `DELETE` is sent (and
   * retried on failure) in the background.
   */
  remove(resource: string, id: string): Promise<void>;
  /**
   * Writes not yet confirmed by the server, across every resource (or just
   * `resource`, if given) — local storage already reflects them, but the
   * background attempt to apply them server-side hasn't succeeded yet.
   */
  pendingWrites(resource?: string): PendingWriteInfo[];
  /**
   * Fetches every item from a GET list operation at `path`, walking every
   * page per its resolved pagination scheme (explicit `x-pagination` or
   * auto-detected from `components.paginationSchemes`). `path` need not be
   * a discovered resource — any GET operation in the document works, e.g.
   * a search/listing endpoint with no paired item route.
   */
  paginate(
    path: string,
    options?: PaginateOptions,
  ): Promise<Record<string, unknown>[]>;
}

const MAX_PAGES = 50;

/**
 * Fields commonly used by real APIs to signal that a record changed,
 * checked in this order. When an item has none of these, its fingerprint
 * falls back to a full serialization, which still lets `hasChanges` detect
 * per-item edits without any server cooperation.
 */
const CHANGE_INDICATOR_FIELDS = [
  'updatedAt',
  'updated_at',
  'modifiedAt',
  'modified_at',
  'version',
  'revision',
  '_rev',
  'etag',
];

function itemFingerprint(item: Record<string, unknown>): string {
  for (const field of CHANGE_INDICATOR_FIELDS) {
    if (field in item) {
      return `${field}:${String(item[field])}`;
    }
  }
  return JSON.stringify(item);
}

/**
 * Compares a previously synced item list against a freshly fetched one to
 * decide whether local storage actually needs updating — the fallback used
 * when the server gave no (or an untrusted) conditional-request signal.
 */
function hasChanges(
  previous: Record<string, unknown>[] | undefined,
  next: Record<string, unknown>[],
  idField: string,
): boolean {
  if (!previous || previous.length !== next.length) {
    return true;
  }
  const previousById = new Map(
    previous.map((item) => [String(item[idField]), item]),
  );
  return next.some((item) => {
    const match = previousById.get(String(item[idField]));
    return !match || itemFingerprint(match) !== itemFingerprint(item);
  });
}

function extractItemsFromEnvelope(
  body: Record<string, unknown>,
  responseSchema: SchemaObject | undefined,
): Record<string, unknown>[] {
  const field = locateItemsField(responseSchema, undefined);
  const items = field ? body[field] : undefined;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

interface QueuedWrite {
  resource: string;
  id: string;
  type: PendingWriteType;
  /** The full record to send; unused for `delete`. */
  data?: Record<string, unknown>;
  attempts: number;
  lastError?: string;
}

type WriteOutcome =
  | { status: 'succeeded'; resolvedId: string }
  | { status: 'retry'; delayMs: number }
  | { status: 'gaveUp' };

/**
 * Builds a client that talks to an API described by `document` and keeps
 * a local copy of each resource collection in `storage` (in-memory by
 * default). Reads serve from the local copy. Writes (`create`/`update`/
 * `remove`) are local-first: they update `storage` immediately and return,
 * then apply themselves against the server in the background, retrying on
 * failure — see `pendingWrites()` and each method's own docs.
 */
export function createApiClient(
  document: OpenApiDocument,
  options: ApiClientOptions,
): ApiClient {
  const storage = options.storage ?? new InMemoryStorageAdapter();
  const fetchImpl = options.fetch ?? fetch;
  const idField = options.identityField ?? 'id';
  const routes = discoverResources(document.paths);
  const byResource = new Map(
    routes.map((route) => [route.collectionPath, route]),
  );
  // Keyed by exact request URL: the ETag/Last-Modified last seen for it, so
  // the next sync can ask the server "has this changed?" via If-None-Match /
  // If-Modified-Since instead of re-fetching the full body.
  const conditionalCache = new Map<
    string,
    { etag?: string; lastModified?: string }
  >();
  // Keyed by collection path: the item list stored there as of the last
  // sync, used both to fall back on for a 304 response and to diff against
  // a fresh 200 response (see `hasChanges`).
  const lastSyncedItems = new Map<string, Record<string, unknown>[]>();

  const retryOptions = {
    baseDelayMs: options.retry?.baseDelayMs ?? 200,
    maxDelayMs: options.retry?.maxDelayMs ?? 30_000,
    maxAttempts: options.retry?.maxAttempts,
  };

  // Keyed by `${resource}:${id}`: writes still to be applied server-side
  // for that record, oldest first. `drainQueue` processes each key's queue
  // one write at a time (retrying in place before moving on) so writes to
  // the same record land in the order they were made.
  const writeQueues = new Map<string, QueuedWrite[]>();
  const draining = new Set<string>();
  // Writes that stopped retrying because `retryOptions.maxAttempts` was
  // reached (by default retries never give up, so this stays empty).
  // Kept only so `pendingWrites()` can still surface the failure; enqueuing
  // a new write for the same record clears it.
  const gaveUpWrites = new Map<string, QueuedWrite>();

  function queueKey(resource: string, id: string): string {
    return `${resource}:${id}`;
  }

  function enqueueWrite(write: Omit<QueuedWrite, 'attempts'>): void {
    const k = queueKey(write.resource, write.id);
    gaveUpWrites.delete(k);
    const queue = writeQueues.get(k) ?? [];
    queue.push({ ...write, attempts: 0 });
    writeQueues.set(k, queue);
    if (!draining.has(k)) {
      void drainQueue(k);
    }
  }

  async function attemptWrite(write: QueuedWrite): Promise<WriteOutcome> {
    try {
      if (write.type === 'create') {
        const route = resolveRoute(write.resource);
        const created = (await requestJson(collectionUrl(route), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(write.data),
        })) as Record<string, unknown>;
        const resolvedId = String(created[idField]);
        if (resolvedId !== write.id) {
          await storage.delete(write.resource, write.id);
        }
        await storage.put(write.resource, resolvedId, created);
        return { status: 'succeeded', resolvedId };
      }

      if (write.type === 'update') {
        const route = resolveRoute(write.resource);
        const updated = (await requestJson(itemUrl(route, write.id), {
          method: route.updateMethod,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(write.data),
        })) as Record<string, unknown>;
        await storage.put(write.resource, write.id, updated);
        return { status: 'succeeded', resolvedId: write.id };
      }

      // A delete may be applying on behalf of a create that already
      // reconciled onto a server-assigned id (see `drainQueue`), so make
      // sure local storage doesn't still hold that record either.
      await storage.delete(write.resource, write.id);
      const route = resolveRoute(write.resource);
      await requestJson(itemUrl(route, write.id), { method: 'DELETE' });
      return { status: 'succeeded', resolvedId: write.id };
    } catch (error) {
      write.attempts += 1;
      write.lastError = error instanceof Error ? error.message : String(error);
      if (
        retryOptions.maxAttempts !== undefined &&
        write.attempts >= retryOptions.maxAttempts
      ) {
        return { status: 'gaveUp' };
      }
      const delayMs = Math.min(
        retryOptions.baseDelayMs * 2 ** (write.attempts - 1),
        retryOptions.maxDelayMs,
      );
      return { status: 'retry', delayMs };
    }
  }

  /**
   * Applies queued writes for one record in order, retrying each in place
   * (per `attemptWrite`'s backoff) before moving to the next. When a
   * `create` at the head of the queue settles under a server-assigned id
   * different from its local one, whatever is queued behind it is moved
   * onto that id's queue instead — those writes were made against the
   * record the create introduced, so they have to follow it.
   */
  async function drainQueue(initialKey: string): Promise<void> {
    let k = initialKey;
    draining.add(k);
    try {
      for (;;) {
        const queue = writeQueues.get(k);
        const write = queue?.[0];
        if (!write) {
          writeQueues.delete(k);
          return;
        }

        const outcome = await attemptWrite(write);
        if (outcome.status === 'retry') {
          await delay(outcome.delayMs);
          continue;
        }

        queue.shift();
        if (outcome.status === 'gaveUp') {
          gaveUpWrites.set(k, write);
        }
        if (outcome.status === 'succeeded' && outcome.resolvedId !== write.id) {
          const rest = queue.splice(0);
          writeQueues.delete(k);
          draining.delete(k);
          k = queueKey(write.resource, outcome.resolvedId);
          draining.add(k);
          const existing = writeQueues.get(k) ?? [];
          writeQueues.set(k, [
            ...existing,
            ...rest.map((item) => ({ ...item, id: outcome.resolvedId })),
          ]);
          continue;
        }

        if (queue.length === 0) {
          writeQueues.delete(k);
        }
      }
    } finally {
      draining.delete(k);
    }
  }

  function resolveRoute(resource: string): ResourceRoute {
    const route = byResource.get(resource);
    if (!route) {
      throw new Error(
        `Unknown resource "${resource}". Known resources: ${[...byResource.keys()].join(', ')}`,
      );
    }
    return route;
  }

  function collectionUrl(route: ResourceRoute): string {
    return new URL(route.collectionPath, options.baseUrl).toString();
  }

  function itemUrl(route: ResourceRoute, id: string): string {
    const path = route.itemPath.replace(
      `{${route.itemParam}}`,
      encodeURIComponent(id),
    );
    return new URL(path, options.baseUrl).toString();
  }

  async function requestJson(
    url: string,
    init?: RequestInit,
  ): Promise<unknown> {
    const response = await fetchImpl(url, init);
    if (response.status === 204) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(
        `Request to ${url} failed with status ${response.status}`,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  async function requestJsonWithHeaders(url: string): Promise<{
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(
        `Request to ${url} failed with status ${response.status}`,
      );
    }
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      body: parsed && typeof parsed === 'object' ? parsed : {},
      headers,
    };
  }

  /**
   * Fetches a resource's collection, conditionally: sends If-None-Match /
   * If-Modified-Since from a prior response (if any), and on a 304 returns
   * the item list last stored for it instead of re-parsing a body. Only
   * used for the non-paginated case, since it's the one `sync()` can
   * meaningfully short-circuit — pagination has already been walked and
   * assembled by the time a scheme applies.
   */
  async function fetchCollectionSnapshot(
    route: ResourceRoute,
    operation: OperationObject | undefined,
  ): Promise<{ items: Record<string, unknown>[]; notModified: boolean }> {
    const url = collectionUrl(route);
    const responseSchema =
      operation?.responses['200']?.content?.['application/json']?.schema;
    const cached = conditionalCache.get(url);
    const headers: Record<string, string> = {};
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }
    if (cached?.lastModified) {
      headers['If-Modified-Since'] = cached.lastModified;
    }

    const response = await fetchImpl(
      url,
      Object.keys(headers).length > 0 ? { headers } : undefined,
    );

    if (response.status === 304) {
      return {
        items: lastSyncedItems.get(route.collectionPath) ?? [],
        notModified: true,
      };
    }
    if (!response.ok) {
      throw new Error(
        `Request to ${url} failed with status ${response.status}`,
      );
    }

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    if (etag || lastModified) {
      conditionalCache.set(url, {
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      });
    } else {
      conditionalCache.delete(url);
    }

    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : {};
    const items = Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : extractItemsFromEnvelope(
          body as Record<string, unknown>,
          responseSchema,
        );

    return { items, notModified: false };
  }

  function findGetOperation(
    path: string,
  ): { operation: OperationObject; template: string } | undefined {
    const match = findRoute(Object.keys(document.paths), path);
    if (!match) {
      return undefined;
    }
    const operation = document.paths[match.template]?.get;
    return operation ? { operation, template: match.template } : undefined;
  }

  /**
   * Fetches every item from a GET operation, following its resolved
   * pagination scheme across pages. When no scheme applies, falls back to
   * a single request, still attempting to locate the items in an
   * enveloped (non-array) response body.
   */
  async function fetchAllItems(
    path: string,
    operation: OperationObject,
    pageSize: number | undefined,
  ): Promise<Record<string, unknown>[]> {
    const responseSchema =
      operation.responses['200']?.content?.['application/json']?.schema;
    const effective = resolveEffectiveScheme(document, operation);

    if (!effective) {
      const { body } = await requestJsonWithHeaders(
        new URL(path, options.baseUrl).toString(),
      );
      if (Array.isArray(body)) {
        return body as Record<string, unknown>[];
      }
      const field = locateItemsField(responseSchema, undefined);
      const items = field ? body[field] : undefined;
      return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
    }

    const { scheme } = effective;
    const itemsField = locateItemsField(responseSchema, scheme);
    const items: Record<string, unknown>[] = [];
    let cursor: PageCursor = {};
    let nextUrl: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      let url = nextUrl;
      if (!url) {
        const target = new URL(path, options.baseUrl);
        const query = buildQuery(scheme, cursor, pageSize);
        for (const [key, value] of Object.entries(query)) {
          target.searchParams.set(key, value);
        }
        url = target.toString();
      }

      const { body, headers } = await requestJsonWithHeaders(url);
      // A top-level array body is itself the page of items (mirrors the
      // non-paginated path); otherwise the items live under `itemsField`.
      const pageItems = Array.isArray(body)
        ? (body as Record<string, unknown>[])
        : itemsField
          ? body[itemsField]
          : undefined;
      if (Array.isArray(pageItems)) {
        items.push(...(pageItems as Record<string, unknown>[]));
      }

      const state = parsePaginationState(scheme, body, headers, items.length);
      if (!state.hasNextPage) {
        break;
      }

      if (scheme.type === 'nextLink') {
        if (!state.nextLink) {
          break;
        }
        nextUrl = state.nextLink;
      } else {
        const next = nextCursor(
          scheme,
          cursor,
          state,
          Array.isArray(pageItems) ? pageItems.length : 0,
        );
        if (!next) {
          break;
        }
        cursor = next;
        nextUrl = undefined;
      }
    }

    return items;
  }

  /**
   * Syncs every discovered resource. For a non-paginated collection, this
   * conditionally re-fetches (see `fetchCollectionSnapshot`) and, even on a
   * fresh 200, only touches storage for items that actually changed
   * (`hasChanges`) — so calling this repeatedly (e.g. from `startPolling`)
   * doesn't rewrite unchanged local state. Paginated collections are always
   * walked in full (pagination state can't be conditionally short-circuited
   * the same way), but still only diff-write into storage.
   */
  async function performSync(): Promise<SyncResult> {
    const changed: string[] = [];
    for (const route of byResource.values()) {
      const operation = document.paths[route.collectionPath]?.get;
      const isPaginated = operation
        ? Boolean(resolveEffectiveScheme(document, operation))
        : false;

      const { items, notModified } = isPaginated
        ? {
            items: await fetchAllItems(
              route.collectionPath,
              operation as OperationObject,
              undefined,
            ),
            notModified: false,
          }
        : await fetchCollectionSnapshot(route, operation);

      if (notModified) {
        continue;
      }

      const previous = lastSyncedItems.get(route.collectionPath);
      if (hasChanges(previous, items, idField)) {
        changed.push(route.collectionPath);
        for (const item of items) {
          await storage.put(route.collectionPath, String(item[idField]), item);
        }
        if (previous) {
          const nextIds = new Set(items.map((item) => String(item[idField])));
          for (const staleItem of previous) {
            const staleId = String(staleItem[idField]);
            if (!nextIds.has(staleId)) {
              await storage.delete(route.collectionPath, staleId);
            }
          }
        }
      }
      lastSyncedItems.set(route.collectionPath, items);
    }
    return { changed };
  }

  return {
    resources: [...byResource.keys()],

    sync: performSync,

    startPolling(pollOptions): PollingHandle {
      let stopped = false;
      let syncInFlight = false;

      const tick = (): void => {
        if (stopped || syncInFlight) {
          return;
        }
        syncInFlight = true;
        performSync()
          .then((result) => pollOptions.onSync?.(result))
          .catch((error: unknown) => pollOptions.onError?.(error))
          .finally(() => {
            syncInFlight = false;
          });
      };

      tick();
      const timer = setInterval(tick, pollOptions.intervalMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      return {
        stop(): void {
          stopped = true;
          clearInterval(timer);
        },
      };
    },

    async list(resource): Promise<Record<string, unknown>[]> {
      return storage.list(resolveRoute(resource).collectionPath);
    },

    async get(resource, id): Promise<Record<string, unknown> | undefined> {
      return storage.get(resolveRoute(resource).collectionPath, id);
    },

    async create(resource, data): Promise<Record<string, unknown>> {
      const route = resolveRoute(resource);
      const id =
        typeof data[idField] === 'string'
          ? (data[idField] as string)
          : crypto.randomUUID();
      const record = { ...data, [idField]: id };
      await storage.put(route.collectionPath, id, record);
      enqueueWrite({
        resource: route.collectionPath,
        id,
        type: 'create',
        data: record,
      });
      return record;
    },

    async update(resource, id, data): Promise<Record<string, unknown>> {
      const route = resolveRoute(resource);
      const existing = await storage.get(route.collectionPath, id);
      const record = { ...existing, ...data, [idField]: id };
      await storage.put(route.collectionPath, id, record);
      enqueueWrite({
        resource: route.collectionPath,
        id,
        type: 'update',
        data: record,
      });
      return record;
    },

    async remove(resource, id): Promise<void> {
      const route = resolveRoute(resource);
      await storage.delete(route.collectionPath, id);
      enqueueWrite({ resource: route.collectionPath, id, type: 'delete' });
    },

    pendingWrites(resource): PendingWriteInfo[] {
      const collectionPath = resource
        ? resolveRoute(resource).collectionPath
        : undefined;
      const info: PendingWriteInfo[] = [];
      const collect = (write: QueuedWrite): void => {
        if (collectionPath && write.resource !== collectionPath) {
          return;
        }
        info.push({
          resource: write.resource,
          id: write.id,
          type: write.type,
          attempts: write.attempts,
          ...(write.lastError ? { lastError: write.lastError } : {}),
        });
      };
      for (const queue of writeQueues.values()) {
        for (const write of queue) {
          collect(write);
        }
      }
      for (const write of gaveUpWrites.values()) {
        collect(write);
      }
      return info;
    },

    async paginate(
      path,
      paginateOptions = {},
    ): Promise<Record<string, unknown>[]> {
      const found = findGetOperation(path);
      if (!found) {
        throw new Error(`No GET operation found for path "${path}"`);
      }
      return fetchAllItems(path, found.operation, paginateOptions.pageSize);
    },
  };
}
