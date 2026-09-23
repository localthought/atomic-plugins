/**
 * Set up the layout every package under integrations/ needs to build and
 * test: an ontola/atomic-server checkout at the commit pinned in
 * `.atomic-server-ref`, with its `browser/` symlinked into this repo so the
 * packages' relative `../../browser/lib/src/...` imports resolve.
 *
 * This is the exact wiring CI uses — ci.yml runs this script (with
 * --no-fetch, after actions/checkout has fetched the pinned commit) instead
 * of restating the `ln -s` itself, so local and CI setups cannot drift.
 *
 *   node integrations/tooling/link-atomic-server.mjs            # set up / update
 *   node integrations/tooling/link-atomic-server.mjs --check    # verify only
 *
 * The checkout lives at ATOMIC_SERVER_CHECKOUT (default /tmp/atomic-server,
 * the same default serve.mjs and run-lane.mjs use), outside this repo, so one
 * checkout — and its pnpm store and cargo cache — is shared by every worktree.
 *
 * Steps, each idempotent:
 *   1. Clone (shallow, just the pinned commit) if the checkout is missing;
 *      otherwise fetch and check out the pinned commit if HEAD differs.
 *      Refuses to move a checkout that has uncommitted changes.
 *      --no-fetch skips this and only verifies HEAD (CI's mode).
 *   2. Symlink `browser` -> <checkout>/browser (replacing a stale symlink,
 *      never a real directory).
 *   3. Symlink `integrations/node_modules` -> ../browser/e2e/node_modules,
 *      which lane e2e specs need for bare `@playwright/test` imports
 *      (run-lane.mjs also creates it on demand).
 *   4. `pnpm install --frozen-lockfile` in <checkout>/browser, unless
 *      --no-install.
 *
 * Not covered, on purpose: the atomic-server binary (`cargo build`, only the
 * live/e2e tiers need it — serve.mjs prints the command), and
 * `integrations/localthought`'s `../../wasm/pkg/atomic_wasm.js` (a
 * `wasm-pack` build of atomic-server's Rust `wasm` crate, used only by
 * localthought's wasm-smoke.mjs, which CI does not run either).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './lanes.mjs';
import { serverCheckout } from './serve.mjs';

export const REPO_URL = 'https://github.com/ontola/atomic-server.git';

export const pinnedRef = (base = root) =>
  readFileSync(resolve(base, '.atomic-server-ref'), 'utf8').trim();

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * HEAD of the repository rooted exactly at `checkout`, or undefined — not the
 * HEAD of an enclosing repository git would otherwise walk up to.
 */
function headOf(checkout) {
  try {
    const top = git(checkout, 'rev-parse', '--show-toplevel');
    if (realpathSync(top) !== realpathSync(checkout)) return undefined;

    return git(checkout, 'rev-parse', 'HEAD');
  } catch {
    return undefined;
  }
}

/**
 * What is wrong with the current layout, as human-readable lines; empty when
 * `browser/` resolves into an atomic-server checkout at the pinned commit
 * with dependencies installed. Checks what `browser/` actually points at, not
 * ATOMIC_SERVER_CHECKOUT, so it is right however the link was made.
 */
export function layoutProblems(base = root) {
  const link = resolve(base, 'browser');
  const ref = pinnedRef(base);

  if (!existsSync(link))
    return [
      `${link} does not exist (or is a dangling symlink) — run node integrations/tooling/link-atomic-server.mjs`,
    ];

  const checkout = dirname(realpathSync(link));
  const head = headOf(checkout);
  const problems = [];

  if (head === undefined)
    problems.push(`${checkout} (browser/'s parent) is not a git checkout`);
  else if (head !== ref)
    problems.push(
      `${checkout} is at ${head.slice(0, 12)}, but .atomic-server-ref pins ${ref.slice(0, 12)} — you would be testing against the wrong atomic-server. Re-run node integrations/tooling/link-atomic-server.mjs`,
    );

  if (!existsSync(resolve(link, 'node_modules/.bin/tsc')))
    problems.push(
      `${link}/node_modules is not installed — run pnpm install --frozen-lockfile in ${checkout}/browser`,
    );

  return problems;
}

function ensureCheckout(checkout, ref) {
  if (!existsSync(checkout)) {
    console.log(`Cloning ${REPO_URL} @ ${ref.slice(0, 12)} into ${checkout}`);
    // init + fetch-by-SHA rather than `git clone`: only the pinned commit is
    // downloaded, not atomic-server's full history.
    execFileSync('git', ['init', '--quiet', checkout], { stdio: 'inherit' });
    git(checkout, 'remote', 'add', 'origin', REPO_URL);
  } else {
    const head = headOf(checkout);
    if (head === undefined)
      throw new Error(`${checkout} exists but is not a git checkout`);
    if (head === ref) return;

    const dirty = git(
      checkout,
      'status',
      '--porcelain',
      '--untracked-files=no',
    );
    if (dirty)
      throw new Error(
        `${checkout} has uncommitted changes and is at ${head.slice(0, 12)}, not the pinned ${ref.slice(0, 12)}. Commit or discard them, or point ATOMIC_SERVER_CHECKOUT elsewhere.`,
      );
  }

  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
      cwd: checkout,
      stdio: 'ignore',
    });
  } catch {
    console.log(`Fetching ${ref.slice(0, 12)}`);
    execFileSync('git', ['fetch', '--depth=1', 'origin', ref], {
      cwd: checkout,
      stdio: 'inherit',
    });
  }

  execFileSync('git', ['checkout', '--quiet', '--detach', ref], {
    cwd: checkout,
    stdio: 'inherit',
  });
  console.log(`${checkout} is now at ${ref.slice(0, 12)}`);
}

/** Point `path` at `target`, replacing a stale symlink but never real files. */
function ensureSymlink(path, target) {
  let stat;

  try {
    stat = lstatSync(path);
  } catch {
    stat = undefined;
  }

  if (stat) {
    if (!stat.isSymbolicLink())
      throw new Error(
        `${path} exists and is not a symlink; move it aside first`,
      );
    if (readlinkSync(path) === target) return;
    unlinkSync(path);
  }

  symlinkSync(target, path, 'dir');
  console.log(`Linked ${path} -> ${target}`);
}

function main(args) {
  const checkOnly = args.includes('--check');
  const noFetch = args.includes('--no-fetch');
  const noInstall = args.includes('--no-install');
  const unknown = args.filter(
    a => !['--check', '--no-fetch', '--no-install'].includes(a),
  );

  if (unknown.length) {
    console.error(
      `Unknown argument(s): ${unknown.join(' ')}\nUsage: link-atomic-server.mjs [--check | [--no-fetch] [--no-install]]`,
    );

    return 2;
  }

  if (!checkOnly) {
    const checkout = resolve(serverCheckout());
    const ref = pinnedRef();

    if (!noFetch) ensureCheckout(checkout, ref);
    ensureSymlink(resolve(root, 'browser'), resolve(checkout, 'browser'));
    ensureSymlink(
      resolve(root, 'integrations/node_modules'),
      '../browser/e2e/node_modules',
    );

    if (!noInstall) {
      const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
        cwd: resolve(checkout, 'browser'),
        stdio: 'inherit',
      });
      if (result.status !== 0) return result.status ?? 1;
    }
  }

  const problems = layoutProblems().filter(
    // With --no-install, missing node_modules is expected, not a failure.
    p => !(noInstall && p.includes('node_modules is not installed')),
  );

  for (const p of problems) console.error(p);
  if (problems.length) return 1;

  console.log(
    `browser/ -> atomic-server @ ${pinnedRef().slice(0, 12)}: layout OK`,
  );

  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
