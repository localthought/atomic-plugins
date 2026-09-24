/**
 * Per-folder npm dependencies, installed on demand for local runs.
 *
 * A plugin that bundles published npm packages pins them in its own
 * package.json and pnpm-lock.yaml (integrations/notion/, integrations/pets/,
 * integrations/issue-tracker/app/, …), and a lane that declares shared
 * `paths` in lanes.json imports that package from source (devonian/). CI
 * installs every one of those lockfiles before certify.mjs and run-lane.mjs
 * run ("Install plugin npm dependencies" in .github/workflows/ci.yml). A
 * local checkout usually has not, and the resulting failure — a vitest or
 * tsc "Cannot find module" — does not say what is missing.
 *
 * installMissing() runs `pnpm install --frozen-lockfile` in each given folder
 * that has a pnpm-lock.yaml and no node_modules, printing one line per
 * install. A folder that already has node_modules is left alone, so on CI,
 * where the install step ran first, this does nothing: CI behaviour is
 * unchanged. It never updates a lockfile (`--frozen-lockfile`), and it does
 * not notice a node_modules that is present but stale — run
 * `pnpm install --frozen-lockfile` in that folder by hand.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './lanes.mjs';

/**
 * The folders, relative to `base`, that hold one plugin's own lockfiles: the
 * plugin folder itself and its drive app, the same two globs CI installs
 * (`integrations/*\/pnpm-lock.yaml`, `integrations/*\/app/pnpm-lock.yaml`).
 */
export const pluginDependencyDirs = id => [
  `integrations/${id}`,
  `integrations/${id}/app`,
];

/**
 * The shared packages (devonian/, syncables/, reflector/) a lane's `paths`
 * point into, e.g. `devonian/src/**` → `devonian`.
 */
export const sharedDependencyDirs = (paths = []) => [
  ...new Set(paths.map(path => path.split('/')[0])),
];

/** Those of `dirs` that have a pnpm-lock.yaml but no node_modules yet. */
export function missingInstalls(dirs, base = root) {
  return [...new Set(dirs)].filter(
    dir =>
      existsSync(resolve(base, dir, 'pnpm-lock.yaml')) &&
      !existsSync(resolve(base, dir, 'node_modules')),
  );
}

function pnpmInstall(cwd) {
  return spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Install each of `dirs` that needs it. Returns the folders it installed.
 * Throws on the first failed install, with pnpm's output in the message.
 */
export function installMissing(
  dirs,
  { base = root, install = pnpmInstall, log = console.log } = {},
) {
  const installed = [];

  for (const dir of missingInstalls(dirs, base)) {
    log(`Installing ${dir} dependencies (pnpm install --frozen-lockfile)`);
    const result = install(resolve(base, dir));

    if (result.error || result.status !== 0) {
      const output = [result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();

      throw new Error(
        `pnpm install --frozen-lockfile failed in ${dir}${output ? `:\n${output}` : ''}`,
      );
    }

    installed.push(dir);
  }

  return installed;
}
