import { describe, expect, it } from 'vitest';
import { StaticTokenManager } from '../../src/oauth/static-token.js';
import { SYNCABLES_BASE_URL } from '../../src/oauth/authed-fetch.js';

function capturingFetch(): {
  fetch: typeof fetch;
  last: () => { url: string; init?: RequestInit };
} {
  let captured: { url: string; init?: RequestInit } = { url: '' };
  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    captured = {
      url: typeof input === 'string' ? input : input.toString(),
      ...(init ? { init } : {}),
    };
    return new Response('{}', { status: 200 });
  };
  return { fetch: impl as typeof fetch, last: () => captured };
}

describe('StaticTokenManager', () => {
  it('retargets to the API base, fills path params, and attaches the bearer token', async () => {
    const cap = capturingFetch();
    const manager = new StaticTokenManager(
      'https://api.github.com',
      'ghp_secret',
      'Bearer',
      cap.fetch,
    );

    const fetchImpl = manager.authorizedFetch({
      owner: 'octo',
      repo: 'reflector-a',
    });
    await fetchImpl(`${SYNCABLES_BASE_URL}/repos/{owner}/{repo}/issues`, {
      method: 'GET',
    });

    const { url, init } = cap.last();
    expect(url).toBe('https://api.github.com/repos/octo/reflector-a/issues');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer ghp_secret',
    );
  });

  it('preserves the query string, method and body', async () => {
    const cap = capturingFetch();
    const manager = new StaticTokenManager(
      'https://api.github.com',
      'tok',
      'Bearer',
      cap.fetch,
    );

    const fetchImpl = manager.authorizedFetch({ owner: 'o', repo: 'r' });
    await fetchImpl(
      `${SYNCABLES_BASE_URL}/repos/{owner}/{repo}/issues?per_page=100`,
      { method: 'POST', body: JSON.stringify({ title: 'x' }) },
    );

    const { url, init } = cap.last();
    expect(url).toBe(
      'https://api.github.com/repos/o/r/issues?per_page=100',
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"title":"x"}');
  });

  it('supports a non-default scheme prefix (e.g. token)', async () => {
    const cap = capturingFetch();
    const manager = new StaticTokenManager(
      'https://api.github.com',
      'abc',
      'token',
      cap.fetch,
    );
    await manager.authorizedFetch()(`${SYNCABLES_BASE_URL}/x`);
    expect(new Headers(cap.last().init?.headers).get('Authorization')).toBe(
      'token abc',
    );
  });
});
