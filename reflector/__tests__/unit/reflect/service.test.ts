import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { ReflectionService } from '../../../src/reflect/service.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const githubDoc = resolve(repoRoot, 'spec/github-issues.openapi.yaml');
const githubOverlays = resolve(repoRoot, 'spec/overlays/github');

const KEYS = [
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

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

function enableGithubReflection(): void {
  process.env.OPENAPI_PATH_A = githubDoc;
  process.env.OPENAPI_PATH_B = githubDoc;
  process.env.OVERLAY_DIR_A = githubOverlays;
  process.env.OVERLAY_DIR_B = githubOverlays;
  process.env.REFLECT_A_REPO = 'octo/a';
  process.env.REFLECT_B_REPO = 'octo/b';
  process.env.REFLECT_A_TOKEN = 'tok-a';
  process.env.REFLECT_B_TOKEN = 'tok-b';
}

describe('ReflectionService.fromConfig', () => {
  it('returns undefined when reflection is not configured', async () => {
    expect(await ReflectionService.fromConfig(loadConfig())).toBeUndefined();
  });

  it('builds a service from the GitHub reflection config', async () => {
    enableGithubReflection();
    process.env.REFLECT_DIRECTION = 'a-to-b';
    process.env.REFLECT_INTERVAL_MS = '1234';

    const service = await ReflectionService.fromConfig(loadConfig());
    expect(service).toBeDefined();
    const status = service!.status();
    expect(status.enabled).toBe(true);
    expect(status.direction).toBe('a-to-b');
    expect(status.intervalMs).toBe(1234);
    expect(status.systems).toEqual(['octo/a', 'octo/b']);
    expect(status.lastRun).toBeUndefined();
  });

  it('rejects a target that is not in owner/repo form', async () => {
    enableGithubReflection();
    process.env.REFLECT_A_REPO = 'no-slash';
    await expect(
      ReflectionService.fromConfig(loadConfig()),
    ).rejects.toThrow(/owner\/repo/);
  });

  // Regression for localthought/reflector#31: a full repository URL (the
  // natural thing to paste from a browser address bar) used to be silently
  // mis-split on its first "/" — "https://github.com/owner/repo" became
  // { owner: "https:", repo: "/github.com/owner/repo" } — producing a
  // malformed GitHub API path that 404s deep inside a reflect pass instead of
  // failing clearly at startup.
  it('accepts a full repository URL as a reflection target', async () => {
    enableGithubReflection();
    process.env.REFLECT_A_REPO = 'https://github.com/octo/a';
    process.env.REFLECT_B_REPO = 'https://github.com/octo/b/issues';

    const service = await ReflectionService.fromConfig(loadConfig());
    expect(service).toBeDefined();
    // `systems` still reports the configured target verbatim (it's the
    // stable marker/id-map identity); only the derived {owner, repo} path
    // context is normalized.
    expect(service!.status().systems).toEqual([
      'https://github.com/octo/a',
      'https://github.com/octo/b/issues',
    ]);
  });

  it('rejects a URL with no owner/repo path segments', async () => {
    enableGithubReflection();
    process.env.REFLECT_A_REPO = 'https://github.com';
    await expect(
      ReflectionService.fromConfig(loadConfig()),
    ).rejects.toThrow(/owner\/repo/);
  });
});
