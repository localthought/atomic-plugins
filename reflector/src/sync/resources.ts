import { randomInt, randomUUID } from 'node:crypto';
import type { OpenApiDocument } from 'syncables';

/**
 * One resource collection Reflector manages, fully described by the document's
 * `crudResources` extension (contributed by the CRUD-causality overlay). The
 * engine reads these instead of hard-coding any paths, so nothing here is
 * specific to Google or to Calendar — a different document with a different
 * `crudResources` map yields a different set of collections.
 */
export interface ManagedCollection {
  /** The collection's key in `crudResources[resource].collections`, e.g. `events`. */
  name: string;
  /** The resource key in `crudResources`, e.g. `event`. */
  resource: string;
  /** Collection URL template, e.g. `/calendars/{calendarId}/events`. */
  collectionUrl: string;
  /** Single-item URL template (the resource's identity), e.g. `/calendars/{calendarId}/events/{eventId}`. */
  itemUrl: string;
  /** Response property that holds the item array, from the collection's `envelope.itemsField`. */
  itemsField: string;
  /** Record field that carries the item's own id (from the identity binding), usually `id`. */
  idField: string;
  /** Path variables in `collectionUrl` that must be supplied by a parent (e.g. `calendarId`). */
  contextParams: string[];
  /** Whether the create operation expects a client-generated id. */
  generatesId: boolean;
  /** Pattern the generated id must match, from the create op's `addedFields.id.schema.pattern`. */
  idPattern?: string;
  /**
   * Fixed query parameters to add to the list request, from the collection's
   * `x-list-query`. GitHub's issues list defaults to open issues only, so the
   * overlay declares `{ state: all }` to include closed ones — without it a
   * closed record drops out of the sync and its state change can't be reflected.
   */
  listQuery?: Record<string, string>;
  /** `[collectionUrl, itemUrl]`, ready to hand to `subsetDocument`. */
  paths: string[];
}

/**
 * How a collection's context variable is filled: enumerate `collection` and
 * read `field` off each item. E.g. `calendarId` is provided by listing
 * `calendarList` and reading each entry's `id`.
 */
export interface ContextProvider {
  collection: string;
  field: string;
}

export interface ResourceModel {
  collections: ManagedCollection[];
  byName(name: string): ManagedCollection | undefined;
  /** The collection+field that supplies values for a context path variable, if any. */
  providerFor(param: string): ContextProvider | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathVariables(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

/** Reads a collection's `x-list-query` into a string map of fixed list params. */
function listQueryOf(collection: Record<string, unknown>): {
  listQuery?: Record<string, string>;
} {
  const raw = collection['x-list-query'];
  if (!isRecord(raw)) {
    return {};
  }
  const listQuery: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    listQuery[key] = String(value);
  }
  return Object.keys(listQuery).length ? { listQuery } : {};
}

function itemsFieldOf(collection: Record<string, unknown>): string {
  const envelope = collection['envelope'];
  const field = isRecord(envelope) ? envelope['itemsField'] : undefined;
  return typeof field === 'string' ? field : 'items';
}

/** Reads the id-generation policy for a collection from its create operation's `x-crud`. */
function idPolicy(
  document: OpenApiDocument,
  collectionUrl: string,
): { generatesId: boolean; idPattern?: string } {
  const post = document.paths[collectionUrl]?.post;
  const crud = post?.['x-crud'];
  const added = isRecord(crud) ? crud['addedFields'] : undefined;
  const idField = isRecord(added) ? added['id'] : undefined;
  if (!isRecord(idField) || idField['source'] !== 'generated') {
    return { generatesId: false };
  }
  const schema = idField['schema'];
  const pattern = isRecord(schema) ? schema['pattern'] : undefined;
  return {
    generatesId: true,
    ...(typeof pattern === 'string' ? { idPattern: pattern } : {}),
  };
}

/**
 * Builds the resource model from `components.crudResources`. Each resource may
 * declare an `identity` (its single-item URL and the binding from a path
 * variable to a record field) and one or more `collections` (list URLs). We
 * emit one {@link ManagedCollection} per declared collection and record, for
 * every resource, which path variable its identity binds to which field — that
 * binding is what lets a nested collection's context be resolved from a parent.
 */
export function discoverResourceModel(
  document: OpenApiDocument,
): ResourceModel {
  const crudResources = document.components?.['crudResources'];
  if (!isRecord(crudResources)) {
    throw new Error(
      'OpenAPI document declares no crudResources; apply the CRUD-causality overlay.',
    );
  }

  const collections: ManagedCollection[] = [];
  // resourceName -> its first managed collection name (used as an enumeration source).
  const collectionOfResource = new Map<string, string>();
  // path variable -> { resource, field } from every resource identity binding.
  const bindings: { param: string; resource: string; field: string }[] = [];

  for (const [resource, def] of Object.entries(crudResources)) {
    if (!isRecord(def)) {
      continue;
    }
    const identity = def['identity'];
    const itemUrl =
      isRecord(identity) && typeof identity['urlTemplate'] === 'string'
        ? identity['urlTemplate']
        : '';
    const identityBindings = isRecord(identity)
      ? identity['bindings']
      : undefined;
    let idField = 'id';
    if (isRecord(identityBindings)) {
      for (const [param, binding] of Object.entries(identityBindings)) {
        const field =
          isRecord(binding) && typeof binding['field'] === 'string'
            ? binding['field']
            : 'id';
        bindings.push({ param, resource, field });
        // The variable bound in the item URL is this resource's own id field.
        if (itemUrl.includes(`{${param}}`) && !collectionUrlHas(def, param)) {
          idField = field;
        }
      }
    }

    const cols = def['collections'];
    if (!isRecord(cols)) {
      continue;
    }
    for (const [name, col] of Object.entries(cols)) {
      if (!isRecord(col) || typeof col['urlTemplate'] !== 'string') {
        continue;
      }
      const collectionUrl = col['urlTemplate'];
      if (!collectionOfResource.has(resource)) {
        collectionOfResource.set(resource, name);
      }
      collections.push({
        name,
        resource,
        collectionUrl,
        itemUrl,
        itemsField: itemsFieldOf(col),
        idField,
        contextParams: pathVariables(collectionUrl),
        ...idPolicy(document, collectionUrl),
        ...listQueryOf(col),
        paths: itemUrl ? [collectionUrl, itemUrl] : [collectionUrl],
      });
    }
  }

  const providers = new Map<string, ContextProvider>();
  for (const { param, resource, field } of bindings) {
    const collection = collectionOfResource.get(resource);
    // A resource can supply a context value only if it is itself enumerable
    // (has a managed collection). `calendar` binds calendarId too but has no
    // collection, so `calendarList` wins as the provider — unambiguously.
    if (collection && !providers.has(param)) {
      providers.set(param, { collection, field });
    }
  }

  return {
    collections,
    byName: (name) => collections.find((c) => c.name === name),
    providerFor: (param) => providers.get(param),
  };
}

/** Whether any of the resource's collection URLs contains `{param}`. */
function collectionUrlHas(
  def: Record<string, unknown>,
  param: string,
): boolean {
  const cols = def['collections'];
  if (!isRecord(cols)) {
    return false;
  }
  return Object.values(cols).some(
    (col) =>
      isRecord(col) &&
      typeof col['urlTemplate'] === 'string' &&
      col['urlTemplate'].includes(`{${param}}`),
  );
}

/** Expands a bracket char-class body like `a-v0-9` into its concrete characters. */
function expandCharClass(spec: string): string {
  let out = '';
  for (let i = 0; i < spec.length; i += 1) {
    if (spec[i + 1] === '-' && i + 2 < spec.length) {
      const start = spec.charCodeAt(i);
      const end = spec.charCodeAt(i + 2);
      for (let code = start; code <= end; code += 1) {
        out += String.fromCharCode(code);
      }
      i += 2;
    } else {
      out += spec[i];
    }
  }
  return out;
}

/**
 * Generates an id that satisfies a simple `^[charset]{n}$` / `^[charset]{min,max}$`
 * pattern — the shape the overlay declares for resources whose id the client
 * mints locally (Google's is base32hex, `^[a-v0-9]{26}$`). Anything the parser
 * doesn't recognize falls back to a random UUID, which every store accepts.
 */
export function generateId(pattern?: string): string {
  if (!pattern) {
    return randomUUID();
  }
  const match = /^\^\[([^\]]+)\]\{(\d+)(?:,(\d+))?\}\$$/.exec(pattern);
  if (!match) {
    return randomUUID();
  }
  const charset = expandCharClass(match[1] as string);
  if (!charset) {
    return randomUUID();
  }
  const min = Number(match[2]);
  const max = match[3] === undefined ? min : Number(match[3]);
  // Prefer a comfortable fixed length, clamped into the pattern's range.
  const length = Math.min(Math.max(min, 26), max);
  let id = '';
  for (let i = 0; i < length; i += 1) {
    id += charset[randomInt(charset.length)];
  }
  return id;
}
