/**
 * The atomic-server build with the `plugin-routes` Cargo feature, for lanes
 * that declare `pluginRoutes` in lanes.json (design
 * docs/design/server-plugin-routes.md, section 0.2: the feature is never in a
 * default or release build, so the ordinary shared build can't open a gate).
 *
 * Where the binary comes from, first match wins:
 *
 *   1. ATOMIC_SERVER_ROUTES_BINARY: a binary built with the feature. CI sets
 *      it to the artifact ci.yml's build-server made.
 *   2. ~/.cache/atomic-plugins/atomic-server/<sha>-plugin-routes/target/e2e/
 *      atomic-server, where <sha> is the commit ATOMIC_SERVER_CHECKOUT is at
 *      (the one the lane's browser/ and @tomic/lib come from), falling back to
 *      .atomic-server-ref. The same convention as the shared `<sha>` build in
 *      AGENTS.md, one directory over, so the two never share a target/.
 *   3. Otherwise that directory is created and built here: a detached
 *      worktree of ATOMIC_SERVER_REPO (default ~/gh/ontola/atomic-server),
 *      the browser WASM bundle, then
 *      `cargo build --profile e2e -p atomic-server --no-default-features
 *      --features wasm-plugins,plugin-routes`. About as long as the default
 *      build (~10 minutes). Never in CI (CI=true), which must use 1.
 *
 * Build lock: `<dir>.lock/`, created with mkdir (atomic), holding the
 * builder's pid and host. Another process that finds it waits for it to go
 * away and then uses the finished binary; a lock whose pid is no longer
 * running on this host is stale and removed. Once built, the directory is
 * read-only for everyone, like the shared `<sha>` build.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export const ROUTES_FEATURES = 'wasm-plugins,plugin-routes';
export const ROUTES_SUFFIX = '-plugin-routes';

/** Where the shared builds live, one directory per SHA (AGENTS.md). */
export const buildCache = (env = process.env) =>
  env.ATOMIC_PLUGINS_BUILD_CACHE ??
  resolve(homedir(), '.cache/atomic-plugins/atomic-server');

export const routesBuildDir = (sha, env = process.env) =>
  resolve(buildCache(env), `${sha}${ROUTES_SUFFIX}`);

export const binaryIn = dir => resolve(dir, 'target/e2e/atomic-server');

/** The commit a checkout is at, or undefined when it is not a git checkout. */
export function checkoutSha(checkout) {
  const r = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  const sha = r.status === 0 ? r.stdout.trim() : '';

  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

/**
 * The commands that create `dir` as a detached worktree of `repo` at `sha`,
 * as `{ what, cwd, command, args }`; nothing when it exists. `fetch` first
 * when the clone doesn't have the commit yet.
 */
export function worktreeSteps({ dir, sha, repo, fetch }) {
  if (existsSync(dir)) return [];

  return [
    ...(fetch
      ? [
          {
            what: 'fetch atomic-server',
            cwd: repo,
            command: 'git',
            args: ['-C', repo, 'fetch', 'origin'],
          },
        ]
      : []),
    {
      what: 'add a detached worktree',
      cwd: repo,
      command: 'git',
      args: ['-C', repo, 'worktree', 'add', '--detach', dir, sha],
    },
  ];
}

/**
 * The commands that build the binary in `dir`, in order, as
 * `{ what, cwd, command, args, env? }` or `{ what, copy: [[from, toDir]] }`.
 * The same recipe as AGENTS.md's shared build and ci.yml's build-server, with
 * the extra feature. `wasmPack` is a command line (array).
 */
export function buildSteps({ dir, wasmPack }) {
  const wasm = resolve(dir, 'wasm');
  const publicWasm = resolve(dir, 'browser/data-browser/public/wasm');

  return [
    {
      what: 'add the wasm targets to the pinned toolchain',
      cwd: dir,
      command: 'rustup',
      args: ['target', 'add', 'wasm32-unknown-unknown', 'wasm32-wasip2'],
    },
    {
      what: 'install JS dependencies',
      cwd: resolve(dir, 'browser'),
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
    },
    {
      what: 'build the browser WASM bundle',
      cwd: wasm,
      command: wasmPack[0],
      args: [
        ...wasmPack.slice(1),
        'build',
        '--target',
        'web',
        '--out-dir',
        'pkg',
        '--no-opt',
      ],
      // As in ci.yml: getrandom needs its wasm_js backend selected.
      env: {
        CARGO_ENCODED_RUSTFLAGS: '--cfg\x1fgetrandom_backend="wasm_js"',
      },
    },
    {
      what: 'copy the WASM bundle into the data-browser',
      copy: [
        [resolve(wasm, 'pkg/atomic_wasm.js'), publicWasm],
        [resolve(wasm, 'pkg/atomic_wasm_bg.wasm'), publicWasm],
      ],
    },
    {
      what: `build atomic-server with ${ROUTES_FEATURES}`,
      cwd: dir,
      command: 'cargo',
      args: [
        'build',
        '--profile',
        'e2e',
        '-p',
        'atomic-server',
        '--no-default-features',
        '--features',
        ROUTES_FEATURES,
      ],
      env: { SKIP_WASM_BUILD: '1', VITE_E2E: 'true' },
    },
  ];
}

const succeeds = (command, args) =>
  spawnSync(command, args, { stdio: 'ignore' }).status === 0;

/**
 * How to run wasm-pack: WASM_PACK, then one on PATH, then `cargo bin`
 * (cargo-run-bin, which Cargo.toml's workspace.metadata.bin pins), then a
 * `cargo install` of that pinned version into the build directory.
 */
function wasmPackCommand(dir, env) {
  if (env.WASM_PACK) return [env.WASM_PACK];
  if (succeeds('wasm-pack', ['--version'])) return ['wasm-pack'];
  if (succeeds('cargo', ['bin', '--version']))
    return ['cargo', 'bin', 'wasm-pack'];
  const version =
    /wasm-pack\s*=\s*\{\s*version\s*=\s*"([^"]+)"/.exec(
      readFileSync(resolve(dir, 'Cargo.toml'), 'utf8'),
    )?.[1] ?? '0.15.0';
  const root = resolve(dir, '.wasm-pack');
  const binary = resolve(root, 'bin/wasm-pack');

  if (!existsSync(binary)) {
    const r = spawnSync(
      'cargo',
      [
        'install',
        'wasm-pack',
        '--version',
        version,
        '--locked',
        '--root',
        root,
      ],
      { stdio: 'inherit' },
    );
    if (r.status !== 0)
      throw new Error(`could not install wasm-pack ${version} into ${root}`);
  }

  return [binary];
}

const alive = pid => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * Runs `build` holding `<dir>.lock`, unless another process holds it: then
 * waits for that one to finish and returns without building, and the caller
 * looks for the binary again. Stale locks (pid gone, same host) are removed.
 * Returns whether this process built.
 */
export async function withBuildLock(
  dir,
  build,
  { pollMs = 5000, timeoutMs = 90 * 60_000, log = console.warn } = {},
) {
  const lock = `${dir}.lock`;
  const owner = resolve(lock, 'owner.json');
  const started = Date.now();
  let waited = false;

  mkdirSync(dirname(dir), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder;

      try {
        holder = JSON.parse(readFileSync(owner, 'utf8'));
      } catch {
        // No owner file yet: the lock is being taken right now.
        holder = undefined;
      }

      if (holder && holder.host === hostname() && !alive(holder.pid)) {
        log(`removing stale build lock ${lock} (pid ${holder.pid} is gone)`);
        rmSync(lock, { recursive: true, force: true });
        continue;
      }

      if (!waited)
        log(
          `waiting for ${holder ? `pid ${holder.pid} on ${holder.host}` : 'another process'} to finish building ${basename(dir)} (lock ${lock})`,
        );
      waited = true;
      if (Date.now() - started > timeoutMs)
        throw new Error(
          `gave up waiting for the build lock ${lock}; remove it if no build is running`,
        );
      await new Promise(done => setTimeout(done, pollMs));
      continue;
    }

    if (waited) {
      // The other build is over: release and let the caller look again.
      rmSync(lock, { recursive: true, force: true });

      return false;
    }

    try {
      writeFileSync(
        owner,
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          startedAt: new Date().toISOString(),
        }),
      );
      await build();

      return true;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

function runStep(step, env) {
  console.warn(`plugin-routes build: ${step.what}`);

  if (step.copy) {
    for (const [from, to] of step.copy) {
      mkdirSync(to, { recursive: true });
      copyFileSync(from, resolve(to, basename(from)));
    }

    return;
  }

  const r = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: { ...env, ...step.env },
    stdio: 'inherit',
  });
  if (r.status !== 0)
    throw new Error(
      `plugin-routes build failed at "${step.what}": ${step.command} ${step.args.join(' ')} (exit ${r.status ?? r.signal})`,
    );
}

/**
 * The atomic-server binary with the `plugin-routes` feature, building it
 * first if needed (see the top of this file).
 */
export async function ensureRoutesBinary({
  checkout,
  pin,
  env = process.env,
} = {}) {
  if (env.ATOMIC_SERVER_ROUTES_BINARY) {
    if (!existsSync(env.ATOMIC_SERVER_ROUTES_BINARY))
      throw new Error(
        `ATOMIC_SERVER_ROUTES_BINARY=${env.ATOMIC_SERVER_ROUTES_BINARY} does not exist`,
      );

    return env.ATOMIC_SERVER_ROUTES_BINARY;
  }

  const sha = (checkout && checkoutSha(checkout)) ?? pin;
  if (!sha)
    throw new Error('no atomic-server commit to make a plugin-routes build of');
  const dir = routesBuildDir(sha, env);
  const binary = binaryIn(dir);
  if (existsSync(binary)) return binary;

  if (env.CI)
    throw new Error(
      `${binary} does not exist, and CI never builds it here: set ATOMIC_SERVER_ROUTES_BINARY to the build-server job's plugin-routes artifact.`,
    );

  const repo =
    env.ATOMIC_SERVER_REPO ?? resolve(homedir(), 'gh/ontola/atomic-server');
  if (!existsSync(resolve(repo, '.git')))
    throw new Error(
      `${binary} does not exist, and ${repo} is no atomic-server clone to build it from. Set ATOMIC_SERVER_REPO, or ATOMIC_SERVER_ROUTES_BINARY to a binary built with --features ${ROUTES_FEATURES}.`,
    );

  // Loops only when another process held the lock and its build left no
  // binary: then this one takes the lock and builds, or throws.
  while (!existsSync(binary))
    await withBuildLock(dir, () => {
      if (existsSync(binary)) return;
      const known = succeeds('git', [
        '-C',
        repo,
        'cat-file',
        '-e',
        `${sha}^{commit}`,
      ]);
      for (const step of worktreeSteps({ dir, sha, repo, fetch: !known }))
        runStep(step, env);
      const wasmPack = wasmPackCommand(dir, env);
      for (const step of buildSteps({ dir, wasmPack })) runStep(step, env);
    });

  return binary;
}
