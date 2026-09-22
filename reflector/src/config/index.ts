import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root, resolved relative to this compiled file (build/src/config). */
const repoRoot = resolve(here, '..', '..', '..');

/**
 * One side of a reflection pair. Each endpoint can be pointed at its **own**
 * OpenAPI document + overlays (e.g. GitHub Issues for both, or two different
 * systems), so A and B need not share a schema — reconciling differing schemas
 * is left to a later Devonian mapping step. When an endpoint's own document is
 * unset it falls back to the shared `OPENAPI_PATH` / `OVERLAY_DIR`.
 */
export interface ReflectionEndpoint {
  /** OpenAPI document this endpoint is derived from. */
  openApiPath: string;
  /** Overlay directory applied to this endpoint's document. */
  overlayDir: string;
  /** The context this endpoint targets, e.g. a GitHub `owner/repo`. Empty when unset. */
  target: string;
  /** Static API token for this endpoint (e.g. a GitHub PAT). A secret; empty when unset. */
  token: string;
}

export interface ReflectorConfig {
  port: number;
  /** Public origin the browser reaches this server on; used to build the OAuth redirect URI. */
  baseUrl: string;
  /**
   * OAuth *client* credentials — the only auth values that are deployment
   * secrets rather than properties of the API. Everything else about the flow
   * (endpoints, scopes, extra request parameters, the userinfo URL, and the
   * API base) is read from the OpenAPI document's security scheme and
   * `servers`, so there is nothing provider-specific here.
   */
  oauth: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  /** Directory the local-first JSON copy is written under (used when storage is local files). */
  dataDir: string;
  /** Directory the per-user session/token records are written under (file user store). */
  usersDir: string;
  /**
   * Postgres connection string. When set, connected users are persisted in
   * Postgres instead of on disk — needed on hosts with an ephemeral filesystem
   * (a Heroku dyno, DO App Platform). Empty means the file store is used.
   */
  databaseUrl: string;
  /** File the connected account's OAuth tokens are persisted to (survives restarts). */
  tokenStorePath: string;
  remoteStorage: {
    /** File a connected remoteStorage account is persisted to (survives restarts). */
    storePath: string;
    /** The storage module (top-level directory) Reflector reads and writes, e.g. `reflector`. */
    module: string;
    /** OAuth `client_id` presented to the remoteStorage provider (the app's origin). */
    clientId: string;
    /** OAuth `redirect_uri` the implicit-grant token is returned to. */
    redirectUri: string;
  };
  /** Absolute path to the vendored OpenAPI document the app is built around. */
  openApiPath: string;
  /** Directory holding the overlays applied to that document. */
  overlayDir: string;
  /**
   * Reflection mode: mirror records between two connected endpoints (A and B),
   * each derived from its own OpenAPI document + overlays. Enabled when both
   * endpoints name a target. The engine that consumes this is being built
   * across localthought/reflector#23–#29; the config surface is defined here so
   * deployments (and the README) have a stable set of variables to point at.
   */
  reflection: {
    /** True when both endpoints name a target — the reflect loop should run. */
    enabled: boolean;
    /** `bidirectional` (A↔B, the default) or `a-to-b` (one-way A→B). */
    direction: 'bidirectional' | 'a-to-b';
    /** How often the background reflect loop runs, in milliseconds. */
    intervalMs: number;
    a: ReflectionEndpoint;
    b: ReflectionEndpoint;
  };
  retry: {
    baseDelayMs: number;
    maxDelayMs: number;
    /** After this many failed attempts a write gives up, which triggers a local rollback. */
    maxAttempts: number;
  };
}

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Heroku's default domain isn't just `<app-name>.herokuapp.com` — it can carry
 * a disambiguating suffix (e.g. `reflector-prod-8e1e64ecb238.herokuapp.com`),
 * so it can't be reconstructed from the app name. `HEROKU_APP_DEFAULT_DOMAIN_NAME`
 * reports the real value, but only once dyno metadata is enabled
 * (`heroku labs:enable runtime-dyno-metadata`); falls back to undefined
 * otherwise, e.g. when running locally.
 */
function herokuBaseUrl(): string | undefined {
  const domain = env('HEROKU_APP_DEFAULT_DOMAIN_NAME');
  return domain ? `https://${domain}` : undefined;
}

function reflectionDirection(): 'bidirectional' | 'a-to-b' {
  const raw = env('REFLECT_DIRECTION').trim().toLowerCase();
  return raw === 'a-to-b' || raw === 'a2b' || raw === 'a->b'
    ? 'a-to-b'
    : 'bidirectional';
}

export function loadConfig(): ReflectorConfig {
  const port = num('PORT', 3000);
  // Strip a trailing slash so `${baseUrl}/auth/callback`-style joins don't
  // double up, e.g. BASE_URL=https://example.com/ becoming .../auth/callback.
  const baseUrl = env(
    'BASE_URL',
    herokuBaseUrl() ?? `http://localhost:${port}`,
  ).replace(/\/+$/, '');

  // The shared, single-connection document/overlays (Google Calendar by
  // default). Each reflection endpoint falls back to these when it does not
  // name its own, so an A/B pair can share a document or differ per side.
  const sharedOpenApiPath = resolve(
    env(
      'OPENAPI_PATH',
      resolve(repoRoot, 'spec/google-calendar-v3.openapi.yaml'),
    ),
  );
  const sharedOverlayDir = resolve(
    env('OVERLAY_DIR', resolve(repoRoot, 'spec/overlays')),
  );
  const endpoint = (suffix: 'A' | 'B'): ReflectionEndpoint => ({
    openApiPath: resolve(env(`OPENAPI_PATH_${suffix}`, sharedOpenApiPath)),
    overlayDir: resolve(env(`OVERLAY_DIR_${suffix}`, sharedOverlayDir)),
    target: env(`REFLECT_${suffix}_REPO`).trim(),
    token: env(`REFLECT_${suffix}_TOKEN`),
  });
  const reflectA = endpoint('A');
  const reflectB = endpoint('B');

  return {
    port,
    baseUrl,
    oauth: {
      // Generic names, with the historical Google-specific aliases kept as a
      // fallback so existing deployments keep working.
      clientId: env(
        'OAUTH_CLIENT_ID',
        env('GOOGLE_CALENDAR_CLIENT_ID', env('GOOGLE_CLIENT_ID')),
      ),
      clientSecret: env(
        'OAUTH_CLIENT_SECRET',
        env('GOOGLE_CALENDAR_CLIENT_SECRET', env('GOOGLE_CLIENT_SECRET')),
      ),
      redirectUri: env(
        'OAUTH_REDIRECT_URI',
        env('GOOGLE_REDIRECT_URI', `${baseUrl}/auth/callback`),
      ),
    },
    dataDir: resolve(env('DATA_DIR', resolve(repoRoot, 'data'))),
    usersDir: resolve(
      env(
        'USERS_DIR',
        resolve(env('DATA_DIR', resolve(repoRoot, 'data')), 'users'),
      ),
    ),
    databaseUrl: env('DATABASE_URL'),
    tokenStorePath: resolve(
      env(
        'TOKEN_STORE_PATH',
        resolve(env('DATA_DIR', resolve(repoRoot, 'data')), 'tokens.json'),
      ),
    ),
    remoteStorage: {
      storePath: resolve(
        env(
          'REMOTESTORAGE_STORE_PATH',
          resolve(
            env('DATA_DIR', resolve(repoRoot, 'data')),
            'remotestorage.json',
          ),
        ),
      ),
      module: env('REMOTESTORAGE_MODULE', 'reflector'),
      clientId: env('REMOTESTORAGE_CLIENT_ID', baseUrl),
      redirectUri: env(
        'REMOTESTORAGE_REDIRECT_URI',
        `${baseUrl}/remotestorage/callback`,
      ),
    },
    openApiPath: sharedOpenApiPath,
    overlayDir: sharedOverlayDir,
    reflection: {
      enabled: reflectA.target !== '' && reflectB.target !== '',
      direction: reflectionDirection(),
      intervalMs: num('REFLECT_INTERVAL_MS', 60_000),
      a: reflectA,
      b: reflectB,
    },
    retry: {
      baseDelayMs: num('SYNC_RETRY_BASE_MS', 400),
      maxDelayMs: num('SYNC_RETRY_MAX_MS', 8000),
      maxAttempts: num('SYNC_RETRY_MAX_ATTEMPTS', 5),
    },
  };
}
