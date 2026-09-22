import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createApiClient,
  InMemoryStorageAdapter,
  type ApiClient,
  type OpenApiDocument,
  type StorageAdapter,
} from 'syncables';
import { loadConfig, type ReflectorConfig } from '../src/config/index.js';
import { buildDocument, subsetDocument } from '../src/sync/document.js';
import { discoverResourceModel } from '../src/sync/resources.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * Base origin handed to the syncables client. syncables joins the operation
 * path onto this; the {@link FakePlatform} `fetch` throws the origin away and
 * routes by path, so any absolute origin works. A real deployment would point
 * this (and the fetch) at the platform's real API instead.
 */
const BASE_URL = 'https://reflector.local';

/** Retry policy for the harness — small delays so a wedged write fails fast in tests. */
export const RETRY = {
  baseDelayMs: 5,
  maxDelayMs: 20,
  maxAttempts: 4,
} as const;

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** The `events` collection, pulled out of the vendored Calendar document once. */
export interface EventsModel {
  /** Collection URL template, e.g. `/calendars/{calendarId}/events` — the `resource` arg for list/create. */
  resource: string;
  /** Whether `create` expects a client-generated id. */
  generatesId: boolean;
  /** Pattern a generated id must match (from the create op's schema), if any. */
  idPattern: string | undefined;
  /** `[collectionUrl, itemUrl]`, ready for `subsetDocument`. */
  paths: string[];
  document: OpenApiDocument;
}

let cached: Promise<EventsModel> | undefined;

/**
 * Loads the vendored Google Calendar OpenAPI document + overlays (the same
 * ones the app is built on) and extracts the `events` collection. Memoized:
 * every driver/reviewer/reflector client is built from this one document.
 */
export function eventsModel(): Promise<EventsModel> {
  cached ??= (async (): Promise<EventsModel> => {
    const config: ReflectorConfig = {
      ...loadConfig(),
      openApiPath: resolve(repoRoot, 'spec/google-calendar-v3.openapi.yaml'),
      overlayDir: resolve(repoRoot, 'spec/overlays'),
    };
    const document = await buildDocument(config);
    const events = discoverResourceModel(document).byName('events');
    if (!events) {
      throw new Error('events collection not found in the Calendar document');
    }
    return {
      resource: events.collectionUrl,
      generatesId: events.generatesId,
      idPattern: events.idPattern,
      paths: events.paths,
      document,
    };
  })();
  return cached;
}

export interface EventsClient {
  client: ApiClient;
  /** Pass this to the client's list/get/create/update/remove. */
  resource: string;
}

/**
 * Builds an events-scoped syncables client over `fetchImpl` and `storage`.
 * This is the single primitive the driver, reviewer, and stub reflector all
 * share — none of them use the app's `SyncEngine`, only the raw client.
 */
export async function buildEventsClient(
  fetchImpl: typeof fetch,
  storage: StorageAdapter = new InMemoryStorageAdapter(),
): Promise<EventsClient> {
  const model = await eventsModel();
  const client = createApiClient(subsetDocument(model.document, model.paths), {
    baseUrl: BASE_URL,
    storage,
    fetch: fetchImpl,
    retry: { ...RETRY },
  });
  return { client, resource: model.resource };
}

/**
 * Waits until every background write on `client` has left the queue (i.e.
 * actually landed on the platform), so callers can be sure a driven change is
 * on the source before the reflector runs. Throws if a write exhausts its
 * retries, or if nothing settles within `timeoutMs`.
 */
export async function drainWrites(
  client: ApiClient,
  resource: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = client.pendingWrites(resource);
    if (pending.length === 0) {
      return;
    }
    const stuck = pending.find(
      (w) => w.lastError !== undefined && w.attempts >= RETRY.maxAttempts,
    );
    if (stuck) {
      throw new Error(
        `write ${stuck.type} ${stuck.id} gave up: ${stuck.lastError}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`writes did not settle within ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}
