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
