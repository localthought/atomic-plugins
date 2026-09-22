import {
  createApiClient,
  type ApiClient,
  type OpenApiDocument,
} from 'syncables';
import type { ReflectionSide } from 'devonian/reflect';
import {
  SYNCABLES_BASE_URL,
  type AuthorizedFetcher,
} from '../oauth/authed-fetch.js';
import { subsetDocument } from '../sync/document.js';
import type { ManagedCollection, ResourceModel } from '../sync/resources.js';

/** Everything needed to bind one side of a reflection pair. */
export interface SideConfig {
  /** Stable name identifying this system (e.g. a GitHub `owner/repo`), used in markers and the id-map. */
  system: string;
  document: OpenApiDocument;
  model: ResourceModel;
  auth: AuthorizedFetcher;
  context: Record<string, string>;
  retry: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number };
}

/**
 * Builds a `devonian` {@link ReflectionSide} bound to this app's document/
 * resource-model/OAuth machinery — the reflector-specific half that
 * `devonian`'s generic `ReflectionEngine` deliberately knows nothing about.
 */
export function buildReflectionSide(config: SideConfig): ReflectionSide {
  const collection = requireCollection(config.model, 'issues');
  const client = createApiClient(
    subsetDocument(config.document, collection.paths),
    {
      baseUrl: SYNCABLES_BASE_URL,
      fetch: withListQuery(
        config.auth.authorizedFetch(config.context),
        collection.listQuery,
      ),
      identityField: collection.idField,
      retry: config.retry,
    },
  );
  return {
    system: config.system,
    client,
    collectionUrl: collection.collectionUrl,
    idField: collection.idField,
    comments: (issueId: string) => buildCommentsClient(config, issueId),
    setState: (id: string, state: string) =>
      setState(config, collection, id, state),
  };
}

/**
 * A syncables client for one issue's comments. GitHub addresses a single
 * comment at a path that is not a child of the comments collection, which
 * the resource pairing can't model, so — since reflection only lists and
 * creates comments — the subset is given a synthetic direct-child item path
 * purely so the collection is discovered. The item path is never requested.
 */
function buildCommentsClient(
  config: SideConfig,
  issueId: string,
): { client: ApiClient; url: string; idField: string } {
  const collection = requireCollection(config.model, 'issueComments');
  const url = collection.collectionUrl;
  const base = subsetDocument(config.document, [url]);
  const document: OpenApiDocument = {
    ...base,
    paths: { ...base.paths, [`${url}/{comment_id}`]: {} },
  };
  const client = createApiClient(document, {
    baseUrl: SYNCABLES_BASE_URL,
    fetch: config.auth.authorizedFetch({
      ...config.context,
      issue_number: issueId,
    }),
    identityField: collection.idField,
    retry: config.retry,
  });
  return { client, url, idField: collection.idField };
}

/**
 * Applies a minimal `{ state }` PATCH to one issue. This goes directly through
 * the side's authorized fetch rather than syncables' `update`, because
 * syncables sends the whole record as the body — and GitHub rejects a PATCH
 * that echoes its read-only fields (user, labels, …) with a 422. Only the
 * changed field is sent.
 */
async function setState(
  config: SideConfig,
  collection: ManagedCollection,
  id: string,
  state: string,
): Promise<void> {
  const idParam =
    pathVars(collection.itemUrl).find(
      (v) => !collection.contextParams.includes(v),
    ) ?? 'id';
  const fetchImpl = config.auth.authorizedFetch({
    ...config.context,
    [idParam]: id,
  });
  const response = await fetchImpl(
    `${SYNCABLES_BASE_URL}${collection.itemUrl}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    },
  );
  if (!response.ok) {
    throw new Error(`state update failed with status ${response.status}`);
  }
}

function requireCollection(
  model: ResourceModel,
  name: string,
): ManagedCollection {
  const collection = model.byName(name);
  if (!collection) {
    throw new Error(`Unknown collection "${name}"`);
  }
  return collection;
}

/** The `{...}` path variables in a URL template. */
function pathVars(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

/**
 * Wraps a fetch so a collection's fixed list-query params (e.g. GitHub's
 * `state=all`) are added to GET requests. Applied to the syncables-issued URL
 * before the auth layer retargets it at the real API base — which preserves
 * the query string — and only sets a param that isn't already present, so it
 * doesn't override the pagination `Link` follow-ups.
 */
function withListQuery(
  fetchImpl: typeof fetch,
  listQuery: Record<string, string> | undefined,
): typeof fetch {
  if (!listQuery || Object.keys(listQuery).length === 0) {
    return fetchImpl;
  }
  const wrapped = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      return fetchImpl(input, init);
    }
    const url = new URL(typeof input === 'string' ? input : input.toString());
    for (const [key, value] of Object.entries(listQuery)) {
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, value);
      }
    }
    return fetchImpl(url.toString(), init);
  };
  return wrapped as typeof fetch;
}
