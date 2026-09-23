/**
 * layoutProblems() is the drift check run-lane.mjs warns with and
 * link-atomic-server.mjs --check exits on. Exercised against a throwaway
 * repository, never a real atomic-server checkout, so it needs no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutProblems } from './link-atomic-server.mjs';

function fixture({ installed = true, git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-layout-'));
  const checkout = join(dir, 'atomic-server');
  const base = join(dir, 'atomic-plugins');
  mkdirSync(join(checkout, 'browser'), { recursive: true });
  mkdirSync(base);

  if (installed) {
    mkdirSync(join(checkout, 'browser/node_modules/.bin'), { recursive: true });
    writeFileSync(join(checkout, 'browser/node_modules/.bin/tsc'), '');
  }

  let head = '0'.repeat(40);

  if (git) {
    const run = (...args) =>
      execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
    run('init', '--quiet');
    writeFileSync(join(checkout, 'README'), 'x');
    run('add', 'README');
    run(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'x',
    );
    head = run('rev-parse', 'HEAD');
  }

  symlinkSync(join(checkout, 'browser'), join(base, 'browser'));

  return {
    base,
    head,
    pin: ref => writeFileSync(join(base, '.atomic-server-ref'), `${ref}\n`),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('a checkout at the pinned commit with dependencies is clean', () => {
  const f = fixture();

  try {
    f.pin(f.head);
    assert.deepEqual(layoutProblems(f.base), []);
  } finally {
    f.done();
  }
});

test('a checkout at another commit is reported as drift', () => {
  const f = fixture();

  try {
    f.pin('f'.repeat(40));
    const problems = layoutProblems(f.base);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /wrong atomic-server/);
  } finally {
    f.done();
  }
});

test('missing dependencies and a non-git parent are both reported', () => {
  const f = fixture({ installed: false, git: false });

  try {
    f.pin('f'.repeat(40));
    const problems = layoutProblems(f.base);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /not a git checkout/);
    assert.match(problems[1], /node_modules is not installed/);
  } finally {
    f.done();
  }
});

test('a missing browser link is reported', () => {
  const f = fixture();

  try {
    f.pin(f.head);
    rmSync(join(f.base, 'browser'));
    assert.match(layoutProblems(f.base)[0], /does not exist/);
  } finally {
    f.done();
  }
});
