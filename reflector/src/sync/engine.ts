import { randomUUID } from 'node:crypto';
import {
  createApiClient,
  type ApiClient,
  type OpenApiDocument,
  type StorageAdapter,
} from 'syncables';
import type { ReflectorConfig } from '../config/index.js';
import {
  SYNCABLES_BASE_URL,
  type TokenManager,
} from '../oauth/authed-fetch.js';
import { subsetDocument } from './document.js';
import {
  FileStorageBackend,
  type ExportRecord,
  type StorageBackend,
} from './storage.js';
import {
  discoverResourceModel,
  generateId,
  type ManagedCollection,
  type ResourceModel,
} from './resources.js';

export type ChangeType = 'create' | 'update' | 'delete';
export type ChangeState = 'syncing' | 'synced' | 'failed';

export type Context = Record<string, string>;

/** A single local-first edit and how far its background sync to the server has got. */
export interface ChangeRecord {
  changeId: string;
  /** Collection the edited record belongs to, e.g. `events`. */
  collection: string;
  /** Parent path parameters that locate the record, e.g. `{ calendarId }`. */
  context: Context;
  /** The record's id. */
  id: string;
  type: ChangeType;
  state: ChangeState;
  summary: string;
  startedAt: number;
  settledAt?: number;
  error?: string;
}

/** One collection instance read during a full read. */
export interface CollectionReadResult {
  collection: string;
  context: Context;
  count: number;
}

export interface FullReadSummary {
  collections: CollectionReadResult[];
  errors: { collection: string; context: Context; error: string }[];
}

interface CollectionClient {
  client: ApiClient;
  storage: StorageAdapter;
}

/** Fields commonly used as a human-readable label, tried in order for change summaries. */
const LABEL_FIELDS = ['summary', 'name', 'title', 'displayName'];

function labelOf(
  value: Record<string, unknown> | undefined,
  fallback: string,
): string {
  for (const field of LABEL_FIELDS) {
    const label = value?.[field];
    if (typeof label === 'string' && label) {
      return label;
    }
  }
  return fallback;
}

function contextKey(collection: string, context: Context): string {
  return `${collection} ${JSON.stringify(context)}`;
}

function namespaceFor(collection: ManagedCollection, context: Context): string {
  return collection.contextParams.length
    ? collection.contextParams.map((p) => context[p] ?? '').join(',')
    : collection.name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Orchestrates the whole local-first flow for one connected account, using
 * syncables as the sync engine: a full read into a local JSON copy, browsing
 * that copy, and local-first create/update/delete whose background sync is
 * tracked so the UI can show "syncing" / "synced" / a rollback.
 *
 * Everything it operates on — which collections exist, their URLs, how nested
 * collections get their parent ids, and how new ids are minted — is discovered
 * from the OpenAPI document's `crudResources`, so the engine carries no
 * knowledge of any particular API.
 */
export class SyncEngine {
  private readonly model: ResourceModel;
  private readonly clients = new Map<string, CollectionClient>();
  private readonly changes: ChangeRecord[] = [];
  private readonly snapshots = new Map<
    string,
    Record<string, unknown> | undefined
  >();
  private watcher: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly config: ReflectorConfig,
    private readonly document: OpenApiDocument,
    private readonly tokens: TokenManager,
    /**
     * Where the local-first copy lives. Defaults to on-disk files; a
     * connected remoteStorage account swaps in its own backend instead.
     */
    private readonly backend: StorageBackend = new FileStorageBackend(
      config.dataDir,
    ),
  ) {
    this.model = discoverResourceModel(document);
  }

  private requireCollection(name: string): ManagedCollection {
    const collection = this.model.byName(name);
    if (!collection) {
      throw new Error(`Unknown collection "${name}"`);
    }
    return collection;
  }

  private getClient(
    collection: ManagedCollection,
    context: Context,
  ): CollectionClient {
    const key = contextKey(collection.name, context);
    let existing = this.clients.get(key);
    if (!existing) {
      const storage = this.backend.adapter(namespaceFor(collection, context));
      const client = createApiClient(
        subsetDocument(this.document, collection.paths),
        {
          baseUrl: SYNCABLES_BASE_URL,
          storage,
          fetch: this.tokens.authorizedFetch(context),
          retry: {
            baseDelayMs: this.config.retry.baseDelayMs,
            maxDelayMs: this.config.retry.maxDelayMs,
            maxAttempts: this.config.retry.maxAttempts,
          },
        },
      );
      existing = { client, storage };
      this.clients.set(key, existing);
    }
    return existing;
  }

  /**
   * Resolves the set of parent contexts a collection should be read under, or
   * `undefined` if its parent collections have not been read yet. A top-level
   * collection resolves to a single empty context.
   */
  private resolveContexts(
    collection: ManagedCollection,
    resolved: Map<string, Record<string, unknown>[]>,
  ): Context[] | undefined {
    let contexts: Context[] = [{}];
    for (const param of collection.contextParams) {
      const provider = this.model.providerFor(param);
      if (!provider) {
        return undefined;
      }
      const parents = resolved.get(provider.collection);
      if (!parents) {
        return undefined;
      }
      const values = parents
        .map((item) => item[provider.field])
        .filter((v): v is string | number => v !== undefined && v !== null)
        .map(String);
      const next: Context[] = [];
      for (const ctx of contexts) {
        for (const value of values) {
          next.push({ ...ctx, [param]: value });
        }
      }
      contexts = next;
    }
    return contexts;
  }

  /**
   * Reads the full dataset the API has for the account into the local copy, by
   * walking the discovered collection hierarchy: top-level collections first,
   * then any collection whose parent context can be filled from what was just
   * read. A collection that fails to read is recorded and skipped rather than
   * aborting the whole read.
   */
  async fullRead(): Promise<FullReadSummary> {
    const resolved = new Map<string, Record<string, unknown>[]>();
    const collections: CollectionReadResult[] = [];
    const errors: FullReadSummary['errors'] = [];
    const remaining = [...this.model.collections];

    let progress = true;
    while (remaining.length > 0 && progress) {
      progress = false;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const collection = remaining[i] as ManagedCollection;
        const contexts = this.resolveContexts(collection, resolved);
        if (!contexts) {
          continue;
        }
        remaining.splice(i, 1);
        progress = true;
        const merged: Record<string, unknown>[] = [];
        for (const context of contexts) {
          try {
            const { client } = this.getClient(collection, context);
            await client.sync();
            const items = await client.list(collection.collectionUrl);
            merged.push(...items);
            collections.push({
              collection: collection.name,
              context,
              count: items.length,
            });
          } catch (error) {
            errors.push({
              collection: collection.name,
              context,
              error: errorMessage(error),
            });
          }
        }
        resolved.set(collection.name, merged);
      }
    }
    for (const collection of remaining) {
      errors.push({
        collection: collection.name,
        context: {},
        error: 'parent context could not be resolved',
      });
    }
    return { collections, errors };
  }

  async list(
    collectionName: string,
    context: Context = {},
  ): Promise<Record<string, unknown>[]> {
    const collection = this.requireCollection(collectionName);
    return this.getClient(collection, context).client.list(
      collection.collectionUrl,
    );
  }

  async get(
    collectionName: string,
    id: string,
    context: Context = {},
  ): Promise<Record<string, unknown> | undefined> {
    const collection = this.requireCollection(collectionName);
    return this.getClient(collection, context).client.get(
      collection.collectionUrl,
      id,
    );
  }

  async create(
    collectionName: string,
    data: Record<string, unknown>,
    context: Context = {},
  ): Promise<{ item: Record<string, unknown>; change: ChangeRecord }> {
    const collection = this.requireCollection(collectionName);
    const { client } = this.getClient(collection, context);
    const supplied = data[collection.idField];
    const id =
      typeof supplied === 'string' && supplied
        ? supplied
        : collection.generatesId
          ? generateId(collection.idPattern)
          : undefined;
    const payload =
      id !== undefined ? { ...data, [collection.idField]: id } : data;
    const item = await client.create(collection.collectionUrl, payload);
    const finalId = String(item[collection.idField] ?? id ?? '');
    const change = this.track(
      collection,
      context,
      finalId,
      'create',
      item,
      undefined,
    );
    return { item, change };
  }

  async update(
    collectionName: string,
    id: string,
    data: Record<string, unknown>,
    context: Context = {},
  ): Promise<{ item: Record<string, unknown>; change: ChangeRecord }> {
    const collection = this.requireCollection(collectionName);
    const { client } = this.getClient(collection, context);
    const before = await client.get(collection.collectionUrl, id);
    const item = await client.update(collection.collectionUrl, id, data);
    const change = this.track(collection, context, id, 'update', item, before);
    return { item, change };
  }

  async remove(
    collectionName: string,
    id: string,
    context: Context = {},
  ): Promise<{ change: ChangeRecord }> {
    const collection = this.requireCollection(collectionName);
    const { client } = this.getClient(collection, context);
    const before = await client.get(collection.collectionUrl, id);
    await client.remove(collection.collectionUrl, id);
    const change = this.track(
      collection,
      context,
      id,
      'delete',
      before ?? {},
      before,
    );
    return { change };
  }

  private track(
    collection: ManagedCollection,
    context: Context,
    id: string,
    type: ChangeType,
    value: Record<string, unknown>,
    before: Record<string, unknown> | undefined,
  ): ChangeRecord {
    const change: ChangeRecord = {
      changeId: randomUUID(),
      collection: collection.name,
      context,
      id,
      type,
      state: 'syncing',
      summary: labelOf(value, labelOf(before, id)),
      startedAt: Date.now(),
    };
    this.changes.unshift(change);
    this.snapshots.set(change.changeId, before);
    this.ensureWatcher();
    return change;
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = setInterval(() => {
      void this.pollChanges();
    }, 250);
    if (typeof this.watcher.unref === 'function') {
      this.watcher.unref();
    }
  }

  /**
   * Advances every in-flight change by inspecting the syncables write queue:
   * a write that has left the queue succeeded; one that has exhausted its
   * retries failed, so its local edit is rolled back to the pre-edit snapshot.
   */
  private async pollChanges(): Promise<void> {
    const active = this.changes.filter((change) => change.state === 'syncing');
    for (const change of active) {
      const collection = this.model.byName(change.collection);
      if (!collection) {
        continue;
      }
      const { client, storage } = this.getClient(collection, change.context);
      const pending = client
        .pendingWrites(collection.collectionUrl)
        .find((write) => write.id === change.id && write.type === change.type);

      if (!pending) {
        change.state = 'synced';
        change.settledAt = Date.now();
        this.snapshots.delete(change.changeId);
        continue;
      }
      const gaveUp =
        pending.lastError !== undefined &&
        pending.attempts >= this.config.retry.maxAttempts;
      if (gaveUp) {
        await this.rollback(change, collection, storage);
        change.state = 'failed';
        change.error = pending.lastError ?? 'sync failed';
        change.settledAt = Date.now();
        this.snapshots.delete(change.changeId);
      }
    }
    if (
      !this.changes.some((change) => change.state === 'syncing') &&
      this.watcher
    ) {
      clearInterval(this.watcher);
      this.watcher = undefined;
    }
  }

  private async rollback(
    change: ChangeRecord,
    collection: ManagedCollection,
    storage: StorageAdapter,
  ): Promise<void> {
    const before = this.snapshots.get(change.changeId);
    if (change.type === 'create') {
      await storage.delete(collection.collectionUrl, change.id);
    } else if (before) {
      await storage.put(collection.collectionUrl, change.id, before);
    } else {
      await storage.delete(collection.collectionUrl, change.id);
    }
  }

  /** Every record in the active storage backend, for the ZIP download. */
  async exportRecords(): Promise<ExportRecord[]> {
    return this.backend.enumerate();
  }

  /** Where this engine's local-first copy lives, for display in the UI. */
  storageLabel(): string {
    return this.backend.label;
  }

  /** Snapshot of sync status for the UI: how many edits are in flight and their history. */
  status(): { syncing: number; failed: number; changes: ChangeRecord[] } {
    const syncing = this.changes.filter((c) => c.state === 'syncing').length;
    const failed = this.changes.filter((c) => c.state === 'failed').length;
    return { syncing, failed, changes: this.changes.slice(0, 50) };
  }

  /** Waits until no edits are in flight (used by tests and graceful shutdown). */
  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      this.changes.some((c) => c.state === 'syncing') &&
      Date.now() < deadline
    ) {
      await this.pollChanges();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
