import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadLanes, matrixFor, root, validateConfig } from './lanes.mjs';
import { checkContract, validateContract } from './server-contract.mjs';

// Deliberately synthetic: shared tooling must pass before any scaffold lands,
// and must not depend on a particular protocol or number of plugin folders.
const contract = {
  schemaVersion: 1,
  id: 'example-protocol',
  name: 'Example protocol',
  runtime: 'quickjs',
  status: 'scaffold',
  scope: 'Exchange one synthetic record.',
  trackingIssue: 'https://github.com/ontola/atomic-plugins/issues/88',
  proposedHostCapabilities: ['http-routes', 'persistent-state'],
  firstInteropMilestone: 'Read back the synthetic record from a test peer.',
};
const readme = `# Example protocol

**scaffold** targeting QuickJS.

## Scope
${contract.scope}

## Host requirements
Proposed HTTP routes and persistent state.

## First interoperability milestone
${contract.firstInteropMilestone}

## Implementation checklist
- Implement handlers and verify interoperability.

## CI
node integrations/tooling/run-lane.mjs ${contract.id} --tier contract
`;
const lane = { id: contract.id, index: 0, tiers: ['contract'] };
const config = {
  portBase: 19100,
  sharedIndex: 99,
  roleOffsets: { atomicServer: 0, mockProxy: 1, devServer: 2 },
  lanes: [lane],
};

function fixture(t) {
  const base = mkdtempSync(resolve(tmpdir(), 'server-contract-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const folder = resolve(base, 'integrations', contract.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    resolve(base, 'integrations/lanes.json'),
    JSON.stringify(config),
  );
  writeFileSync(resolve(folder, 'plugin.json'), JSON.stringify(contract));
  writeFileSync(resolve(folder, 'README.md'), readme);

  return { base, folder };
}

test('contract lanes are selected independently and by shared changes', () => {
  assert.doesNotThrow(() => validateConfig(config));
  assert.deepEqual(matrixFor(config, [lane.id]), [
    { lane: lane.id, tiers: 'contract' },
  ]);
  assert.deepEqual(matrixFor(config, ['shared']), matrixFor(config, [lane.id]));
  assert.deepEqual(matrixFor(config, ['unrelated']), []);
});

test('every declared repository contract is valid, with zero or any number allowed', () => {
  const actual = loadLanes();

  for (const entry of actual.lanes.filter(l => l.tiers.includes('contract'))) {
    checkContract(entry.id);
    assert.ok(matrixFor(actual, [entry.id]).some(l => l.lane === entry.id));
    assert.ok(matrixFor(actual, ['shared']).some(l => l.lane === entry.id));
  }
});

test('contracts reject identity drift, invalid capabilities and implementation claims', () => {
  validateContract(contract, contract.id, readme);
  for (const change of [
    { id: 'other' },
    { schemaVersion: 2 },
    { runtime: 'native-rust' },
    { status: 'implemented' },
    { name: '' },
    { scope: '  ' },
    { firstInteropMilestone: '' },
    { proposedHostCapabilities: [] },
    { proposedHostCapabilities: 'http-routes' },
    { proposedHostCapabilities: ['open-any-port'] },
    { proposedHostCapabilities: ['http-routes', 'http-routes'] },
    { trackingIssue: 'https://example.com' },
  ])
    assert.throws(() =>
      validateContract({ ...contract, ...change }, contract.id, readme),
    );
});

test('headings may add context and prose may wrap across lines', () => {
  const wrapped = readme
    .replace('## Scope', '## Scope and placement')
    .replace('## Host requirements', '## Host requirements and gates')
    .replace(contract.scope, contract.scope.replaceAll(' ', '\n'))
    .replace(
      contract.firstInteropMilestone,
      contract.firstInteropMilestone.replaceAll(' ', '\n'),
    );
  assert.doesNotThrow(() => validateContract(contract, contract.id, wrapped));
});

test('documentation must disclose status, runtime, scope, milestone and reproduction', () => {
  for (const required of [
    '## Scope',
    '## Host requirements',
    '## First interoperability milestone',
    '## Implementation checklist',
    '## CI',
    '**scaffold**',
    'QuickJS',
    contract.scope,
    contract.firstInteropMilestone,
    `node integrations/tooling/run-lane.mjs ${contract.id}`,
  ])
    assert.throws(() =>
      validateContract(contract, contract.id, readme.replace(required, '')),
    );
});

test('missing metadata, malformed JSON and undeclared contracts fail', t => {
  const { base, folder } = fixture(t);
  checkContract(contract.id, base);
  assert.throws(() => checkContract('undeclared', base), /no contract tier/);
  assert.throws(() => checkContract('../example-protocol', base));
  writeFileSync(resolve(folder, 'plugin.json'), '{broken');
  assert.throws(() => checkContract(contract.id, base), SyntaxError);
  rmSync(resolve(folder, 'plugin.json'));
  assert.throws(() => checkContract(contract.id, base), /ENOENT/);
  writeFileSync(resolve(folder, 'plugin.json'), JSON.stringify(contract));
  rmSync(resolve(folder, 'README.md'));
  assert.throws(() => checkContract(contract.id, base), /ENOENT/);
});

test('real runner executes the contract and propagates failures without browser dependencies', t => {
  const { base, folder } = fixture(t);
  const tooling = resolve(base, 'integrations/tooling');
  mkdirSync(tooling);
  // Copy the real entry point and its Node-only imports, keeping root resolution
  // identical to a checkout. No test-only runtime override or browser symlink.
  for (const file of [
    'run-lane.mjs',
    'lanes.mjs',
    'server-contract.mjs',
    'serve.mjs',
    'link-atomic-server.mjs',
    'deps.mjs',
  ])
    copyFileSync(
      resolve(root, 'integrations/tooling', file),
      resolve(tooling, file),
    );
  // A contract-only invocation must not try to install a future implementation's
  // dependencies, even when its lockfile is present.
  writeFileSync(
    resolve(folder, 'pnpm-lock.yaml'),
    'intentionally invalid fixture',
  );
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve(tooling, 'run-lane.mjs'), contract.id, ...args],
      { cwd: base, encoding: 'utf8', timeout: 10000 },
    );

  for (const args of [[], ['--tier', 'contract']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /scaffold contract valid; protocol implementation and interoperability not tested/,
    );
    assert.match(result.stdout, /contract passed/);
    assert.equal(result.stderr, '');
  }

  writeFileSync(
    resolve(folder, 'plugin.json'),
    JSON.stringify({ ...contract, runtime: 'native-rust' }),
  );
  const rejected = run();
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /server handlers must target QuickJS/);
  assert.match(rejected.stderr, /contract failed/);
  assert.doesNotMatch(rejected.stdout, /contract passed/);
});

test('node tier executes real suites and propagates failed or missing suites', t => {
  const { base, folder } = fixture(t);
  const tooling = resolve(base, 'integrations/tooling');
  mkdirSync(tooling);
  for (const file of [
    'run-lane.mjs',
    'lanes.mjs',
    'serve.mjs',
    'link-atomic-server.mjs',
    'deps.mjs',
  ])
    copyFileSync(
      resolve(root, 'integrations/tooling', file),
      resolve(tooling, file),
    );
  const nodeConfig = {
    ...config,
    lanes: [
      {
        ...lane,
        tiers: ['node'],
        nodeTests: [`integrations/${lane.id}/behavior.test.mjs`],
      },
    ],
  };
  writeFileSync(
    resolve(base, 'integrations/lanes.json'),
    JSON.stringify(nodeConfig),
  );
  const suite = resolve(folder, 'behavior.test.mjs');
  const testEnv = { ...process.env };
  delete testEnv.NODE_TEST_CONTEXT;

  const runNode = () =>
    spawnSync(process.execPath, [resolve(tooling, 'run-lane.mjs'), lane.id], {
      cwd: base,
      env: testEnv,
      encoding: 'utf8',
      timeout: 10000,
    });
  writeFileSync(
    suite,
    "import {test} from 'node:test'; test('works', () => {});",
  );
  const passed = runNode();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /node passed/);
  assert.match(passed.stdout, /# tests 1/);
  assert.equal(passed.stderr, '');
  writeFileSync(
    suite,
    "import {test} from 'node:test'; test('fails', () => { throw Error('expected'); });",
  );
  const failed = runNode();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /node failed/);
  rmSync(suite);
  const missing = runNode();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing test file/);
});
