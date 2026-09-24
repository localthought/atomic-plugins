/** Planning checks only: not protocol conformance or sandbox certification. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLanes, root } from './lanes.mjs';

const capabilities = new Set([
  'http-routes', 'outbound-http', 'persistent-state', 'background-jobs',
  'peer-transport',
]);

export function validateContract(contract, id, readme) {
  assert.equal(contract.schemaVersion, 1, 'unsupported contract schemaVersion');
  assert.equal(contract.id, id, 'contract id must match the lane');
  assert.equal(contract.runtime, 'quickjs', 'server handlers must target QuickJS');
  assert.equal(
    contract.status, 'scaffold',
    'replace the contract tier with implementation tests before changing status',
  );
  for (const key of ['name', 'scope', 'firstInteropMilestone'])
    assert.ok(
      typeof contract[key] === 'string' && contract[key].trim(),
      `missing ${key}`,
    );
  assert.match(
    contract.trackingIssue ?? '',
    /^https:\/\/github\.com\/ontola\/atomic-plugins\/issues\/[1-9]\d*$/,
    'trackingIssue must name an atomic-plugins issue',
  );
  assert.ok(
    Array.isArray(contract.proposedHostCapabilities) &&
      contract.proposedHostCapabilities.length,
    'declare proposedHostCapabilities',
  );
  assert.equal(
    new Set(contract.proposedHostCapabilities).size,
    contract.proposedHostCapabilities.length,
    'duplicate proposed capability',
  );
  for (const capability of contract.proposedHostCapabilities)
    assert.ok(capabilities.has(capability), `unknown proposed capability: ${capability}`);
  const prose = value => value.replace(/\s+/g, ' ').trim();
  const normalizedReadme = prose(readme);
  for (const heading of [
    'Scope', 'Host requirements', 'First interoperability milestone',
    'Implementation checklist', 'CI',
  ]) assert.ok(
    new RegExp(`^## ${heading}(?:[ \t].*)?$`, 'm').test(readme),
    `README needs ${heading}`,
  );
  assert.ok(
    normalizedReadme.includes(prose(contract.scope)),
    'README must describe the declared scope',
  );
  assert.ok(
    normalizedReadme.includes(prose(contract.firstInteropMilestone)),
    'README must describe the declared milestone',
  );
  assert.ok(readme.includes('**scaffold**'), 'README must disclose scaffold status');
  assert.ok(readme.includes('QuickJS'), 'README must state the target runtime');
  assert.ok(
    readme.includes(`node integrations/tooling/run-lane.mjs ${id}`),
    'README needs a reproducible lane command',
  );
}

export function checkContract(id, base = root) {
  assert.match(id, /^[a-z][a-z0-9-]*$/, 'invalid lane id');
  const lane = loadLanes(base).lanes.find(lane => lane.id === id);
  assert.ok(lane?.tiers.includes('contract'), `no contract tier declared for ${id}`);
  const folder = resolve(base, 'integrations', id);
  validateContract(
    JSON.parse(readFileSync(resolve(folder, 'plugin.json'), 'utf8')),
    id,
    readFileSync(resolve(folder, 'README.md'), 'utf8'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkContract(process.argv[2]);
    console.log(`${process.argv[2]}: scaffold contract valid; protocol implementation and interoperability not tested`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
