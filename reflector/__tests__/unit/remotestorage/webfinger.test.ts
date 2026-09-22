import { describe, expect, it, vi } from 'vitest';
import { discover, parseUserAddress } from '../../../src/remotestorage/webfinger.js';

const AUTH_PROP = 'http://tools.ietf.org/html/rfc6749#section-4.2';

function jrdFetch(document: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(document), {
      status,
      headers: { 'Content-Type': 'application/jrd+json' },
    }),
  ) as unknown as typeof fetch;
}

describe('parseUserAddress', () => {
  it('splits user@host and tolerates an acct: prefix', () => {
    expect(parseUserAddress('me@storage.example')).toEqual({
      user: 'me',
      host: 'storage.example',
    });
    expect(parseUserAddress('acct:me@storage.example')).toEqual({
      user: 'me',
      host: 'storage.example',
    });
  });

  it('rejects malformed addresses', () => {
    expect(() => parseUserAddress('nope')).toThrow();
    expect(() => parseUserAddress('@host')).toThrow();
    expect(() => parseUserAddress('user@')).toThrow();
  });
});

describe('discover', () => {
  it('extracts the storage href and OAuth endpoint from the WebFinger document', async () => {
    const fetchImpl = jrdFetch({
      links: [
        { rel: 'lrdd', href: 'https://storage.example/other' },
        {
          rel: 'http://tools.ietf.org/id/draft-dejong-remotestorage',
          href: 'https://storage.example/me/',
          properties: {
            [AUTH_PROP]: 'https://storage.example/oauth/me',
            'http://remotestorage.io/spec/version': 'draft-dejong-remotestorage-13',
          },
        },
      ],
    });

    const info = await discover('me@storage.example', fetchImpl);
    expect(info.userAddress).toBe('me@storage.example');
    // Trailing slash on the storage root is normalized away.
    expect(info.href).toBe('https://storage.example/me');
    expect(info.authUrl).toBe('https://storage.example/oauth/me');

    const called = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(called).toBe(
      'https://storage.example/.well-known/webfinger?resource=acct%3Ame%40storage.example',
    );
  });

  it('throws when no remoteStorage link is advertised', async () => {
    const fetchImpl = jrdFetch({ links: [{ rel: 'lrdd', href: 'x' }] });
    await expect(discover('me@storage.example', fetchImpl)).rejects.toThrow(
      /No remoteStorage endpoint/,
    );
  });

  it('throws when the remoteStorage link has no OAuth endpoint', async () => {
    const fetchImpl = jrdFetch({
      links: [{ rel: 'remotestorage', href: 'https://storage.example/me' }],
    });
    await expect(discover('me@storage.example', fetchImpl)).rejects.toThrow(
      /does not advertise an OAuth endpoint/,
    );
  });

  it('throws when the host has no WebFinger document', async () => {
    const fetchImpl = jrdFetch({}, 404);
    await expect(discover('me@storage.example', fetchImpl)).rejects.toThrow(
      /status 404/,
    );
  });
});
