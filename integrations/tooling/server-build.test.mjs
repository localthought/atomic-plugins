/**
 * server-build.mjs: where the plugin-routes build lives, what builds it, and
 * the build lock. The build itself (~10 minutes of cargo) is not run here;
 * the plugin-routes lane's e2e tier is what exercises a real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  binaryIn,
  buildSteps,
  ensureRoutesBinary,
  ROUTES_FEATURES,
  routesBuildDir,
  withBuildLock,
  worktreeSteps,
} from './server-build.mjs';
import { root } from './lanes.mjs';

const sha = 'c'.repeat(40);
const scratch = () => mkdtempSync(join(tmpdir(), 'atomic-routes-build-'));

test('the plugin-routes build sits next to the shared build of the same SHA', () => {
  const env = { ATOMIC_PLUGINS_BUILD_CACHE: '/cache' };
  assert.equal(routesBuildDir(sha, env), `/cache/${sha}-plugin-routes`);
  assert.equal(
    binaryIn(routesBuildDir(sha, env)),
    `/cache/${sha}-plugin-routes/target/e2e/atomic-server`,
  );
});

test('the build is the shared recipe with the plugin-routes feature added', () => {
  const steps = buildSteps({
    dir: '/d',
    wasmPack: ['cargo', 'bin', 'wasm-pack'],
  });
  const cargo = steps.at(-1);
  assert.equal(ROUTES_FEATURES, 'wasm-plugins,plugin-routes');
  assert.deepEqual(cargo.args, [
    'build',
    '--profile',
    'e2e',
    '-p',
    'atomic-server',
    '--no-default-features',
    '--features',
    'wasm-plugins,plugin-routes',
  ]);
  assert.deepEqual(cargo.env, { SKIP_WASM_BUILD: '1', VITE_E2E: 'true' });
  const wasm = steps.find(s => s.what.includes('WASM bundle') && s.command);
  assert.deepEqual(wasm.args.slice(0, 3), ['bin', 'wasm-pack', 'build']);
  assert.equal(wasm.cwd, '/d/wasm');

  // ci.yml's build-server makes the same build for CI.
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(
    ci.includes('--no-default-features --features wasm-plugins,plugin-routes'),
  );
});

test('an existing directory gets no worktree; a missing commit is fetched first', () => {
  const dir = scratch();

  try {
    assert.deepEqual(worktreeSteps({ dir, sha, repo: '/r', fetch: true }), []);
    const missing = join(dir, 'missing');
    assert.deepEqual(
      worktreeSteps({ dir: missing, sha, repo: '/r', fetch: false }).map(
        s => s.args,
      ),
      [['-C', '/r', 'worktree', 'add', '--detach', missing, sha]],
    );
    assert.equal(
      worktreeSteps({ dir: missing, sha, repo: '/r', fetch: true })[0].args[2],
      'fetch',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the build lock lets one process build while the other waits for it', async () => {
  const dir = join(scratch(), `${sha}-plugin-routes`);
  const quiet = { pollMs: 10, log: () => {} };
  const order = [];
  let release;
  const first = withBuildLock(
    dir,
    () =>
      new Promise(done => {
        order.push('first builds');
        release = done;
      }),
    quiet,
  );
  // The first holds the lock now; the second waits for it.
  await new Promise(done => setTimeout(done, 20));
  const second = withBuildLock(dir, () => order.push('second builds'), quiet);
  await new Promise(done => setTimeout(done, 50));
  assert.ok(existsSync(`${dir}.lock`));
  release();

  assert.equal(await first, true);
  assert.equal(await second, false, 'the waiter must not build again');
  assert.deepEqual(order, ['first builds']);
  assert.ok(!existsSync(`${dir}.lock`), 'the lock is released');
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

test('a lock left by a process that is gone is removed', async () => {
  const dir = join(scratch(), `${sha}-plugin-routes`);
  mkdirSync(`${dir}.lock`, { recursive: true });
  // A pid far above any real one on this host.
  writeFileSync(
    join(`${dir}.lock`, 'owner.json'),
    JSON.stringify({ pid: 2 ** 30, host: hostname() }),
  );
  const logs = [];

  assert.equal(
    await withBuildLock(dir, () => {}, { pollMs: 10, log: m => logs.push(m) }),
    true,
  );
  assert.match(logs[0], /removing stale build lock/);
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

test('ensureRoutesBinary: an explicit binary wins, CI never builds, and a missing clone is explained', async () => {
  const dir = scratch();

  try {
    const binary = join(dir, 'atomic-server');
    writeFileSync(binary, '');
    chmodSync(binary, 0o755);
    assert.equal(
      await ensureRoutesBinary({
        pin: sha,
        env: { ATOMIC_SERVER_ROUTES_BINARY: binary },
      }),
      binary,
    );
    await assert.rejects(
      ensureRoutesBinary({
        pin: sha,
        env: { ATOMIC_SERVER_ROUTES_BINARY: join(dir, 'nope') },
      }),
      /does not exist/,
    );

    const env = { ATOMIC_PLUGINS_BUILD_CACHE: dir };
    // Already built: used as is.
    mkdirSync(join(routesBuildDir(sha, env), 'target/e2e'), {
      recursive: true,
    });
    writeFileSync(binaryIn(routesBuildDir(sha, env)), '');
    assert.equal(
      await ensureRoutesBinary({ pin: sha, env }),
      binaryIn(routesBuildDir(sha, env)),
    );

    const other = 'd'.repeat(40);
    await assert.rejects(
      ensureRoutesBinary({ pin: other, env: { ...env, CI: 'true' } }),
      /CI never builds it here: set ATOMIC_SERVER_ROUTES_BINARY/,
    );
    await assert.rejects(
      ensureRoutesBinary({
        pin: other,
        env: { ...env, ATOMIC_SERVER_REPO: join(dir, 'no-clone') },
      }),
      /is no atomic-server clone/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
