import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OpenApiDocument } from 'syncables';
import { ReflectionEngine, InMemoryIdMap, parseMarker } from 'devonian/reflect';
import { buildDocumentFrom } from '../../../src/sync/document.js';
import {
  discoverResourceModel,
  type ResourceModel,
} from '../../../src/sync/resources.js';
import type { AuthorizedFetcher, PathParams } from '../../../src/oauth/authed-fetch.js';
import { buildReflectionSide, type SideConfig } from '../../../src/reflect/sides.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
}

interface Comment {
  id: number;
  body: string;
}

/** A tiny in-memory GitHub Issues API for two repositories. */
class FakeGitHub {
  private readonly repos = new Map<string, Issue[]>();
  private readonly commentStore = new Map<string, Comment[]>();
  private seq = 1000;

  seed(repo: string, issues: Omit<Issue, 'id'>[]): void {
    this.repos.set(
      repo,
      issues.map((i) => ({ ...i, id: (this.seq += 1) })),
    );
  }

  issues(repo: string): Issue[] {
    return this.repos.get(repo) ?? [];
  }

  comments(repo: string, issueNumber: number): Comment[] {
    return this.commentStore.get(`${repo}#${issueNumber}`) ?? [];
  }

  addComment(repo: string, issueNumber: number, body: string): Comment {
    const key = `${repo}#${issueNumber}`;
    const list = this.commentStore.get(key) ?? [];
    const comment = { id: (this.seq += 1), body };
    list.push(comment);
    this.commentStore.set(key, list);
    return comment;
  }

  /** An AuthorizedFetcher bound to a repo context, routing to this store. */
  authFor(): AuthorizedFetcher {
    return {
      authorizedFetch: (params: PathParams = {}): typeof fetch => {
        const impl = async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          const url = new URL(
            typeof input === 'string' ? input : input.toString(),
          );
          let path = url.pathname;
          for (const [k, v] of Object.entries(params)) {
            path = path
              .replaceAll(`{${k}}`, v)
              .replaceAll(`%7B${k}%7D`, v)
              .replaceAll(`%7b${k}%7d`, v);
          }
          return this.route(
            (init?.method ?? 'GET').toUpperCase(),
            path,
            init,
            url.searchParams,
          );
        };
        return impl as typeof fetch;
      },
    };
  }

  private route(
    method: string,
    path: string,
    init?: RequestInit,
    query: URLSearchParams = new URLSearchParams(),
  ): Response {
    const list = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path);
    const item = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    const comments = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(
      path,
    );
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (comments) {
      const repo = `${comments[1]}/${comments[2]}`;
      const number = Number(comments[3]);
      if (method === 'GET') {
        return json(this.comments(repo, number));
      }
      if (method === 'POST') {
        const b = JSON.parse(String(init?.body ?? '{}')) as { body?: string };
        return json(this.addComment(repo, number, b.body ?? ''), 201);
      }
    }

    if (list) {
      const repo = `${list[1]}/${list[2]}`;
      const issues = this.issues(repo);
      if (method === 'GET') {
        // Like GitHub, list only open issues unless state=all/closed is asked.
        const stateFilter = query.get('state') ?? 'open';
        const filtered =
          stateFilter === 'all'
            ? issues
            : issues.filter((i) => i.state === stateFilter);
        return json(filtered);
      }
      if (method === 'POST') {
        const b = JSON.parse(String(init?.body ?? '{}')) as Partial<Issue>;
        this.seq += 1;
        const created: Issue = {
          id: this.seq,
          number: this.seq,
          title: b.title ?? '',
          body: b.body ?? '',
          state: 'open',
        };
        issues.push(created);
        this.repos.set(repo, issues);
        return json(created, 201);
      }
    }
    if (item && method === 'PATCH') {
      const repo = `${item[1]}/${item[2]}`;
      const number = Number(item[3]);
      const found = this.issues(repo).find((i) => i.number === number);
      if (!found) return new Response('not found', { status: 404 });
      const b = JSON.parse(String(init?.body ?? '{}')) as Partial<Issue>;
      // Like GitHub, only mutable fields are applied; id/number are immutable.
      if (typeof b.state === 'string') found.state = b.state;
      if (typeof b.title === 'string') found.title = b.title;
      if (typeof b.body === 'string') found.body = b.body;
      return json(found);
    }
    return new Response('not found', { status: 404 });
  }
}

const RETRY: SideConfig['retry'] = { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 3 };

/**
 * This test is deliberately an integration test through reflector's real
 * document/overlay/resource-discovery pipeline (`buildReflectionSide`), not
 * just the engine in isolation — that coverage now lives in `devonian`'s own
 * `__tests__/unit/reflect/engine.test.ts`, against a synthetic document.
 * What this file verifies is that reflector's own GitHub OpenAPI document +
 * overlay actually produces a `ReflectionSide` devonian's engine can drive
 * correctly (localthought/atomic-plugins#6).
 */
describe('ReflectionEngine via reflector document/overlay (issues)', () => {
  let document: OpenApiDocument;
  let model: ResourceModel;

  beforeAll(async () => {
    document = await buildDocumentFrom(
      resolve(repoRoot, 'spec/github-issues.openapi.yaml'),
      resolve(repoRoot, 'spec/overlays/github'),
    );
    model = discoverResourceModel(document);
  });

  const sides = (fake: FakeGitHub) => [
    buildReflectionSide({
      system: 'octo/a',
      document,
      model,
      auth: fake.authFor(),
      context: { owner: 'octo', repo: 'a' },
      retry: RETRY,
    }),
    buildReflectionSide({
      system: 'octo/b',
      document,
      model,
      auth: fake.authFor(),
      context: { owner: 'octo', repo: 'b' },
      retry: RETRY,
    }),
  ] as const;

  it('reflects an original issue onto the other side with a back-link marker', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'Bug', body: 'It broke', state: 'open' },
    ]);
    fake.seed('octo/b', []);

    const [a, b] = sides(fake);
    const engine = new ReflectionEngine(a, b, new InMemoryIdMap(), {
      drainTimeoutMs: 2000,
      namespace: 'reflector',
    });
    const summary = await engine.reflect();

    expect(summary.errors).toEqual([]);
    const copies = fake.issues('octo/b');
    expect(copies).toHaveLength(1);
    expect(copies[0]?.title).toBe('Bug');
    expect(copies[0]?.body).toContain('It broke');
    const marker = parseMarker(copies[0]?.body ?? '', 'reflector');
    expect(marker).toEqual({ system: 'octo/a', kind: 'issue', id: '1' });
  });

  it('does not duplicate on repeated passes and does not echo the copy back', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'Bug', body: 'It broke', state: 'open' },
    ]);
    fake.seed('octo/b', []);

    const [a, b] = sides(fake);
    const idMap = new InMemoryIdMap();
    const engine = new ReflectionEngine(a, b, idMap, {
      drainTimeoutMs: 2000,
      namespace: 'reflector',
    });

    await engine.reflect();
    await engine.reflect();
    await engine.reflect();

    // Exactly one copy on B, and A still has only its original (no echo back).
    expect(fake.issues('octo/b')).toHaveLength(1);
    expect(fake.issues('octo/a')).toHaveLength(1);
  });

  it('is idempotent even with a fresh (lost) id-map, via the destination marker scan', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'Bug', body: 'It broke', state: 'open' },
    ]);
    fake.seed('octo/b', []);
    const [a, b] = sides(fake);

    await new ReflectionEngine(a, b, new InMemoryIdMap(), {
      drainTimeoutMs: 2000,
      namespace: 'reflector',
    }).reflect();
    // Second run with a brand-new id-map (as if persistence was wiped).
    await new ReflectionEngine(a, b, new InMemoryIdMap(), {
      drainTimeoutMs: 2000,
      namespace: 'reflector',
    }).reflect();

    expect(fake.issues('octo/b')).toHaveLength(1);
  });

  it('reflects originals created on either side (bidirectional)', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'From A', body: 'a-body', state: 'open' },
    ]);
    fake.seed('octo/b', [
      { number: 5, title: 'From B', body: 'b-body', state: 'open' },
    ]);
    const [a, b] = sides(fake);
    const engine = new ReflectionEngine(a, b, new InMemoryIdMap(), {
      drainTimeoutMs: 2000,
      namespace: 'reflector',
    });

    await engine.reflect();
    await engine.reflect();

    // Each side ends with its original plus one reflected copy of the other's.
    expect(fake.issues('octo/a')).toHaveLength(2);
    expect(fake.issues('octo/b')).toHaveLength(2);
    const aTitles = fake
      .issues('octo/a')
      .map((i) => i.title)
      .sort();
    expect(aTitles).toEqual(['From A', 'From B']);
  });

  it('propagates open/closed state both ways without bouncing', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'Bug', body: 'x', state: 'open' },
    ]);
    fake.seed('octo/b', []);
    const [a, b] = sides(fake);
    const engine = new ReflectionEngine(a, b, new InMemoryIdMap(), {
      drainTimeoutMs: 2000,
      namespace: 'reflector',
    });

    // Reflect the issue, then close the ORIGINAL on A.
    await engine.reflect();
    const copyNumber = fake.issues('octo/b')[0]!.number;
    fake.issues('octo/a')[0]!.state = 'closed';

    const closed = await engine.reflect();
    expect(fake.issues('octo/b')[0]!.state).toBe('closed');
    expect(closed.updated).toHaveLength(1);

    // Stable: another pass changes nothing.
    const stable = await engine.reflect();
    expect(stable.updated).toEqual([]);
    expect(fake.issues('octo/a')[0]!.state).toBe('closed');
    expect(fake.issues('octo/b')[0]!.state).toBe('closed');

    // Reopen the COPY on B — the change flows back to the original on A.
    fake.issues('octo/b').find((i) => i.number === copyNumber)!.state = 'open';
    await engine.reflect();
    expect(fake.issues('octo/a')[0]!.state).toBe('open');
    expect(fake.issues('octo/b')[0]!.state).toBe('open');
  });

  it('reflects comments under the counterpart issue both ways, no dupes or echoes', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'Bug', body: 'x', state: 'open' },
    ]);
    fake.seed('octo/b', []);
    const [a, b] = sides(fake);
    const engine = new ReflectionEngine(a, b, new InMemoryIdMap(), {
      drainTimeoutMs: 2000,
      namespace: 'reflector',
    });

    await engine.reflect(); // creates the copy issue on B
    const copyNumber = fake.issues('octo/b')[0]!.number;

    // Comment on A's original — it lands under B's copy, marked.
    const c1 = fake.addComment('octo/a', 1, 'first reply');
    await engine.reflect();
    const bComments = fake.comments('octo/b', copyNumber);
    expect(bComments).toHaveLength(1);
    expect(bComments[0]!.body).toContain('first reply');
    expect(parseMarker(bComments[0]!.body, 'reflector')).toEqual({
      system: 'octo/a',
      kind: 'comment',
      id: String(c1.id),
    });

    // Idempotent + no echo back.
    await engine.reflect();
    expect(fake.comments('octo/b', copyNumber)).toHaveLength(1);
    expect(fake.comments('octo/a', 1)).toHaveLength(1);

    // Comment on B's copy — reflected back under A's original.
    fake.addComment('octo/b', copyNumber, 'reply on the mirror');
    await engine.reflect();
    const aComments = fake.comments('octo/a', 1);
    expect(aComments).toHaveLength(2);
    expect(aComments.some((c) => c.body.includes('reply on the mirror'))).toBe(
      true,
    );

    // Still stable on another pass.
    await engine.reflect();
    expect(fake.comments('octo/a', 1)).toHaveLength(2);
    expect(fake.comments('octo/b', copyNumber)).toHaveLength(2);
  });
});
