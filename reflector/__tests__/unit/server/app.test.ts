import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { OpenApiDocument } from 'syncables';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReflectorConfig } from '../../../src/config/index.js';
import type { AuthProfile } from '../../../src/oauth/oauth.js';
import type { ReflectionService } from '../../../src/reflect/service.js';
import { RemoteStorageManager } from '../../../src/remotestorage/manager.js';
import { createApp } from '../../../src/server/app.js';
import { SessionManager } from '../../../src/server/session.js';
import { FileUserStore } from '../../../src/server/user-store.js';

// The inert profile `main.ts` falls back to when a document declares no
// oauth2 authorizationCode flow (e.g. the derivation threw, or a
// misconfigured `OPENAPI_PATH` points at a token-auth document instead).
const INERT_PROFILE: AuthProfile = {
  apiBase: '',
  authorizationUrl: '',
  tokenUrl: '',
  refreshUrl: '',
  scopes: [],
  authorizationParams: {},
};

const REAL_PROFILE: AuthProfile = {
  apiBase: 'https://api.example/v1',
  authorizationUrl: 'https://accounts.example/o/auth',
  tokenUrl: 'https://accounts.example/o/token',
  refreshUrl: 'https://accounts.example/o/token',
  scopes: ['read'],
  authorizationParams: {},
};

describe('createApp', () => {
  let dir: string;
  let config: ReflectorConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reflector-app-'));
    config = {
      dataDir: dir,
      usersDir: join(dir, 'users'),
      oauth: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://reflector.example/auth/callback',
      },
    } as unknown as ReflectorConfig;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function listen(
    profile: AuthProfile,
    reflection?: ReflectionService,
  ): Promise<{
    server: Server;
    base: string;
  }> {
    const store = new FileUserStore(join(dir, 'users'));
    const rs = new RemoteStorageManager({
      module: 'reflector',
      clientId: 'https://reflector.example',
      redirectUri: 'https://reflector.example/remotestorage/callback',
    });
    const sessions = new SessionManager(
      config,
      {} as OpenApiDocument,
      profile,
      rs,
      store,
    );
    const app = createApp(config, sessions, profile, rs, reflection);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return { server, base: `http://127.0.0.1:${port}` };
  }

  it('redirects to the provider\'s authorization URL when a real OAuth flow is derived', async () => {
    const { server, base } = await listen(REAL_PROFILE);
    try {
      const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location.startsWith('https://accounts.example/o/auth?')).toBe(
        true,
      );
    } finally {
      server.close();
    }
  });

  // Regression for localthought/reflector#37: when the document has no
  // interactive OAuth flow (derivation failed and fell back to an inert
  // profile), client id/secret being set must not be enough to treat the
  // connect flow as usable — otherwise the redirect Location is built from an
  // empty authorizationUrl (just "?client_id=..."), which the browser
  // resolves relative to the current path and loops `/auth/login` on itself
  // forever (ERR_TOO_MANY_REDIRECTS).
  it('fails loudly instead of looping when the document has no OAuth flow', async () => {
    const { server, base } = await listen(INERT_PROFILE);
    try {
      const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      expect(res.status).toBe(500);
      expect(res.headers.get('location')).toBeNull();
      const body = await res.text();
      expect(body).toMatch(/no interactive OAuth flow/i);
    } finally {
      server.close();
    }
  });

  // A reflection-mode deployment runs an unattended background sync with no
  // per-user connect flow; the frontend uses this to show that status
  // instead of the interactive Connect screen (see public/app.js).
  it('/api/me reports reflection status instead of connect state when reflecting', async () => {
    const reflection = {
      status: () => ({
        enabled: true,
        direction: 'bidirectional',
        intervalMs: 60_000,
        systems: ['acme/a', 'acme/b'],
      }),
    } as unknown as ReflectionService;
    const { server, base } = await listen(REAL_PROFILE, reflection);
    try {
      const res = await fetch(`${base}/api/me`);
      const body = (await res.json()) as { reflection: unknown };
      expect(body.reflection).toEqual({
        enabled: true,
        direction: 'bidirectional',
        intervalMs: 60_000,
        systems: ['acme/a', 'acme/b'],
      });
    } finally {
      server.close();
    }
  });

  it('/api/me reports no reflection status outside reflection mode', async () => {
    const { server, base } = await listen(REAL_PROFILE);
    try {
      const res = await fetch(`${base}/api/me`);
      const body = (await res.json()) as { reflection: unknown };
      expect(body.reflection).toBeNull();
    } finally {
      server.close();
    }
  });

  // Regression for localthought/reflector#31: a failed reflect pass (e.g. a
  // misconfigured target producing a 404 against the real API) used to fall
  // through to Express's generic, message-less "Internal Server Error" HTML
  // page — indistinguishable from a crash. POST /api/reflect should surface
  // the actual failure as JSON instead.
  it('/api/reflect returns the failure as JSON instead of a bare 500 page', async () => {
    const reflection = {
      reflectNow: () => Promise.reject(new Error('GitHub API said no')),
    } as unknown as ReflectionService;
    const { server, base } = await listen(REAL_PROFILE, reflection);
    try {
      const res = await fetch(`${base}/api/reflect`, { method: 'POST' });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('GitHub API said no');
    } finally {
      server.close();
    }
  });
});
