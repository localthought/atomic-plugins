/**
 * Bring up the three processes every server-dependent test tier needs:
 * atomic-server, the mock integration proxy, and the dev-server that fronts
 * both with this repo's plugin catalog.
 *
 * Used by run-lane.mjs (per-lane ports) and by the CI jobs that are not a
 * plugin lane — the hosting-surface check and the generic plugin-system e2e
 * suite — which use lanes.json's reserved sharedIndex block. As a CLI it starts
 * the stack on those ports and stays in the foreground:
 *
 *   node integrations/tooling/serve.mjs            # the shared block
 *   node integrations/tooling/serve.mjs --lane pets
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLanes, lanePorts, sharedPorts, root } from './lanes.mjs';

export const serverCheckout = () =>
  process.env.ATOMIC_SERVER_CHECKOUT ?? '/tmp/atomic-server';

const free = port =>
  new Promise(done => {
    const probe = createServer()
      .once('error', () => done(false))
      .once('listening', () => probe.close(() => done(true)))
      .listen(port, '127.0.0.1');
  });

/**
 * Name a busy port's owner rather than surfacing EADDRINUSE from whichever
 * process loses the race — a clash between worktrees is the failure mode the
 * port scheme exists to make legible.
 */
export function portOwner(port, config) {
  for (const lane of config.lanes)
    for (const [role, p] of Object.entries(lanePorts(lane, config)))
      if (p === port) return `lane ${lane.id} (${role})`;

  return 'an unknown process';
}

/**
 * Wait for a port block to come free rather than failing the instant it is
 * busy. atomic-server shuts down *gracefully* on SIGTERM (it finishes open
 * connections, ~1-2s), so a lane running two server-backed tiers in a row —
 * notion's live then e2e — tore the first stack down and immediately failed
 * `assertFree` on its own still-closing listener.
 */
async function waitUntilFree(ports, seconds = 20) {
  for (let i = 0; i < seconds * 4; i++) {
    const busy = [];
    for (const [role, port] of Object.entries(ports))
      if (!(await free(port))) busy.push(role);
    if (!busy.length) return;
    await new Promise(r => setTimeout(r, 250));
  }
}

export async function assertFree(ports, config) {
  await waitUntilFree(ports);
  for (const [role, port] of Object.entries(ports))
    if (!(await free(port)))
      throw new Error(
        `port ${port} (${role}) is already bound — it belongs to ${portOwner(port, config)}. Stop that run, or pick a different lane.`,
      );
}

async function waitFor(url, what) {
  for (let i = 0; i < 90; i++) {
    try {
      await fetch(url);

      return;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  throw new Error(`${what} did not become ready at ${url}`);
}

/**
 * Start the stack on `ports`. Returns a `stop()` that kills all of it and
 * resolves once every process has exited.
 * `platforms` is the mock proxy's fixture set, passed as
 * MOCK_PROXY_PLATFORMS: the mock serves only those of them that have a
 * fixture registered in integrations/localthought/fixtures/index.mjs. Omitted (the shared,
 * non-lane stack) serves every fixture; an empty list — a lane whose tests
 * never touch the shared mock — does not start the mock at all. See §4 of
 * integrations/PARALLEL_LANES.md.
 */
export async function bringUp({ ports, platforms, label = 'shared' }) {
  const config = loadLanes();
  const binary = resolve(serverCheckout(), 'target/e2e/atomic-server');
  // Checked up front: spawn's ENOENT surfaces asynchronously, so without this
  // the caller waits out the full readiness timeout before seeing the cause.
  if (!existsSync(binary))
    throw new Error(
      `${binary} does not exist. Build it first:\n  cd ${serverCheckout()} && cargo build --profile e2e -p atomic-server --no-default-features --features wasm-plugins\nOr point ATOMIC_SERVER_CHECKOUT at a checkout that already has one.`,
    );
  await assertFree(ports, config);

  const children = [];

  const start = (name, command, args, env) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', code => {
      if (code) console.error(`${name} exited with ${code}`);
    });
    children.push(child);
  };

  const store = resolve(serverCheckout(), `.lane-store/${label}`);
  start(
    'atomic-server',
    resolve(serverCheckout(), 'target/e2e/atomic-server'),
    [],
    {
      ATOMIC_DATA_DIR: `${store}/data`,
      ATOMIC_CONFIG_DIR: `${store}/config`,
      ATOMIC_CACHE_DIR: `${store}/cache`,
      ATOMIC_PORT: String(ports.atomicServer),
      ATOMIC_DOMAIN: 'localhost',
      ATOMIC_REPOPULATE_DEFAULTS: 'true',
      // Mirrors what atomic-server's own dagger e2e pipeline sets for parity;
      // nothing in server/src reads these today, so they are a no-op kept only
      // so this matches upstream if a future commit does.
      ATOMIC_INTEGRATION_PROXY_URL: `http://127.0.0.1:${ports.mockProxy}`,
      ATOMIC_INTEGRATION_FRONTEND_ORIGIN: `http://localhost:${ports.atomicServer}`,
      TENANT_SECRET: 'bW9jay10ZW5hbnQ.mock-signature',
    },
  );
  // MOCK_FRONTEND_ORIGIN must match wherever the browser actually loads the
  // SPA from — atomic-server directly (FRONTEND_URL in run-lane.mjs and
  // ci.yml), not the dev-server, which only hosts the catalog. The mock proxy
  // rejects any /connect whose redirect_uri has another origin.
  const mock = platforms === undefined || platforms.length > 0;
  if (mock)
    start(
      'mock-proxy',
      process.execPath,
      ['integrations/localthought/mock-proxy.mjs'],
      {
        MOCK_PROXY_PORT: String(ports.mockProxy),
        MOCK_FRONTEND_ORIGIN: `http://localhost:${ports.atomicServer}`,
        MOCK_PROXY_PLATFORMS: (platforms ?? []).join(','),
      },
    );
  start(
    'dev-server',
    process.execPath,
    ['integrations/tooling/dev-server.mjs'],
    {
      DEV_SERVER_PORT: String(ports.devServer),
    },
  );

  await waitFor(`http://localhost:${ports.atomicServer}`, 'atomic-server');
  if (mock)
    await waitFor(`http://127.0.0.1:${ports.mockProxy}/catalog`, 'mock proxy');
  await waitFor(
    `http://localhost:${ports.devServer}/integrations/catalog.json`,
    'dev-server',
  );

  // Resolves once every child has exited, not merely been signalled: the
  // next bringUp on the same label reuses the same store, and atomic-server
  // holds an exclusive lock on it (`Database already open. Cannot acquire
  // lock`) until its process is gone. SIGKILL after 10s so a hung child
  // cannot stall the lane. Callers that cannot wait (a process 'exit'
  // handler) may ignore the promise; the signals are sent synchronously.
  return () => {
    const running = children.filter(
      child => child.exitCode === null && child.signalCode === null,
    );
    const exited = running.map(
      child => new Promise(done => child.once('exit', done)),
    );
    for (const child of running) child.kill();
    const force = setTimeout(() => {
      for (const child of running) child.kill('SIGKILL');
    }, 10_000);
    force.unref();

    return Promise.all(exited).then(() => clearTimeout(force));
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const config = loadLanes();
  const laneId = process.argv.includes('--lane')
    ? process.argv[process.argv.indexOf('--lane') + 1]
    : undefined;
  const lane = laneId && config.lanes.find(l => l.id === laneId);

  if (laneId && !lane) {
    console.error(`Unknown lane: ${laneId}`);
    process.exit(1);
  }

  const ports = lane ? lanePorts(lane, config) : sharedPorts(config);
  const stop = await bringUp({
    ports,
    platforms: lane?.platforms,
    label: lane?.id ?? 'shared',
  });
  console.log(`serving ${JSON.stringify(ports)} — ctrl-c to stop`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
}
