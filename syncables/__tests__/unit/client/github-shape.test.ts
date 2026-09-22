import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../../../src/client/client.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';

/**
 * Exercises the three things a GitHub-shaped API needs that a generic
 * `id`-keyed, PUT-updating, enveloped-list client does not provide:
 *
 *   1. list responses that are a **top-level array** (not an envelope) are
 *      collected across `Link`-header pages (issue #6);
 *   2. an update is sent as **PATCH**, because the item path offers no PUT
 *      (issue #5);
 *   3. the resource identity is a field other than `id` — here `number` —
 *      used for storage keys and create reconciliation (issue #4).
 *
 * The `{owner}/{repo}` templating a real GitHub client also needs is handled
 * one layer up (in the caller's `fetch`), so the paths here are concrete.
 */
const document: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'GitHub Issues (test)', version: '1.0.0' },
  paths: {
    '/issues': {
      get: {
        'x-pagination': [{ scheme: 'nextLink' }],
        responses: {
          '200': {
            description: 'issues',
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
      post: { responses: { '201': { description: 'created' } } },
    },
    '/issues/{issue_number}': {
      get: { responses: { '200': { description: 'issue' } } },
      patch: { responses: { '200': { description: 'updated' } } },
    },
  },
  components: {
    paginationSchemes: {
      nextLink: {
        type: 'nextLink',
        request: { queryParameters: { per_page: { role: 'pageSize' } } },
        response: { headers: { Link: { role: 'nextLink' } } },
      },
    },
  },
} as unknown as OpenApiDocument;

interface Call {
  method: string;
  url: string;
}

function githubFetch(calls: Call[]): typeof fetch {
  let nextNumber = 100;
  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });

    if (method === 'GET' && url.includes('/issues')) {
      if (url.includes('page=2')) {
        return new Response(
          JSON.stringify([{ number: 3, title: 'c', state: 'open' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // First page: a bare array plus a Link header pointing at page 2.
      return new Response(
        JSON.stringify([
          { number: 1, title: 'a', state: 'open' },
          { number: 2, title: 'b', state: 'open' },
        ]),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            Link: '<https://api.github.test/issues?page=2>; rel="next"',
          },
        },
      );
    }

    if (method === 'POST' && url.endsWith('/issues')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      nextNumber += 1;
      return new Response(
        JSON.stringify({ ...body, number: nextNumber, state: 'open' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (method === 'PATCH' && /\/issues\/\d+$/.test(url)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  };
  return impl as typeof fetch;
}

async function settled(client: {
  pendingWrites: () => unknown[];
}): Promise<void> {
  const start = Date.now();
  while (client.pendingWrites().length > 0) {
    if (Date.now() - start > 2000) throw new Error('writes did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('GitHub-shaped client', () => {
  const build = (calls: Call[]): ApiClient =>
    createApiClient(document, {
      baseUrl: 'https://api.github.test',
      fetch: githubFetch(calls),
      identityField: 'number',
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });

  it('collects a top-level-array list across Link-header pages, keyed by the identity field', async () => {
    const calls: Call[] = [];
    const client = build(calls);

    await client.sync();

    const issues = await client.list('/issues');
    expect(issues.map((i) => i['number']).sort()).toEqual([1, 2, 3]);
    // Stored under `number`, not `id`.
    expect(await client.get('/issues', '2')).toMatchObject({ title: 'b' });

    const pages = calls.filter((c) => c.method === 'GET');
    expect(pages.length).toBe(2); // walked both pages
  });

  it('reconciles a create onto the server-assigned number', async () => {
    const calls: Call[] = [];
    const client = build(calls);

    const created = await client.create('/issues', { title: 'new one' });
    // Local id is a temporary uuid until the POST settles.
    await settled(client);

    // The server assigned number 101; the record now lives under it.
    const stored = await client.get('/issues', '101');
    expect(stored).toMatchObject({ number: 101, title: 'new one' });
    // The temporary local key (the uuid create returned) is gone.
    const tempKey = String(created['number']);
    expect(tempKey).not.toBe('101');
    expect(await client.get('/issues', tempKey)).toBeUndefined();
  });

  it('sends an update as PATCH (never PUT)', async () => {
    const calls: Call[] = [];
    const client = build(calls);

    await client.update('/issues', '101', { state: 'closed' });
    await settled(client);

    const patch = calls.find((c) => c.url.endsWith('/issues/101'));
    expect(patch?.method).toBe('PATCH');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
