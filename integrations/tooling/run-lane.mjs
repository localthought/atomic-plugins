/**
 * Run one plugin lane, with that lane's own ports. The same entry point CI
 * uses, so a failing lane's reproduction is one command:
 *
 *   node integrations/tooling/run-lane.mjs pets --tier e2e
 *   node integrations/tooling/run-lane.mjs timesheets          # all its tiers
 *
 * Needs the AGENTS.md layout: an atomic-server checkout at the pinned commit
 * with `browser` symlinked into this repo. Point ATOMIC_SERVER_CHECKOUT at it
 * (default /tmp/atomic-server) and build it once; every lane shares it. Or
 * skip the build: with ATOMIC_SERVER_IMAGE set, serve.mjs runs the published
 * ghcr.io/ontola/atomic-server-e2e:<pin> image in Docker instead.
 *
 * Every tier uses this lane's own derived ports, so any number of lanes can
 * run at once. The e2e tier used to be the exception — the catalog and proxy
 * URLs were compiled into the frontend by build.rs, so every e2e run had to
 * reuse one fixed port set behind a lock. atomic-server#1621 made both URLs
 * seedable through Playwright's `storageState` from PLUGIN_CATALOG_URL and
 * INTEGRATION_PROXY_URL, so one unmodified binary now serves any lane.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLanes, lanePorts, root, TIERS } from './lanes.mjs';
import { bringUp, mockProxyOrigin } from './serve.mjs';
import { layoutProblems } from './link-atomic-server.mjs';
import {
  installMissing,
  pluginDependencyDirs,
  sharedDependencyDirs,
} from './deps.mjs';

const config = loadLanes();
const args = process.argv.slice(2);
const laneId = args.find(a => !a.startsWith('--'));
const tierArg = args.includes('--tier')
  ? args[args.indexOf('--tier') + 1]
  : undefined;
const lane = config.lanes.find(l => l.id === laneId);

if (!lane) {
  console.error(
    `Usage: run-lane.mjs <lane> [--tier ${TIERS.join('|')}]\nLanes: ${config.lanes.map(l => l.id).join(', ')}`,
  );
  process.exit(1);
}

const tiers = tierArg ? [tierArg] : lane.tiers;

for (const tier of tiers)
  if (!TIERS.includes(tier)) {
    console.error(`Unknown tier: ${tier}`);
    process.exit(1);
  }

if (!tiers.length) {
  console.log(
    `Lane ${lane.id} declares no tiers${lane.note ? ` — ${lane.note}` : ''}`,
  );
  process.exit(0);
}

// Contract and native Node test tiers need no browser workspace.
if (tiers.some(tier => !['contract', 'node'].includes(tier))) {
  // Warn on an accidental stale pin while allowing deliberate host experiments.
  for (const problem of layoutProblems()) console.warn(`warning: ${problem}`);

  // Locally, this lane's own lockfiles (and a shared package its `paths`
  // import from source) may not be installed yet. CI installs them before this
  // script runs, so there every folder already has node_modules and nothing
  // happens (deps.mjs).
  try {
    installMissing([
      ...pluginDependencyDirs(lane.id),
      ...sharedDependencyDirs(lane.paths),
    ]);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * Two .bin directories, not one: tsc and vitest are devDependencies of the
 * `@tomic/root` workspace and land in browser/node_modules/.bin, while
 * @playwright/test belongs to the `@tomic/e2e` package and only ever appears
 * in browser/e2e/node_modules/.bin. pnpm does not hoist the latter.
 */
const bin = `${root}/browser/node_modules/.bin`;
const e2eBin = `${root}/browser/e2e/node_modules/.bin`;

/**
 * Bare `@playwright/test` / `@tomic/lib` imports in a lane's e2e spec resolve
 * by walking up from integrations/<lane>/e2e/, which reaches nothing without
 * this. Both are dependencies of the `@tomic/e2e` workspace package, so
 * pointing integrations/node_modules at browser/e2e/node_modules resolves
 * them the ordinary way — which matters, because `@playwright/test` is
 * CommonJS and a tsconfig `paths` mapping of it breaks the interop.
 */
function linkE2eModules() {
  const target = resolve(root, 'integrations/node_modules');
  if (existsSync(target)) return;

  try {
    symlinkSync('../browser/e2e/node_modules', target, 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function requireTool(path, hint) {
  if (!existsSync(path)) {
    // A stack trace here is noise: the cause is always the checkout layout.
    console.error(
      `${path} is missing — ${hint}.\nCheck the AGENTS.md layout: browser/ must be a symlink to the pinned atomic-server's browser/, with dependencies installed.`,
    );
    process.exit(1);
  }

  return path;
}

function run(command, commandArgs, env = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

  return result.status ?? 1;
}

let stop = () => {};
let lock;

const cleanup = () => {
  stop();

  if (lock !== undefined) {
    closeSync(lock);
    rmSync(lockPath, { force: true });
    lock = undefined;
  }
};

// Between tiers: stop this tier's stack and wait for it to be gone before
// the next tier starts one on the same store, but keep the lane lock —
// cleanup() releases that, and only process exit should.
const stopStack = async () => {
  const pending = stop;
  stop = () => {};
  await pending();
};

process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });
// Cheapest first, so a lane fails before paying for a server it won't reach.
const order = TIERS;

for (const tier of order.filter(t => tiers.includes(t))) {
  const ports = lanePorts(lane, config);
  console.log(`\n=== ${lane.id}: ${tier} ===`);
  let status = 0;

  if (tier === 'contract') {
    status = run(process.execPath, [
      'integrations/tooling/server-contract.mjs',
      lane.id,
    ]);
  } else if (tier === 'node') {
    // Require explicit existing files: a missing suite must not pass with zero tests.
    if (!lane.nodeTests?.length) {
      console.error(`${lane.id}: no nodeTests declared`);
      process.exit(1);
    }

    for (const file of lane.nodeTests) {
      if (!existsSync(resolve(root, file))) {
        console.error(`${lane.id}: missing test file ${file}`);
        process.exit(1);
      }
    }

    status = run(process.execPath, ['--test', ...lane.nodeTests]);
  } else if (tier === 'typecheck') {
    status = run(requireTool(`${bin}/tsc`, 'run pnpm install in browser/'), [
      '-p',
      `integrations/${lane.id}/tsconfig.json`,
    ]);
  } else if (tier === 'unit') {
    status = run(requireTool(`${bin}/vitest`, 'run pnpm install in browser/'), [
      'run',
      '--config',
      `integrations/${lane.id}/vitest.config.ts`,
    ]);
  } else if (tier === 'live') {
    stop = await bringUp({
      ports,
      platforms: lane.platforms,
      label: lane.id,
    });
    status = run(
      requireTool(`${bin}/vitest`, 'run pnpm install in browser/'),
      ['run', '--config', `integrations/${lane.id}/vitest.config.ts`],
      // Straight at atomic-server: @tomic/lib signs the URL it fetches, and
      // atomic-server verifies against the origin it answers under. Those
      // agree only when the client talks to it directly.
      { [lane.liveEnv]: `http://localhost:${ports.atomicServer}` },
    );
    await stopStack();
  } else if (tier === 'e2e') {
    linkE2eModules();
    stop = await bringUp({
      ports,
      platforms: lane.platforms,
      label: lane.id,
    });
    status = run(
      requireTool(`${e2eBin}/playwright`, 'run pnpm install in browser/'),
      [
        'test',
        '--config=integrations/tooling/playwright.config.ts',
        '--project=chromium',
        ...lane.e2e,
      ],
      {
        // The SPA and the API are one origin — atomic-server's own — which is
        // the topology its dagger e2e pipeline uses. Only the plugin catalog
        // comes from somewhere else, and since atomic-server#1621 that URL is
        // seeded at runtime instead of compiled in, so it no longer has to be
        // same-origin with the server.
        SERVER_URL: `http://localhost:${ports.atomicServer}`,
        FRONTEND_URL: `http://localhost:${ports.atomicServer}`,
        PLUGIN_CATALOG_URL: `http://localhost:${ports.devServer}/integrations/catalog.json`,
        INTEGRATION_PROXY_URL: mockProxyOrigin(ports),
        ATOMIC_MOCK_INTEGRATION_PROXY: '1',
      },
    );
    await stopStack();
  }

  if (status !== 0) {
    console.error(`\n${lane.id}: ${tier} failed`);
    process.exit(status);
  }
}

console.log(`\n${lane.id}: ${tiers.join(', ')} passed`);
