import {
  applyOverlay,
  type OverlayDocument,
} from '../openapi/apply-overlay.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import type { OpenApiDocument } from '../openapi/types.js';
import {
  applySelection,
  asText,
  describeModel,
  discoverReadModel,
  listOperation,
  rootParameters,
  upstreamOf,
  type PlatformDescription,
  type QuerySelection,
  type ReadCollection,
  type ReadModel,
} from './model.js';
import {
  DATATYPES,
  deriveOntology,
  ontologyShortname,
  type Ontology,
} from './ontology.js';
import {
  bindPath,
  Budget,
  BudgetExhausted,
  walkPages,
  type ReadLimits,
} from './pages.js';
import type { ListMethod, Transport } from './transport.js';

/**
 * Applies overlays in order, then resolves local `$ref`s. The other read
 * functions resolve refs themselves too, so this is only required when
 * there are overlays to apply (e.g. the pagination-schemes and
 * CRUD-causality overlays for a third-party document).
 */
export function prepareDocument(
  document: Record<string, unknown>,
  overlays: OverlayDocument[] = [],
): OpenApiDocument {
  const overlaid = overlays.reduce(
    (current, overlay) => applyOverlay(current, overlay),
    document,
  );
  return resolveRefs(overlaid) as unknown as OpenApiDocument;
}

const resolvedCache = new WeakMap<object, OpenApiDocument>();

function resolved(document: OpenApiDocument): OpenApiDocument {
  let result = resolvedCache.get(document);
  if (!result) {
    result = resolveRefs(document);
    resolvedCache.set(document, result);
  }
  return result;
}

/** Setup form data: the parameters to ask for, and what a read walks. */
export function describePlatform(
  document: OpenApiDocument,
): PlatformDescription {
  const doc = resolved(document);
  return describeModel(doc, discoverReadModel(doc));
}

export interface ReadOptions {
  /** Copied onto the result, for the caller's bookkeeping. */
  platform: string;
  /** Values for `describePlatform(document).parameters`. */
  constants: Record<string, string>;
  transport: Transport;
  selection?: QuerySelection;
  limits?: Partial<ReadLimits>;
  /** Waits out a 429's `Retry-After`; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Make one request to the first root collection, read nothing, return an empty result. */
  probe?: boolean;
}

export interface ReadRecord {
  /** `ontologyShortname` of the `crudResources` key. */
  resource: string;
  /** The collection's path-variable values joined by `/`; `''` for a root collection. */
  namespace: string;
  /** `String(item[idField])`. */
  id: string;
  /** The first non-empty string of `title`, `summary`, `name`; else `id`. */
  name: string;
  /**
   * Values keyed by property shortname, for fields the ontology knows only.
   * `date-time` strings become epoch milliseconds; null and absent fields
   * are left out; everything else is the provider's JSON value as-is.
   */
  values: Record<string, unknown>;
}

export interface ReadResult {
  platform: string;
  ontology: Ontology;
  records: ReadRecord[];
  /** Non-fatal per-collection failures, as `<collection>: <message>`. */
  errors: string[];
}

interface Origin {
  value: Record<string, unknown>;
  path: Record<string, string>;
}

class ProbeDone extends Error {}

/** Every combination of provider values, one parent record per provider collection. */
function invocations(
  collection: ReadCollection,
  model: ReadModel,
  constants: Record<string, string>,
  origins: Map<string, Origin[]>,
): Record<string, string>[] {
  const groups = new Map<string, { param: string; field: string }[]>();
  for (const param of collection.contextParams) {
    if (param in constants) {
      continue;
    }
    const provider = model.providers.get(param);
    if (!provider) {
      continue;
    }
    groups.set(provider.collection, [
      ...(groups.get(provider.collection) ?? []),
      { param, field: provider.field },
    ]);
  }

  let combos: Record<string, string>[] = [{ ...constants }];
  for (const [source, params] of groups) {
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const parent of origins.get(source) ?? []) {
        const values = { ...parent.path, ...combo };
        for (const { param, field } of params) {
          values[param] = asText(parent.value[field]);
        }
        if (params.every(({ param }) => values[param])) {
          next.push(values);
        }
      }
    }
    combos = next;
  }

  const seen = new Set<string>();
  return combos.filter((combo) => {
    const key = JSON.stringify(
      collection.contextParams.map((p) => combo[p] ?? ''),
    );
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

function typedValue(value: unknown, datatype: string): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (datatype === DATATYPES.timestamp) {
    if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
      throw new Error('Invalid provider timestamp');
    }
    return Date.parse(value);
  }
  return value;
}

/**
 * Walks every `crudResources` collection of `document` through `transport`
 * and returns the records plus the derived ontology. A collection whose
 * path variables come from a parent runs once per parent record, after the
 * parent. A failed collection becomes an entry in `errors` and the read
 * continues; a budget running out (`limits`) stops every collection but
 * keeps what was read. Throws when a root parameter is missing, or when
 * nothing was read and something failed.
 */
export async function readPlatform(
  document: OpenApiDocument,
  options: ReadOptions,
): Promise<ReadResult> {
  const doc = resolved(document);
  const budget = new Budget(options.transport, options.limits, options.sleep);
  const model = discoverReadModel(doc);
  applySelection(doc, model, options.selection);
  const upstream = upstreamOf(doc);
  const constants = options.constants;
  for (const param of rootParameters(model)) {
    if (!constants[param]) {
      throw new Error(`Enter a value for ${param}`);
    }
  }
  const ontology: Ontology = options.probe
    ? { description: '', terms: [] }
    : deriveOntology(doc);
  const properties = new Map<string, string>(
    ontology.terms
      .filter((t) => t.kind === 'property')
      .map((t) => [t.shortname, t.datatype]),
  );
  const records: ReadRecord[] = [];
  const identities = new Set<string>();
  const errors: string[] = [];
  const origins = new Map<string, Origin[]>();

  const walk = async (
    collection: ReadCollection,
    path: Record<string, string>,
  ): Promise<Origin[]> => {
    const operation = listOperation(doc, collection.url, collection.method);
    if (!operation) {
      throw new Error(
        `${collection.url} declares no ${collection.method} operation`,
      );
    }
    const namespace = collection.contextParams
      .map((p) => path[p] ?? '')
      .join('/');
    const out: Origin[] = [];

    for await (const page of walkPages({
      document: doc,
      operation,
      budget,
      upstream,
      path: bindPath(collection.url, path),
      method: collection.method,
      query: collection.listQuery,
      body: collection.listBody,
    })) {
      if (options.probe) {
        throw new ProbeDone();
      }
      for (const value of page.items) {
        const id = asText(value[collection.idField]);
        const key = JSON.stringify([collection.resource, namespace, id]);
        if (!id || identities.has(key)) {
          throw new Error(
            'Missing or repeated record identity; pagination may not be forwarded by the proxy',
          );
        }
        if (records.length >= budget.limits.maxRecords) {
          throw new BudgetExhausted(
            `Read exceeds ${budget.limits.maxRecords} records; narrow its scope`,
          );
        }
        identities.add(key);
        const values: Record<string, unknown> = {};
        for (const [field, raw] of Object.entries(value)) {
          const shortname = ontologyShortname(field);
          const datatype = properties.get(shortname);
          if (!datatype) {
            continue;
          }
          const typed = typedValue(raw, datatype);
          if (typed !== undefined) {
            values[shortname] = typed;
          }
        }
        const name = [value['title'], value['summary'], value['name']].find(
          (v): v is string => typeof v === 'string' && v !== '',
        );
        records.push({
          resource: ontologyShortname(collection.resource),
          namespace,
          id,
          name: name ?? id,
          values,
        });
        out.push({ value, path });
      }
    }
    return out;
  };

  let pending = [...model.collections];
  while (pending.length) {
    const waiting: ReadCollection[] = [];
    let progressed = false;

    for (const collection of pending) {
      const sources = collection.contextParams
        .filter((p) => !(p in constants))
        .map((p) => model.providers.get(p)?.collection);

      if (sources.some((s) => s === undefined || s === collection.name)) {
        errors.push(`${collection.name}: its context has no provider`);
        progressed = true;
        continue;
      }
      if (!sources.every((source) => origins.has(source as string))) {
        waiting.push(collection);
        continue;
      }

      progressed = true;
      const read: Origin[] = [];
      for (const path of invocations(collection, model, constants, origins)) {
        try {
          read.push(...(await walk(collection, path)));
        } catch (error) {
          if (error instanceof ProbeDone) {
            return {
              platform: options.platform,
              ontology,
              records: [],
              errors: [],
            };
          }
          if (options.probe) {
            throw error;
          }
          errors.push(`${collection.name}: ${(error as Error).message}`);
          if (error instanceof BudgetExhausted) {
            pending = [];
            break;
          }
        }
      }
      origins.set(collection.name, read);
      if (!pending.length) {
        break;
      }
    }

    if (!pending.length) {
      break;
    }
    if (!progressed) {
      for (const c of waiting) {
        errors.push(`${c.name}: its parent collection could not be read`);
      }
      break;
    }
    pending = waiting;
  }

  if (options.probe) {
    throw new Error('No collection available to check');
  }
  if (!records.length && errors.length) {
    throw new Error(`Read incomplete: ${errors.join('; ')}`);
  }
  return { platform: options.platform, ontology, records, errors };
}

export interface PaginateOptions {
  transport: Transport;
  /** A path template from `document.paths`, e.g. `/v1/search`. */
  path: string;
  /** Default `GET`. */
  method?: ListMethod;
  pathParams?: Record<string, string>;
  /** Fixed query parameters; the page cursor is added per request. */
  query?: Record<string, string>;
  /** Fixed JSON body fields for a POST; the page cursor is merged in per request. */
  body?: Record<string, unknown>;
  /** Sent through the scheme's `pageSize`-role field, when it declares one. */
  pageSize?: number;
  limits?: Partial<ReadLimits>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Every item of one list operation, across all its pages. Needs no
 * `crudResources`; the operation's pagination scheme comes from
 * `x-pagination` or auto-detection. Raw provider items, untyped. Throws on
 * the first failed request or when a `limits` budget runs out.
 */
export async function paginate(
  document: OpenApiDocument,
  options: PaginateOptions,
): Promise<Record<string, unknown>[]> {
  const doc = resolved(document);
  const method = options.method ?? 'GET';
  const operation = listOperation(doc, options.path, method);
  if (!operation) {
    throw new Error(`${options.path} declares no ${method} operation`);
  }
  const budget = new Budget(options.transport, options.limits, options.sleep);
  const items: Record<string, unknown>[] = [];
  for await (const page of walkPages({
    document: doc,
    operation,
    budget,
    upstream: upstreamOf(doc),
    path: bindPath(options.path, options.pathParams ?? {}),
    method,
    query: options.query ?? {},
    body: options.body ?? {},
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  })) {
    items.push(...page.items);
    if (items.length > budget.limits.maxRecords) {
      throw new BudgetExhausted(
        `Read exceeds ${budget.limits.maxRecords} records; narrow its scope`,
      );
    }
  }
  return items;
}
