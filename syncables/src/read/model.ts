import type { OpenApiDocument, OperationObject } from '../openapi/types.js';
import type { ListMethod } from './transport.js';

/**
 * The collection model the read path walks, built from the OpenAPI CRUD
 * Causality Extension's `components.crudResources` (usually contributed by
 * an overlay): one entry per `crudResources[resource].collections[name]`.
 * After reflector's `discoverResourceModel` (reflector/src/sync/resources.ts),
 * read-only subset.
 */
export interface ReadCollection {
  /** The collection's key in `crudResources[resource].collections`. */
  name: string;
  /** The resource key in `crudResources`. */
  resource: string;
  /** Collection URL template, relative to `servers[0].url`. */
  url: string;
  /** Record field holding the item's own id (from `identity.bindings`), default `id`. */
  idField: string;
  /** Path variables in `url`, in order. */
  contextParams: string[];
  /** Fixed query parameters, from the collection's `x-list-query`. */
  listQuery: Record<string, string>;
  /** `x-list-method`: `POST` lists (e.g. Notion `/v1/search`) read `paths[url].post`. */
  method: ListMethod;
  /** Fixed JSON body fields for a POST list, from `x-list-body`. */
  listBody: Record<string, unknown>;
}

/** Enumerate `collection` and read `field` off each item to fill a path variable. */
export interface ContextProvider {
  collection: string;
  field: string;
}

export interface ReadModel {
  collections: ReadCollection[];
  providers: Map<string, ContextProvider>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value as request text: strings verbatim, null/undefined empty, anything else JSON. */
export function asText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : JSON.stringify(value);
}

function pathVariables(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

export function crudResourcesOf(
  document: OpenApiDocument,
): Record<string, unknown> {
  const raw = document.components?.['crudResources'];
  if (!isRecord(raw)) {
    throw new Error(
      'OpenAPI document declares no crudResources; apply the CRUD-causality overlay',
    );
  }
  return raw;
}

function listMethodOf(collection: Record<string, unknown>): ListMethod {
  const raw = collection['x-list-method'];
  if (raw === undefined) {
    return 'GET';
  }
  const method = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (method !== 'GET' && method !== 'POST') {
    throw new Error(`Unsupported x-list-method ${asText(raw)}`);
  }
  return method;
}

export function discoverReadModel(document: OpenApiDocument): ReadModel {
  const collections: ReadCollection[] = [];
  const firstCollection = new Map<string, string>();
  const bindings: { param: string; resource: string; field: string }[] = [];

  for (const [resource, def] of Object.entries(crudResourcesOf(document))) {
    if (!isRecord(def)) {
      continue;
    }
    const identity = isRecord(def['identity']) ? def['identity'] : {};
    const itemUrl =
      typeof identity['urlTemplate'] === 'string'
        ? identity['urlTemplate']
        : '';
    const cols = isRecord(def['collections']) ? def['collections'] : {};
    const collectionUrlHas = (param: string): boolean =>
      Object.values(cols).some(
        (c) =>
          isRecord(c) &&
          typeof c['urlTemplate'] === 'string' &&
          c['urlTemplate'].includes(`{${param}}`),
      );
    let idField = 'id';

    const identityBindings = isRecord(identity['bindings'])
      ? identity['bindings']
      : {};
    for (const [param, binding] of Object.entries(identityBindings)) {
      const field =
        isRecord(binding) && typeof binding['field'] === 'string'
          ? binding['field']
          : 'id';
      bindings.push({ param, resource, field });
      // The variable bound in the item URL, not one that repeats a
      // parent-scoping context variable, is this resource's own id.
      if (itemUrl.includes(`{${param}}`) && !collectionUrlHas(param)) {
        idField = field;
      }
    }

    for (const [name, col] of Object.entries(cols)) {
      if (!isRecord(col) || typeof col['urlTemplate'] !== 'string') {
        continue;
      }
      if (!firstCollection.has(resource)) {
        firstCollection.set(resource, name);
      }
      const listQuery: Record<string, string> = {};
      if (isRecord(col['x-list-query'])) {
        for (const [key, value] of Object.entries(col['x-list-query'])) {
          listQuery[key] = asText(value);
        }
      }
      collections.push({
        name,
        resource,
        url: col['urlTemplate'],
        idField,
        contextParams: pathVariables(col['urlTemplate']),
        listQuery,
        method: listMethodOf(col),
        listBody: isRecord(col['x-list-body'])
          ? structuredClone(col['x-list-body'])
          : {},
      });
    }
  }

  const providers = new Map<string, ContextProvider>();
  for (const { param, resource, field } of bindings) {
    const collection = firstCollection.get(resource);
    // Only an enumerable resource (one with a collection) can supply a value.
    if (collection && !providers.has(param)) {
      providers.set(param, { collection, field });
    }
  }

  return { collections, providers };
}

/** Parameters a user must supply: neither provided by a parent collection nor per item. */
export function rootParameters(model: ReadModel): string[] {
  const parameters = new Set<string>();
  for (const collection of model.collections) {
    for (const param of collection.contextParams) {
      const provider = model.providers.get(param);
      if (!provider || provider.collection === collection.name) {
        parameters.add(param);
      }
    }
  }
  return [...parameters].sort();
}

/** `servers[0].url`, which every request URL must stay under. */
export function upstreamOf(document: OpenApiDocument): URL {
  const servers = document['servers'];
  const first = Array.isArray(servers) ? servers[0] : undefined;
  const raw = isRecord(first) ? first['url'] : undefined;
  if (typeof raw !== 'string' || !raw) {
    throw new Error('OpenAPI document declares no servers');
  }
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('OpenAPI server must be an HTTP(S) URL');
  }
  return url;
}

export function listOperation(
  document: OpenApiDocument,
  path: string,
  method: ListMethod,
): OperationObject | undefined {
  const operation =
    document.paths?.[path]?.[method === 'POST' ? 'post' : 'get'];
  return isRecord(operation) ? (operation as OperationObject) : undefined;
}

export function declaredQueryParameters(
  operation: OperationObject,
): Set<string> {
  return new Set(
    (operation.parameters ?? [])
      .filter((parameter) => isRecord(parameter) && parameter.in === 'query')
      .map((parameter) => parameter.name),
  );
}

export interface PlatformDescription {
  /** Values the user fills in during setup, e.g. `workspaceId`. Sorted. */
  parameters: string[];
  /** Collection names the read walks, in document order. */
  collections: string[];
  /** The provider API base, from the document's `servers`. */
  upstream: string;
}

/** What a setup form needs: which parameters to ask for and what will be read. */
export function describeModel(
  document: OpenApiDocument,
  model: ReadModel,
): PlatformDescription {
  return {
    parameters: rootParameters(model),
    collections: model.collections.map((c) => c.name),
    upstream: upstreamOf(document).href,
  };
}

// ---------------------------------------------------------------------------
// Query selections: catalog defaults plus per-installation overrides.

export interface QuerySelection {
  query_overrides: { path: string; values: Record<string, unknown> }[];
}

function querySelection(value: unknown): QuerySelection {
  if (value === undefined || value === null) {
    return { query_overrides: [] };
  }
  if (!isRecord(value)) {
    throw new Error('Invalid query selection');
  }
  if (value['query_overrides'] === undefined) {
    return { query_overrides: [] };
  }
  const overrides = value['query_overrides'];
  if (
    !Array.isArray(overrides) ||
    overrides.some(
      (item) =>
        !isRecord(item) ||
        typeof item['path'] !== 'string' ||
        !isRecord(item['values']),
    )
  ) {
    throw new Error('Invalid query selection');
  }
  return value as unknown as QuerySelection;
}

/** Merges two selections; later values for the same path and parameter win. */
export function mergeQuerySelections(
  defaults: unknown,
  explicit?: unknown,
): QuerySelection | undefined {
  const merged = new Map<string, Record<string, unknown>>();
  for (const selection of [
    querySelection(defaults),
    querySelection(explicit),
  ]) {
    for (const override of selection.query_overrides) {
      merged.set(override.path, {
        ...merged.get(override.path),
        ...override.values,
      });
    }
  }
  return merged.size
    ? {
        query_overrides: [...merged].map(([path, values]) => ({
          path,
          values,
        })),
      }
    : undefined;
}

/**
 * Applies a selection to the model's list queries. Each override must name
 * exactly one collection by URL template, and only query parameters the
 * list operation declares: a selection can narrow a read, never add an
 * arbitrary parameter.
 */
export function applySelection(
  document: OpenApiDocument,
  model: ReadModel,
  selection: QuerySelection | undefined,
): void {
  for (const override of selection?.query_overrides ?? []) {
    const matches = model.collections.filter((c) => c.url === override.path);
    const collection = matches[0];
    if (matches.length !== 1 || !collection) {
      throw new Error(`Unknown or ambiguous collection path ${override.path}`);
    }
    const operation = listOperation(document, override.path, collection.method);
    if (!operation) {
      throw new Error(
        `Collection ${override.path} has no ${collection.method} operation`,
      );
    }
    const declared = declaredQueryParameters(operation);
    for (const [name, value] of Object.entries(override.values)) {
      if (!declared.has(name)) {
        throw new Error(`Unknown query parameter ${name} for ${override.path}`);
      }
      collection.listQuery[name] = asText(value);
    }
  }
}
