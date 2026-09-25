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
 *
 * atomic-server comes from one of two places:
 *
 *   - by default, the binary at $ATOMIC_SERVER_CHECKOUT/target/e2e/atomic-server,
 *     built from source (AGENTS.md, "Shared pinned atomic-server build");
 *   - with ATOMIC_SERVER_IMAGE set (e.g.
 *     `ghcr.io/ontola/atomic-server-e2e:$(cat .atomic-server-ref)`), that
 *     image, run with `docker run` on the same port. Everything else is
 *     unchanged: the mock proxy and the dev-server still run on the host, and
 *     the lane's tests still reach atomic-server at http://localhost:<port>.
 *     No local cargo build is needed, which also makes this the only way to
 *     run the published linux image on a Mac. The store is a named Docker
 *     volume per label rather than <checkout>/.lane-store/<label>. Like that
 *     directory, it persists across tiers and runs.
 *
 * A lane that declares `pluginRoutes` in lanes.json (see server-build.mjs)
 * gets a different binary: one built with the `plugin-routes` feature,
 * started with `--plugin-routes <level>` and `--routes-origin
 * http://routes.localhost:<port>`. It comes from, first match wins:
 *
 *   - ATOMIC_SERVER_ROUTES_BINARY (CI sets it);
 *   - an image: ATOMIC_SERVER_ROUTES_IMAGE, or, with ATOMIC_SERVER_IMAGE
 *     set, its `:<sha>-plugin-routes` variant (routesImageFor), which the e2e
 *     image workflow publishes for every SHA that has the feature. The flags
 *     go to the container as its arguments. If that image can't be pulled or
 *     lacks the feature, the lane falls back to:
 *   - the local source build (server-build.mjs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadLanes,
  lanePorts,
  pluginRoutesLevels,
  sharedPorts,
  root,
} from './lanes.mjs';

export const serverCheckout = () =>
  process.env.ATOMIC_SERVER_CHECKOUT ?? '/tmp/atomic-server';

/** The image to run atomic-server from instead of a local binary, if any. */
export const serverImage = () => process.env.ATOMIC_SERVER_IMAGE || undefined;

/**
 * atomic-server's environment for one stack. `store` is a directory the server
 * owns: <checkout>/.lane-store/<label> for the binary, the volume's mount
 * point for the image.
 */
export function serverEnv(ports, store) {
  return {
    ATOMIC_DATA_DIR: `${store}/data`,
    ATOMIC_CONFIG_DIR: `${store}/config`,
    ATOMIC_CACHE_DIR: `${store}/cache`,
    ATOMIC_PORT: String(ports.atomicServer),
    ATOMIC_DOMAIN: 'localhost',
    ATOMIC_REPOPULATE_DEFAULTS: 'true',
    // `--integration-proxy-url` (atomic-server#1702): the proxy origin whose
    // `ctx.http` requests the host signs with the installation's node agent,
    // and the one loopback origin let through the public-address check. It
    // must equal the mock's MOCK_PROXY_BASE_URL, which every signature
    // covers. No plugin in this repo reaches the proxy with `ctx.http` yet
    // (README, "Sandbox plugins and the proxy"), so no lane exercises it.
    // In a container (ATOMIC_SERVER_IMAGE), 127.0.0.1 is the container
    // itself; revisit when a lane needs server-side proxy calls.
    ATOMIC_INTEGRATION_PROXY_URL: mockProxyOrigin(ports),
    // Mirrors atomic-server's own dagger e2e pipeline; nothing in server/src
    // reads it today.
    ATOMIC_INTEGRATION_FRONTEND_ORIGIN: `http://localhost:${ports.atomicServer}`,
  };
}

/**
 * The origin plugin routes would be served under (`--routes-origin`): a
 * `*.localhost` name, which atomic-server#1726 accepts over plain http when
 * the API is on localhost, on the lane's own atomic-server port. It must not
 * overlap the API or a website origin; `routes.localhost` overlaps neither.
 * No host serves routes there yet (AS-04), so nothing listens on it.
 */
export const routesOrigin = ports =>
  `http://routes.localhost:${ports.atomicServer}`;

/** atomic-server's arguments for a lane at one `--plugin-routes` level. */
export const pluginRoutesArgs = (level, ports) =>
  level === undefined
    ? []
    : ['--plugin-routes', level, '--routes-origin', routesOrigin(ports)];

/**
 * The plugin-routes options atomic-server reads from its environment. A build
 * without the feature refuses to start when any is set, so a stray one in the
 * caller's shell never reaches a lane's server: the level comes from
 * lanes.json only.
 */
export const PLUGIN_ROUTES_ENV = [
  'ATOMIC_PLUGIN_ROUTES',
  'ATOMIC_ROUTES_ORIGIN',
  'ATOMIC_PLUGIN_LISTENERS',
  'ATOMIC_PLUGIN_SIDECARS',
];

const withoutPluginRoutesEnv = env =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) => !PLUGIN_ROUTES_ENV.includes(key)),
  );

/**
 * The mock proxy's public origin (its BASE_URL): what the browser is told
 * (INTEGRATION_PROXY_URL in run-lane.mjs), what the server is told, and what
 * every v2 signature and capability `aud` must name, byte for byte.
 */
export const mockProxyOrigin = ports => `http://127.0.0.1:${ports.mockProxy}`;

/** Where the image keeps its store (the Dockerfile's VOLUME). */
export const IMAGE_STORE = '/data';

/**
 * `docker run` arguments for one atomic-server container.
 *
 * - The port is published on 127.0.0.1 only, at the same number inside and
 *   out. atomic-server derives its own origin from ATOMIC_DOMAIN and
 *   ATOMIC_PORT, and @tomic/lib's request signatures only verify when that
 *   origin is the one the client used.
 * - `--init` makes SIGTERM from stop() reach atomic-server, which isn't
 *   PID 1 then, so it shuts down (and releases its store lock) the same way
 *   the local binary does. `docker run` forwards the signal from its own
 *   process to the container.
 * - The name is unique per start: a container left behind after a SIGKILL
 *   can't block the next one by name. It can't hold the port either, because
 *   assertFree() would name the clash before anything starts.
 */
export function dockerRunArgs({
  image,
  name,
  ports,
  label,
  env,
  command = [],
}) {
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    name,
    '--label',
    `atomic-plugins.lane-store=${label}`,
    '--publish',
    `127.0.0.1:${ports.atomicServer}:${ports.atomicServer}`,
    '--volume',
    `${storeVolume(label)}:${IMAGE_STORE}`,
  ];

  for (const [key, value] of Object.entries(env))
    args.push('--env', `${key}=${value}`);

  // Arguments after the image go to its entrypoint, atomic-server.
  args.push(image, ...command);

  return args;
}

// Not link-atomic-server.mjs's pinnedRef(): that module imports this one.
const readPin = () =>
  readFileSync(resolve(root, '.atomic-server-ref'), 'utf8').trim();

/** The named volume that holds one label's store when running the image. */
export const storeVolume = label => `atomic-plugins-lane-store-${label}`;

/**
 * A warning for an image tagged with a different atomic-server commit than
 * .atomic-server-ref pins, or undefined. Like run-lane.mjs's layout check,
 * testing another commit on purpose is legitimate. Doing it by accident
 * shouldn't go unnoticed.
 */
export function imagePinProblem(image, pinned) {
  const tag = /:([0-9a-f]{40})(?:-plugin-routes)?$/.exec(image)?.[1];
  if (tag === undefined || tag === pinned) return undefined;

  return `${image} is atomic-server ${tag}, but .atomic-server-ref pins ${pinned}`;
}

/**
 * The plugin-routes image for a lane that declares `pluginRoutes`, or
 * undefined: ATOMIC_SERVER_ROUTES_IMAGE, else the `-plugin-routes` variant of
 * ATOMIC_SERVER_IMAGE's tag. A tag that isn't a full SHA (`latest-pin`) has
 * no variant, so the pinned SHA's is used.
 */
export function routesImageFor(env, pinned) {
  if (env.ATOMIC_SERVER_ROUTES_IMAGE) return env.ATOMIC_SERVER_ROUTES_IMAGE;
  const image = env.ATOMIC_SERVER_IMAGE;
  if (!image) return undefined;
  const match = /^(.+?):([^:/]+)$/.exec(image);
  const repository = match ? match[1] : image;
  const tag = match?.[2];
  const sha = tag && /^[0-9a-f]{40}$/.test(tag) ? tag : pinned;

  return `${repository}:${sha}-plugin-routes`;
}

/**
 * Makes sure `image` is local, pulling it in the foreground: a first pull (a
 * few hundred MB) would otherwise eat the readiness timeout. Throws with the
 * cause when it can't.
 */
function pullImage(image) {
  if (
    spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
      .status === 0
  )
    return;
  const pull = spawnSync('docker', ['pull', image], { stdio: 'inherit' });

  if (pull.error || pull.status !== 0)
    throw new Error(
      `could not pull ${image}${pull.error ? ` (${pull.error.message})` : ''}. Is Docker running, and does a tag exist for this commit? See AGENTS.md, "Shared pinned atomic-server build".`,
    );
}

/** The features an image says it was built with (the Dockerfile's label). */
function imageFeatures(image) {
  const r = spawnSync(
    'docker',
    [
      'image',
      'inspect',
      '--format',
      '{{ index .Config.Labels "dev.atomicdata.atomic-server.features" }}',
      image,
    ],
    { encoding: 'utf8' },
  );

  return r.status === 0 ? r.stdout.trim().split(',') : [];
}

/**
 * The plugin-routes image if it is usable here, else undefined after saying
 * why, so the caller falls back to the source build.
 */
function usableRoutesImage(image) {
  try {
    pullImage(image);
  } catch (error) {
    console.warn(`warning: ${error.message} Falling back to the local build.`);

    return undefined;
  }

  if (!imageFeatures(image).includes('plugin-routes')) {
    console.warn(
      `warning: ${image} was not built with the plugin-routes feature. Falling back to the local build.`,
    );

    return undefined;
  }

  return image;
}

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
export async function bringUp({
  ports,
  platforms,
  label = 'shared',
  pluginRoutes,
}) {
  const config = loadLanes();
  let image = serverImage();
  let binary = resolve(serverCheckout(), 'target/e2e/atomic-server');

  if (pluginRoutes !== undefined) {
    // The default image can't open the gates; its variant can.
    const routesImage = process.env.ATOMIC_SERVER_ROUTES_BINARY
      ? undefined
      : routesImageFor(process.env, readPin());
    image = routesImage && usableRoutesImage(routesImage);

    if (image) {
      const problem = imagePinProblem(image, readPin());
      if (problem) console.warn(`warning: ${problem}`);
    } else {
      // Loaded only here, so a lane on the default build (and anything that
      // copies serve.mjs without it) never needs server-build.mjs.
      const { ensureRoutesBinary } = await import('./server-build.mjs');
      binary = await ensureRoutesBinary({
        checkout: serverCheckout(),
        pin: readPin(),
      });
    }
  } else if (image) {
    const problem = imagePinProblem(image, readPin());
    if (problem) console.warn(`warning: ${problem}`);
    pullImage(image);
  } else if (!existsSync(binary)) {
    // Checked up front: spawn's ENOENT surfaces asynchronously, so without this
    // the caller waits out the full readiness timeout before seeing the cause.
    throw new Error(
      `${binary} does not exist. Build it first:\n  cd ${serverCheckout()} && cargo build --profile e2e -p atomic-server --no-default-features --features wasm-plugins\nOr point ATOMIC_SERVER_CHECKOUT at a checkout that already has one, or set ATOMIC_SERVER_IMAGE to run the published image instead.`,
    );
  }

  await assertFree(ports, config);

  const children = [];

  const start = (name, command, args, env) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...withoutPluginRoutesEnv(process.env), ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', code => {
      if (code) console.error(`${name} exited with ${code}`);
    });
    children.push(child);
  };

  let container;

  if (image) {
    container = `atomic-plugins-${label}-${ports.atomicServer}-${process.pid}-${Date.now()}`;
    start(
      'atomic-server',
      'docker',
      dockerRunArgs({
        image,
        name: container,
        ports,
        label,
        env: serverEnv(ports, IMAGE_STORE),
        command: pluginRoutesArgs(pluginRoutes, ports),
      }),
    );
  } else {
    start(
      'atomic-server',
      binary,
      pluginRoutesArgs(pluginRoutes, ports),
      serverEnv(ports, resolve(serverCheckout(), `.lane-store/${label}`)),
    );
  }

  // MOCK_FRONTEND_ORIGIN must match wherever the browser actually loads the
  // SPA from — atomic-server directly (FRONTEND_URL in run-lane.mjs and
  // ci.yml), not the dev-server, which only hosts the catalog. The mock proxy
  // rejects any /connect whose redirect_uri has another origin.
  // MOCK_PROXY_BASE_URL is the origin clients sign for (mockProxyOrigin).
  const mock = platforms === undefined || platforms.length > 0;
  if (mock)
    start(
      'mock-proxy',
      process.execPath,
      ['integrations/localthought/mock-proxy.mjs'],
      {
        MOCK_PROXY_PORT: String(ports.mockProxy),
        MOCK_PROXY_BASE_URL: mockProxyOrigin(ports),
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
      // Serve every drive app entry enabled, so an e2e can install an app
      // the published catalog still keeps disabled until its launch
      // (dev-server.mjs enableAppEntries).
      DEV_SERVER_ENABLE_APPS: process.env.DEV_SERVER_ENABLE_APPS ?? 'all',
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
      // Killing the `docker run` client doesn't stop its container.
      if (container)
        spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
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
  // A lane with several levels starts at its first; --plugin-routes picks.
  const pluginRoutes = process.argv.includes('--plugin-routes')
    ? process.argv[process.argv.indexOf('--plugin-routes') + 1]
    : lane && pluginRoutesLevels(lane)[0];
  const stop = await bringUp({
    ports,
    platforms: lane?.platforms,
    label: lane?.id ?? 'shared',
    pluginRoutes,
  });
  console.log(`serving ${JSON.stringify(ports)} — ctrl-c to stop`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
}
