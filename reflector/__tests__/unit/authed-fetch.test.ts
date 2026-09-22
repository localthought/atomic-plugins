import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type ReflectorConfig } from '../../src/config/index.js';
import { buildDocument } from '../../src/sync/document.js';
import {
  deriveAuthProfile,
  type AuthProfile,
  type OAuthTokens,
} from '../../src/oauth/oauth.js';
import {
  SYNCABLES_BASE_URL,
  TokenManager,
} from '../../src/oauth/authed-fetch.js';

const cwd = process.cwd();

const config: ReflectorConfig = {
  ...loadConfig(),
  openApiPath: join(cwd, 'spec/google-calendar-v3.openapi.yaml'),
  overlayDir: join(cwd, 'spec/overlays'),
};

// The auth profile — API base, token endpoint, scopes — is derived from the
// document, so these tests exercise exactly what the running app would use.
let profile: AuthProfile;
beforeAll(async () => {
  profile = deriveAuthProfile(await buildDocument(config));
});

function freshTokens(): OAuthTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 3_600_000,
  };
}

describe('TokenManager.authorizedFetch', () => {
  it('retargets to the API base, fills path params, and adds a bearer token', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(input), auth: headers.get('Authorization') });
        return new Response('{}', { status: 200 });
      },
    ) as unknown as typeof fetch;

    const manager = new TokenManager(
      profile,
      config.oauth,
      freshTokens(),
      fakeFetch,
    );
    const fetchImpl = manager.authorizedFetch({
      calendarId: 'user@example.com',
    });

    // The URL syncables would build for the events collection (braces encoded).
    await fetchImpl(
      `${SYNCABLES_BASE_URL}/calendars/%7BcalendarId%7D/events?maxResults=250`,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/user%40example.com/events?maxResults=250',
    );
    expect(seen[0]?.auth).toBe('Bearer access-1');
  });

  it('refreshes the access token once on a 401 and retries', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === profile.tokenUrl) {
        return new Response(
          JSON.stringify({
            access_token: 'access-2',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200 },
        );
      }
      calls += 1;
      return new Response('{}', { status: calls === 1 ? 401 : 200 });
    }) as unknown as typeof fetch;

    const manager = new TokenManager(
      profile,
      config.oauth,
      freshTokens(),
      fakeFetch,
    );
    const fetchImpl = manager.authorizedFetch({ calendarId: 'primary' });
    const response = await fetchImpl(
      `${SYNCABLES_BASE_URL}/calendars/primary/events`,
    );

    expect(response.status).toBe(200);
    expect(manager.current().accessToken).toBe('access-2');
  });
});
