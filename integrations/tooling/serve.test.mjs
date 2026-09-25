/**
 * serve.mjs's ATOMIC_SERVER_IMAGE mode: atomic-server from the published e2e
 * image (`docker run`) instead of a local binary.
 *
 * The bringUp() cases put a fake `docker` first on PATH. It records its argv
 * and, for `run`, answers HTTP on the ATOMIC_PORT it was given, so they
 * exercise the real process wiring (pull, run, readiness, stop) without
 * Docker or an image. That the real image starts and serves a lane is
 * checked by hand. AGENTS.md has the command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  bringUp,
  dockerRunArgs,
  IMAGE_STORE,
  imagePinProblem,
  pluginRoutesArgs,
  PLUGIN_ROUTES_ENV,
  routesImageFor,
  routesOrigin,
  serverEnv,
  storeVolume,
} from './serve.mjs';
import { root } from './lanes.mjs';

const ports = { atomicServer: 41001, mockProxy: 41002, devServer: 41003 };
const pin = 'a'.repeat(40);
// The bringUp cases use the real pin, so they don't print the mismatch warning.
const pinnedImage = `ghcr.io/ontola/atomic-server-e2e:${readFileSync(
  join(root, '.atomic-server-ref'),
  'utf8',
).trim()}`;

test('dockerRunArgs publishes the lane port on loopback, same number inside and out', () => {
  const args = dockerRunArgs({
    image: 'ghcr.io/ontola/atomic-server-e2e:abc',
    name: 'atomic-plugins-pets-1',
    ports,
    label: 'pets',
    env: serverEnv(ports, IMAGE_STORE),
  });

  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'), 'containers must not pile up');
  assert.ok(args.includes('--init'), 'SIGTERM has to reach atomic-server');
  assert.equal(args[args.indexOf('--publish') + 1], '127.0.0.1:41001:41001');
  assert.equal(
    args[args.indexOf('--volume') + 1],
    `${storeVolume('pets')}:/data`,
  );
  assert.equal(args[args.indexOf('--name') + 1], 'atomic-plugins-pets-1');
  assert.equal(args.at(-1), 'ghcr.io/ontola/atomic-server-e2e:abc');

  const env = args.filter((_, i) => args[i - 1] === '--env');
  assert.ok(env.includes('ATOMIC_PORT=41001'));
  assert.ok(env.includes('ATOMIC_DATA_DIR=/data/data'));
  assert.ok(env.includes('ATOMIC_DOMAIN=localhost'));
});

test('serverEnv is the same for the binary and the image, apart from the store', () => {
  const binary = serverEnv(ports, '/checkout/.lane-store/pets');
  const image = serverEnv(ports, IMAGE_STORE);
  assert.deepEqual(Object.keys(binary), Object.keys(image));

  for (const key of Object.keys(binary))
    if (!/_DIR$/.test(key)) assert.equal(binary[key], image[key], key);
  assert.equal(binary.ATOMIC_CACHE_DIR, '/checkout/.lane-store/pets/cache');
});

test('each label gets its own store volume', () => {
  assert.notEqual(storeVolume('pets'), storeVolume('notion'));
});

test('imagePinProblem flags only a full-SHA tag that differs from the pin', () => {
  const image = 'ghcr.io/ontola/atomic-server-e2e';
  assert.equal(imagePinProblem(`${image}:${pin}`, pin), undefined);
  assert.equal(imagePinProblem(`${image}:latest-pin`, pin), undefined);
  assert.match(
    imagePinProblem(`${image}:${'b'.repeat(40)}`, pin),
    /pins a{40}/,
  );
});

const freePort = () =>
  new Promise(done => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args.includes('--format')) {
  process.stdout.write((process.env.FAKE_DOCKER_FEATURES ?? 'wasm-plugins') + '\\n');
  process.exit(0);
}
if (args[0] === 'image') process.exit(process.env.FAKE_DOCKER_HAS_IMAGE === '1' ? 0 : 1);
if (args[0] === 'pull') process.exit(process.env.FAKE_DOCKER_PULL_FAILS === '1' ? 1 : 0);
if (args[0] !== 'run') process.exit(0);
const port = Number(args.find(a => a.startsWith('ATOMIC_PORT=')).split('=')[1]);
const server = http.createServer((_, res) => res.end('fake atomic-server')).listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

async function withFakeDocker(env, run) {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-fake-docker-'));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER);
  chmodSync(join(dir, 'docker'), 0o755);
  const saved = { ...process.env };
  Object.assign(process.env, env, {
    PATH: `${dir}${delimiter}${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
  });

  try {
    await run(() =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)),
    );
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bringUp pulls a missing image, runs it, waits for it, and stops it', async () => {
  const image = pinnedImage;
  await withFakeDocker({ ATOMIC_SERVER_IMAGE: image }, async calls => {
    const live = {
      atomicServer: await freePort(),
      mockProxy: await freePort(),
      devServer: await freePort(),
    };
    // No platforms: the mock proxy isn't started, which this doesn't test.
    const stop = await bringUp({ ports: live, platforms: [], label: 'test' });

    try {
      const body = await (
        await fetch(`http://localhost:${live.atomicServer}/`)
      ).text();
      assert.equal(body, 'fake atomic-server');
    } finally {
      await stop();
    }

    const log = calls();
    assert.deepEqual(log[0], ['image', 'inspect', image]);
    assert.deepEqual(log[1], ['pull', image]);
    const run = log.find(args => args[0] === 'run');
    assert.ok(run, 'docker run was not called');
    assert.equal(run.at(-1), image);
    assert.equal(
      run[run.indexOf('--publish') + 1],
      `127.0.0.1:${live.atomicServer}:${live.atomicServer}`,
    );
  });
});

test('bringUp does not pull an image that is already present', async () => {
  const image = pinnedImage;
  await withFakeDocker(
    { ATOMIC_SERVER_IMAGE: image, FAKE_DOCKER_HAS_IMAGE: '1' },
    async calls => {
      const live = {
        atomicServer: await freePort(),
        mockProxy: await freePort(),
        devServer: await freePort(),
      };
      const stop = await bringUp({ ports: live, platforms: [], label: 'test' });
      await stop();
      assert.ok(!calls().some(args => args[0] === 'pull'));
    },
  );
});

test('bringUp explains a failed pull instead of timing out', async () => {
  await withFakeDocker(
    {
      ATOMIC_SERVER_IMAGE: 'ghcr.io/ontola/atomic-server-e2e:missing',
      FAKE_DOCKER_PULL_FAILS: '1',
    },
    async calls => {
      await assert.rejects(
        bringUp({ ports, platforms: [], label: 'test' }),
        /could not pull ghcr\.io\/ontola\/atomic-server-e2e:missing/,
      );
      assert.ok(!calls().some(args => args[0] === 'run'));
    },
  );
});

test('a plugin-routes level becomes flags, with a routes origin apart from the API', () => {
  assert.deepEqual(pluginRoutesArgs(undefined, ports), []);
  assert.deepEqual(pluginRoutesArgs('off', ports), [
    '--plugin-routes',
    'off',
    '--routes-origin',
    'http://routes.localhost:41001',
  ]);
  assert.equal(routesOrigin(ports), 'http://routes.localhost:41001');
  // atomic-server#1726 refuses http unless the host is *.localhost, and any
  // origin that is the API's own host.
  const origin = new URL(routesOrigin(ports));
  assert.ok(origin.hostname.endsWith('.localhost'));
  assert.notEqual(origin.hostname, 'localhost');
});

const FAKE_SERVER = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const http = require('node:http');
writeFileSync(process.env.FAKE_SERVER_LOG, JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^ATOMIC_(PLUGIN|ROUTES)/.test(k))),
}));
const server = http.createServer((_, res) => res.end('fake plugin-routes server')).listen(Number(process.env.ATOMIC_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

test('a plugin-routes lane runs the feature binary with its level, never the image or a stray env var', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-fake-routes-'));
  const binary = join(dir, 'atomic-server');
  const log = join(dir, 'server.json');
  writeFileSync(binary, FAKE_SERVER);
  chmodSync(binary, 0o755);
  const saved = { ...process.env };
  Object.assign(process.env, {
    ATOMIC_SERVER_ROUTES_BINARY: binary,
    FAKE_SERVER_LOG: log,
    // Both must be ignored: the image is the default build, and the level
    // comes from lanes.json only.
    ATOMIC_SERVER_IMAGE: pinnedImage,
    ATOMIC_PLUGIN_ROUTES: 'read-write',
    ATOMIC_PLUGIN_SIDECARS: 'pds=http://127.0.0.1:1',
  });

  try {
    const live = {
      atomicServer: await freePort(),
      mockProxy: await freePort(),
      devServer: await freePort(),
    };
    const stop = await bringUp({
      ports: live,
      platforms: [],
      label: 'test',
      pluginRoutes: 'read-only',
    });

    try {
      assert.equal(
        await (await fetch(`http://localhost:${live.atomicServer}/`)).text(),
        'fake plugin-routes server',
      );
    } finally {
      await stop();
    }

    const started = JSON.parse(readFileSync(log, 'utf8'));
    assert.deepEqual(started.args, pluginRoutesArgs('read-only', live));
    assert.deepEqual(started.env, {});
    for (const key of PLUGIN_ROUTES_ENV) assert.ok(!(key in started.env));
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routesImageFor: an explicit image, else the -plugin-routes variant of ATOMIC_SERVER_IMAGE', () => {
  const repo = 'ghcr.io/ontola/atomic-server-e2e';
  assert.equal(routesImageFor({}, pin), undefined);
  assert.equal(
    routesImageFor({ ATOMIC_SERVER_ROUTES_IMAGE: 'x:y' }, pin),
    'x:y',
  );
  const other = 'b'.repeat(40);
  assert.equal(
    routesImageFor({ ATOMIC_SERVER_IMAGE: `${repo}:${other}` }, pin),
    `${repo}:${other}-plugin-routes`,
  );
  // latest-pin has no variant; the pinned SHA's is used.
  assert.equal(
    routesImageFor({ ATOMIC_SERVER_IMAGE: `${repo}:latest-pin` }, pin),
    `${repo}:${pin}-plugin-routes`,
  );
  assert.equal(
    routesImageFor({ ATOMIC_SERVER_IMAGE: 'localhost:5000/e2e' }, pin),
    `localhost:5000/e2e:${pin}-plugin-routes`,
  );
  assert.match(
    imagePinProblem(`${repo}:${other}-plugin-routes`, pin),
    /is atomic-server b{40}/,
  );
});

test('a plugin-routes lane runs the variant image with the gate flags as container arguments', async () => {
  await withFakeDocker(
    {
      ATOMIC_SERVER_IMAGE: pinnedImage,
      FAKE_DOCKER_HAS_IMAGE: '1',
      FAKE_DOCKER_FEATURES: 'wasm-plugins,plugin-routes',
    },
    async calls => {
      delete process.env.ATOMIC_SERVER_ROUTES_BINARY;
      const live = {
        atomicServer: await freePort(),
        mockProxy: await freePort(),
        devServer: await freePort(),
      };
      const stop = await bringUp({
        ports: live,
        platforms: [],
        label: 'test',
        pluginRoutes: 'off',
      });
      await stop();
      const run = calls().find(args => args[0] === 'run');
      const image = `${pinnedImage}-plugin-routes`;
      assert.deepEqual(run.slice(run.indexOf(image)), [
        image,
        ...pluginRoutesArgs('off', live),
      ]);
    },
  );
});

test('a variant image without the feature falls back to the local plugin-routes build', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'atomic-routes-cache-'));
  const pinned = pinnedImage.split(':').at(-1);
  const dir = join(cache, `${pinned}-plugin-routes/target/e2e`);
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, 'atomic-server');
  const log = join(cache, 'server.json');
  writeFileSync(binary, FAKE_SERVER);
  chmodSync(binary, 0o755);

  try {
    await withFakeDocker(
      {
        ATOMIC_SERVER_IMAGE: pinnedImage,
        FAKE_DOCKER_HAS_IMAGE: '1',
        FAKE_DOCKER_FEATURES: 'wasm-plugins',
        ATOMIC_PLUGINS_BUILD_CACHE: cache,
        // No git checkout here, so the pin names the build.
        ATOMIC_SERVER_CHECKOUT: join(cache, 'no-checkout'),
        FAKE_SERVER_LOG: log,
      },
      async calls => {
        delete process.env.ATOMIC_SERVER_ROUTES_BINARY;
        const live = {
          atomicServer: await freePort(),
          mockProxy: await freePort(),
          devServer: await freePort(),
        };
        const stop = await bringUp({
          ports: live,
          platforms: [],
          label: 'test',
          pluginRoutes: 'read-only',
        });
        await stop();
        assert.ok(!calls().some(args => args[0] === 'run'));
        assert.deepEqual(
          JSON.parse(readFileSync(log, 'utf8')).args,
          pluginRoutesArgs('read-only', live),
        );
      },
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
