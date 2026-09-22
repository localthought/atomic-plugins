import { describe, expect, it, vi } from 'vitest';
import { RemoteStorageManager } from '../../../src/remotestorage/manager.js';

const AUTH_PROP = 'http://tools.ietf.org/html/rfc6749#section-4.2';

function webfingerFetch(): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          links: [
            {
              rel: 'remotestorage',
              href: 'https://storage.example/me/',
              properties: { [AUTH_PROP]: 'https://storage.example/oauth/me' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/jrd+json' } },
      ),
  ) as unknown as typeof fetch;
}

/** Also answers folder-listing requests against the module base, gated on `validToken`. */
function webfingerAndFolderFetch(validToken: string): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('.well-known/webfinger')) {
      return new Response(
        JSON.stringify({
          links: [
            {
              rel: 'remotestorage',
              href: 'https://storage.example/me/',
              properties: { [AUTH_PROP]: 'https://storage.example/oauth/me' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/jrd+json' } },
      );
    }
    const auth = new Headers(init?.headers).get('Authorization');
    if (auth !== `Bearer ${validToken}`) {
      return new Response(null, { status: 401 });
    }
    return new Response(JSON.stringify({ items: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/ld+json' },
    });
  }) as unknown as typeof fetch;
}

const OPTIONS = {
  module: 'reflector',
  clientId: 'https://reflector.example',
  redirectUri: 'https://reflector.example/remotestorage/callback',
};

describe('RemoteStorageManager', () => {
  it('reports local storage for no connection', () => {
    const manager = new RemoteStorageManager(OPTIONS, webfingerFetch());
    expect(manager.backend(undefined)).toBeUndefined();
    expect(manager.status(undefined)).toEqual({
      kind: 'local',
      label: 'Local files',
      userAddress: null,
    });
  });

  it('builds an OAuth authorize URL from WebFinger discovery', async () => {
    const manager = new RemoteStorageManager(OPTIONS, webfingerFetch());
    const { authUrl, state } = await manager.beginConnect('me@storage.example');

    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://storage.example/oauth/me');
    expect(url.searchParams.get('redirect_uri')).toBe(OPTIONS.redirectUri);
    expect(url.searchParams.get('client_id')).toBe(OPTIONS.clientId);
    expect(url.searchParams.get('scope')).toBe('reflector:rw');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('state')).toBe(state);
  });

  it('completes a connection and exposes a backend for it', async () => {
    const manager = new RemoteStorageManager(OPTIONS, webfingerFetch());
    const { state } = await manager.beginConnect('me@storage.example');
    const connection = manager.completeConnect(state, 'the-token');

    expect(connection).toMatchObject({
      userAddress: 'me@storage.example',
      href: 'https://storage.example/me',
      module: 'reflector',
      token: 'the-token',
    });
    expect(manager.backend(connection)?.label).toBe(
      'remoteStorage: me@storage.example',
    );
    expect(manager.status(connection)).toEqual({
      kind: 'remotestorage',
      label: 'remoteStorage: me@storage.example',
      userAddress: 'me@storage.example',
    });
  });

  it('rejects completing an unknown or reused state', async () => {
    const manager = new RemoteStorageManager(OPTIONS, webfingerFetch());
    expect(() => manager.completeConnect('nope', 'tok')).toThrow(
      /Unknown or expired/,
    );

    const { state } = await manager.beginConnect('me@storage.example');
    manager.completeConnect(state, 'tok');
    // The state is single-use.
    expect(() => manager.completeConnect(state, 'tok')).toThrow(
      /Unknown or expired/,
    );
  });

  it('connects directly from a pre-issued token once discovery and the token both check out', async () => {
    const manager = new RemoteStorageManager(
      OPTIONS,
      webfingerAndFolderFetch('good-token'),
    );
    const connection = await manager.connectWithToken(
      'me@storage.example',
      'good-token',
    );
    expect(connection).toMatchObject({
      userAddress: 'me@storage.example',
      href: 'https://storage.example/me',
      module: 'reflector',
      token: 'good-token',
    });
  });

  it('rejects a token the provider does not accept', async () => {
    const manager = new RemoteStorageManager(
      OPTIONS,
      webfingerAndFolderFetch('good-token'),
    );
    await expect(
      manager.connectWithToken('me@storage.example', 'wrong-token'),
    ).rejects.toThrow(/status 401/);
  });
});
