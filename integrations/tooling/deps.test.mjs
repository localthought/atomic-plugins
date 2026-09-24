/**
 * installMissing() is what certify.mjs and run-lane.mjs call before they run
 * anything. Exercised against a throwaway directory with a stubbed installer,
 * so it needs neither pnpm nor the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  installMissing,
  missingInstalls,
  pluginDependencyDirs,
  sharedDependencyDirs,
} from './deps.mjs';

function fixture(dirs) {
  const base = mkdtempSync(join(tmpdir(), 'atomic-deps-'));

  for (const [dir, { lock = true, installed = false }] of Object.entries(
    dirs,
  )) {
    mkdirSync(join(base, dir), { recursive: true });
    if (lock) writeFileSync(join(base, dir, 'pnpm-lock.yaml'), '');
    if (installed) mkdirSync(join(base, dir, 'node_modules'));
  }

  return base;
}

function recorder(base, status = 0) {
  const calls = [];

  return {
    calls,
    install: cwd => {
      calls.push(relative(base, cwd));

      return { status, stdout: 'pnpm said this', stderr: '' };
    },
  };
}

test('a lockfile without node_modules is installed, with one line each', () => {
  const base = fixture({
    'integrations/notion': {},
    'integrations/issue-tracker/app': {},
  });

  try {
    const { calls, install } = recorder(base);
    const lines = [];
    const installed = installMissing(
      [
        ...pluginDependencyDirs('notion'),
        ...pluginDependencyDirs('issue-tracker'),
      ],
      { base, install, log: line => lines.push(line) },
    );
    assert.deepEqual(calls, [
      'integrations/notion',
      'integrations/issue-tracker/app',
    ]);
    assert.deepEqual(installed, calls);
    assert.deepEqual(lines, [
      'Installing integrations/notion dependencies (pnpm install --frozen-lockfile)',
      'Installing integrations/issue-tracker/app dependencies (pnpm install --frozen-lockfile)',
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an existing node_modules is left alone, as on CI', () => {
  const base = fixture({
    'integrations/notion': { installed: true },
    'integrations/pets': { installed: true },
    devonian: { installed: true },
  });

  try {
    const { calls, install } = recorder(base);
    const lines = [];
    installMissing(
      [
        ...pluginDependencyDirs('notion'),
        ...pluginDependencyDirs('pets'),
        'devonian',
      ],
      { base, install, log: line => lines.push(line) },
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(lines, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a folder without a pnpm-lock.yaml is never installed', () => {
  const base = fixture({ 'integrations/localthought': { lock: false } });

  try {
    assert.deepEqual(
      missingInstalls(
        [...pluginDependencyDirs('localthought'), 'integrations/absent'],
        base,
      ),
      [],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the same folder is installed once, however often it is named', () => {
  const base = fixture({ devonian: {} });

  try {
    const { calls, install } = recorder(base);
    installMissing(
      [
        'devonian',
        ...sharedDependencyDirs([
          'devonian/src/**',
          'devonian/package.json',
          'devonian/pnpm-lock.yaml',
        ]),
      ],
      { base, install, log: () => {} },
    );
    assert.deepEqual(calls, ['devonian']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a failed install stops the run and shows pnpm output', () => {
  const base = fixture({ 'integrations/pets': {} });

  try {
    const { install } = recorder(base, 1);
    assert.throws(
      () =>
        installMissing(pluginDependencyDirs('pets'), {
          base,
          install,
          log: () => {},
        }),
      /pnpm install --frozen-lockfile failed in integrations\/pets:\npnpm said this/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('certify.mjs and run-lane.mjs both install before they run', () => {
  for (const file of ['certify.mjs', 'run-lane.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /from '\.\/deps\.mjs'/, file);
    assert.match(source, /installMissing\(/, file);
  }
});
