/**
 * Run one plugin lane, with that lane's own ports. The same entry point CI
 * uses, so a failing lane's reproduction is one command:
 *
 *   node integrations/tooling/run-lane.mjs pets --tier e2e
 *   node integrations/tooling/run-lane.mjs timesheets          # all its tiers
 *
 * Needs the AGENTS.md layout: an atomic-server checkout at the pinned commit
 * with `browser` symlinked into this repo. Point ATOMIC_SERVER_CHECKOUT at it
 * (default /tmp/atomic-server) and build it once; every lane shares it.
 *
 * The typecheck/unit/live tiers read their URLs from env, so any number of
 * lanes can run at once locally. The e2e tier cannot: its two URLs are
 * compiled into the shared build's frontend, so it uses lanes.json's
 * canonicalPorts and takes an exclusive lock. In CI that lock is never
 * contended — each matrix job is its own runner.
 * integrations/HANDOFF-runtime-urls.md is the task that removes all of this.
 */
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLanes, portsForTier, root, TIERS } from './lanes.mjs';
import { bringUp } from './serve.mjs';

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

/**
 * Two .bin directories, not one: tsc and vitest are devDependencies of the
 * `@tomic/root` workspace and land in browser/node_modules/.bin, while
 * @playwright/test belongs to the `@tomic/e2e` package and only ever appears
 * in browser/e2e/node_modules/.bin. pnpm does not hoist the latter.
 */
const bin = `${root}/browser/node_modules/.bin`;
const e2eBin = `${root}/browser/e2e/node_modules/.bin`;

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

/**
 * Serialize the e2e tier across worktrees: every e2e run must bind
 * canonicalPorts, so only one can exist on a machine. Advisory, and it goes
 * away with the canonicalPorts block itself.
 */
const lockPath = resolve(root, 'integrations/.e2e.lock');

function takeE2eLock() {
  try {
    return openSync(lockPath, 'wx');
  } catch {
    throw new Error(
      `another e2e run holds ${lockPath}. The e2e tier binds the shared build's fixed ports, so only one can run at a time — wait for it, or delete that file if it is stale.`,
    );
  }
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

process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    cleanup();
    process.exit(1);
  });

// Cheapest first, so a lane fails before paying for a server it won't reach.
const order = ['typecheck', 'unit', 'live', 'e2e'];

for (const tier of order.filter(t => tiers.includes(t))) {
  const ports = portsForTier(lane, config, tier);
  console.log(`\n=== ${lane.id}: ${tier} ===`);
  let status = 0;

  if (tier === 'typecheck') {
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
      { [lane.liveEnv]: `http://localhost:${ports.devServer}` },
    );
    cleanup();
  } else if (tier === 'e2e') {
    lock = takeE2eLock();
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
        SERVER_URL: `http://localhost:${ports.devServer}`,
        FRONTEND_URL: `http://localhost:${ports.devServer}`,
        ATOMIC_MOCK_INTEGRATION_PROXY: '1',
      },
    );
    cleanup();
  }

  if (status !== 0) {
    console.error(`\n${lane.id}: ${tier} failed`);
    process.exit(status);
  }
}

console.log(`\n${lane.id}: ${tiers.join(', ')} passed`);
