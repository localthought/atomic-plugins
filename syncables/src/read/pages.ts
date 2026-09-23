import type {
  OpenApiDocument,
  OperationObject,
  SchemaObject,
} from '../openapi/types.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import { locateItemsField } from '../pagination/items.js';
import {
  buildBody,
  buildQuery,
  nextCursor,
  type PageCursor,
} from '../pagination/request-builder.js';
import {
  parsePaginationState,
  setNestedField,
} from '../pagination/response-parser.js';
import type { PaginationSchemeObject } from '../pagination/types.js';
import { isRecord } from './model.js';
import {
  lowerCaseHeaders,
  type ListMethod,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './transport.js';

export interface ReadLimits {
  /** Requests across the whole read, including retries. */
  maxRequests: number;
  /** Records across the whole read; more stops with an error. */
  maxRecords: number;
  /** Wall-clock budget for the whole read, in milliseconds. */
  timeoutMs: number;
  /** 429 retries per request, honouring `Retry-After`. */
  maxRetries: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxRequests: 10000,
  maxRecords: 5000,
  timeoutMs: 30 * 60 * 1000,
  maxRetries: 3,
};

/** A whole-read budget ran out: stop every collection, keep what was read. */
export class BudgetExhausted extends Error {}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a transport with the whole-read budget: a request count, a
 * deadline, and bounded 429 retries that wait out `Retry-After` (seconds or
 * an HTTP date). A 429 without a usable `Retry-After` is returned as-is.
 */
export class Budget {
  readonly limits: ReadLimits;
  private readonly deadline: number;
  private requests = 0;

  constructor(
    private readonly transport: Transport,
    limits: Partial<ReadLimits> = {},
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.limits = { ...DEFAULT_READ_LIMITS, ...limits };
    this.deadline = Date.now() + this.limits.timeoutMs;
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    for (let retries = 0; ; retries += 1) {
      if (Date.now() > this.deadline) {
        throw new BudgetExhausted('Read timed out');
      }
      this.requests += 1;
      if (this.requests > this.limits.maxRequests) {
        throw new BudgetExhausted(
          `Read exceeds ${this.limits.maxRequests} requests; narrow its scope`,
        );
      }
      const raw = await this.transport(request);
      const response = { ...raw, headers: lowerCaseHeaders(raw.headers) };
      if (response.status !== 429 || retries >= this.limits.maxRetries) {
        return response;
      }
      const retryAfter = response.headers['retry-after'];
      const seconds = Number(retryAfter);
      const at =
        retryAfter !== undefined &&
        retryAfter !== '' &&
        Number.isFinite(seconds)
          ? Date.now() + Math.max(0, seconds) * 1000
          : retryAfter
            ? Date.parse(retryAfter)
            : NaN;
      if (!Number.isFinite(at)) {
        return response;
      }
      const delay = Math.max(0, at - Date.now());
      if (Date.now() + delay > this.deadline) {
        throw new Error('API retry delay exceeds the remaining read time');
      }
      await this.sleep(delay);
    }
  }
}

const COMMON_ITEMS_FIELDS = ['items', 'data', 'results', 'records', 'content'];

/**
 * The items of one page: a top-level array body, else the array property
 * `locateItemsField` finds in the response schema, else a common envelope
 * name (`items`, `data`, `results`, ...) that holds an array in the body.
 */
export function pageItems(
  body: unknown,
  responseSchema: SchemaObject | undefined,
  scheme: PaginationSchemeObject | undefined,
): Record<string, unknown>[] {
  let array: unknown;
  if (Array.isArray(body)) {
    array = body;
  } else if (isRecord(body)) {
    const field =
      locateItemsField(responseSchema, scheme) ??
      COMMON_ITEMS_FIELDS.find((name) => Array.isArray(body[name]));
    array = field === undefined ? undefined : body[field];
  }
  if (!Array.isArray(array)) {
    throw new Error('Could not locate the items array in the response');
  }
  return array.filter(isRecord);
}

/** Fills `{name}` path variables, percent-encoding each value. */
export function bindPath(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') {
      throw new Error(`Missing value for ${name}`);
    }
    return encodeURIComponent(value);
  });
}

export interface PageWalk {
  document: OpenApiDocument;
  operation: OperationObject;
  budget: Budget;
  /** `servers[0].url`; every request stays on its origin. */
  upstream: URL;
  /** Path relative to `upstream`, variables already bound. */
  path: string;
  method: ListMethod;
  query: Record<string, string>;
  /** Fixed JSON body fields (POST only); the cursor is merged in per page. */
  body: Record<string, unknown>;
  pageSize?: number;
}

export interface Page {
  url: URL;
  items: Record<string, unknown>[];
}

function withBody(
  body: Record<string, unknown>,
  cursorFields: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(body);
  const flat: [string, unknown][] = [];
  const collect = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      if (isRecord(value)) {
        collect(value, `${prefix}${key}.`);
      } else {
        flat.push([`${prefix}${key}`, value]);
      }
    }
  };
  collect(cursorFields, '');
  for (const [path, value] of flat) {
    setNestedField(merged, path, value);
  }
  return merged;
}

/**
 * Walks every page of one list operation through its resolved pagination
 * scheme (explicit `x-pagination`, else auto-detected): page numbers or
 * offsets, page tokens/cursors (in the query or, for a POST, the JSON
 * body), and next links (in the body or an RFC 8288 `Link` header). With
 * no scheme it makes one request. Yields each page's items as it arrives,
 * so a caller that stops early (a cap) keeps what was already read.
 *
 * Stops with an error when a page repeats (a proxy that drops the cursor
 * would otherwise loop until the request budget runs out), when a next
 * link leaves the upstream origin or carries credentials or a fragment, on
 * a non-2xx status, or on a non-JSON body.
 */
export async function* walkPages(walk: PageWalk): AsyncGenerator<Page> {
  const { document, operation, budget, upstream } = walk;
  const effective = resolveEffectiveScheme(document, operation);
  const scheme = effective?.scheme;
  const responseSchema =
    operation.responses?.['200']?.content?.['application/json']?.schema;
  const basePath = upstream.pathname.replace(/\/$/, '');
  const seen = new Set<string>();
  let cursor: PageCursor = {};
  let next: URL | undefined;
  let itemsSoFar = 0;

  for (;;) {
    let url = next;
    if (!url) {
      url = new URL(upstream.href);
      url.pathname = basePath + walk.path;
      const query = {
        ...walk.query,
        ...(scheme ? buildQuery(scheme, cursor, walk.pageSize) : {}),
      };
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    const request: TransportRequest = {
      url,
      method: walk.method,
      headers: { accept: 'application/json' },
    };
    if (walk.method === 'POST') {
      request.headers['content-type'] = 'application/json';
      request.body = JSON.stringify(
        next || !scheme
          ? walk.body
          : withBody(walk.body, buildBody(scheme, cursor, walk.pageSize)),
      );
    }

    const key = `${request.method} ${url.href} ${request.body ?? ''}`;
    if (seen.has(key)) {
      throw new Error('Pagination repeated a page; stopping');
    }
    seen.add(key);

    const response = await budget.send(request);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `${request.method} ${url.pathname} responded ${response.status}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error(`${request.method} ${url.pathname} did not return JSON`);
    }

    const items = pageItems(body, responseSchema, scheme);
    itemsSoFar += items.length;
    yield { url, items };

    if (!scheme) {
      return;
    }
    const state = parsePaginationState(
      scheme,
      isRecord(body) ? body : {},
      response.headers,
      itemsSoFar,
    );
    if (!state.hasNextPage) {
      return;
    }

    if (
      scheme.type === 'nextLink' ||
      (state.nextLink !== null && state.nextPageToken === null)
    ) {
      if (state.nextLink === null) {
        return;
      }
      const link = new URL(state.nextLink, url);
      if (
        link.origin !== upstream.origin ||
        link.username ||
        link.password ||
        link.hash
      ) {
        throw new Error('Pagination left the API origin');
      }
      next = link;
    } else {
      if (scheme.type === 'pageNumber' && items.length === 0) {
        return;
      }
      const following = nextCursor(scheme, cursor, state, items.length);
      if (!following) {
        return;
      }
      cursor = following;
      next = undefined;
    }
  }
}
