import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const ENV_KEYS = [
  'BASE_URL',
  'PORT',
  'HEROKU_APP_DEFAULT_DOMAIN_NAME',
  'OPENAPI_PATH',
  'OPENAPI_PATH_A',
  'OPENAPI_PATH_B',
  'OVERLAY_DIR_A',
  'OVERLAY_DIR_B',
  'REFLECT_A_REPO',
  'REFLECT_B_REPO',
  'REFLECT_A_TOKEN',
  'REFLECT_B_TOKEN',
  'REFLECT_DIRECTION',
  'REFLECT_INTERVAL_MS',
];
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe('loadConfig baseUrl', () => {
  it('uses BASE_URL when set', () => {
    process.env.BASE_URL = 'https://example.com';
    delete process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME;
    expect(loadConfig().baseUrl).toBe('https://example.com');
  });

  it('falls back to the Heroku default domain when BASE_URL is unset', () => {
    delete process.env.BASE_URL;
    process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME =
      'reflector-prod-8e1e64ecb238.herokuapp.com';
    expect(loadConfig().baseUrl).toBe(
      'https://reflector-prod-8e1e64ecb238.herokuapp.com',
    );
  });

  it('falls back to localhost when neither is set', () => {
    delete process.env.BASE_URL;
    delete process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME;
    process.env.PORT = '4321';
    expect(loadConfig().baseUrl).toBe('http://localhost:4321');
  });

  it('derives the OAuth redirect URI from the resolved baseUrl', () => {
    delete process.env.BASE_URL;
    process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME = 'example.herokuapp.com';
    expect(loadConfig().oauth.redirectUri).toBe(
      'https://example.herokuapp.com/auth/callback',
    );
  });

  it('strips a trailing slash from BASE_URL so callback URLs are not doubled', () => {
    process.env.BASE_URL = 'https://example.com/';
    delete process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME;
    const config = loadConfig();
    expect(config.baseUrl).toBe('https://example.com');
    expect(config.oauth.redirectUri).toBe('https://example.com/auth/callback');
  });
});

describe('loadConfig reflection', () => {
  it('is disabled by default and both endpoints fall back to the shared document', () => {
    for (const key of [
      'REFLECT_A_REPO',
      'REFLECT_B_REPO',
      'OPENAPI_PATH_A',
      'OPENAPI_PATH_B',
    ]) {
      delete process.env[key];
    }
    const { reflection, openApiPath } = loadConfig();
    expect(reflection.enabled).toBe(false);
    expect(reflection.direction).toBe('bidirectional');
    expect(reflection.intervalMs).toBe(60_000);
    // No per-endpoint document set → both fall back to the shared path.
    expect(reflection.a.openApiPath).toBe(openApiPath);
    expect(reflection.b.openApiPath).toBe(openApiPath);
  });

  it('enables the loop when both endpoints name a target and keeps A/B documents separate', () => {
    process.env.REFLECT_A_REPO = 'octo/source';
    process.env.REFLECT_B_REPO = 'octo/mirror';
    process.env.REFLECT_A_TOKEN = 'tok-a';
    process.env.REFLECT_B_TOKEN = 'tok-b';
    process.env.OPENAPI_PATH_A = '/specs/a.yaml';
    process.env.OPENAPI_PATH_B = '/specs/b.yaml';
    process.env.REFLECT_DIRECTION = 'a-to-b';
    process.env.REFLECT_INTERVAL_MS = '5000';
    const { reflection } = loadConfig();
    expect(reflection.enabled).toBe(true);
    expect(reflection.direction).toBe('a-to-b');
    expect(reflection.intervalMs).toBe(5000);
    expect(reflection.a.target).toBe('octo/source');
    expect(reflection.b.target).toBe('octo/mirror');
    expect(reflection.a.token).toBe('tok-a');
    expect(reflection.a.openApiPath).toBe('/specs/a.yaml');
    expect(reflection.b.openApiPath).toBe('/specs/b.yaml');
    expect(reflection.a.openApiPath).not.toBe(reflection.b.openApiPath);
  });
});
