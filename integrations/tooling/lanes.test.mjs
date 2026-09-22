import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadLanes,
  validateConfig,
  lanePorts,
  portsForTier,
  activeLanes,
  unlanedDirectories,
  danglingLanes,
  laneFilter,
  root,
} from './lanes.mjs';

const config = loadLanes();

// The case that would have caught integrations/calendar/ shipping without a
// path filter: a new plugin directory with no lane is invisible to CI.
test('every plugin directory has a lane', () => {
  assert.deepEqual(
    unlanedDirectories(config.lanes),
    [],
    'add these to integrations/lanes.json',
  );
});

test('every lane names a directory that exists', () => {
  assert.deepEqual(danglingLanes(config.lanes), []);
});

test('lane port blocks never overlap', () => {
  const seen = new Map();

  for (const lane of config.lanes)
    for (const [role, port] of Object.entries(lanePorts(lane, config))) {
      const owner = seen.get(port);
      assert.equal(
        owner,
        undefined,
        `port ${port} claimed by both ${owner} and ${lane.id}:${role}`,
      );
      seen.set(port, `${lane.id}:${role}`);
    }
});

// The canonical ports are compiled into the shared atomic-server build, so a
// derived block colliding with one would make a local lane fight the e2e run.
test('no derived port collides with a canonical port', () => {
  const canonical = new Set(Object.values(config.canonicalPorts));
  for (const lane of config.lanes)
    for (const port of Object.values(lanePorts(lane, config)))
      assert.ok(
        !canonical.has(port),
        `${lane.id} derives canonical port ${port}`,
      );
});

test('the e2e tier uses the canonical ports, other tiers do not', () => {
  const lane = config.lanes.find(l => l.tiers.includes('e2e'));
  assert.ok(lane, 'expected at least one e2e lane');
  assert.deepEqual(portsForTier(lane, config, 'e2e'), config.canonicalPorts);
  assert.deepEqual(portsForTier(lane, config, 'unit'), lanePorts(lane, config));
});

test('declared e2e specs exist', () => {
  for (const lane of config.lanes)
    for (const spec of lane.e2e ?? [])
      assert.ok(existsSync(resolve(root, spec)), `missing spec ${spec}`);
});

test('a lane declaring typecheck or unit has the config that tier runs', () => {
  for (const lane of config.lanes) {
    if (lane.tiers.includes('typecheck'))
      assert.ok(
        existsSync(resolve(root, `integrations/${lane.id}/tsconfig.json`)),
        `${lane.id} declares typecheck but has no tsconfig.json`,
      );
    if (lane.tiers.includes('unit') || lane.tiers.includes('live'))
      assert.ok(
        existsSync(resolve(root, `integrations/${lane.id}/vitest.config.ts`)),
        `${lane.id} declares unit/live but has no vitest.config.ts`,
      );
  }
});

test('a lane filter covers only its own directory', () => {
  for (const lane of config.lanes)
    assert.deepEqual(laneFilter(lane), [`integrations/${lane.id}/**`]);
});

test('activeLanes drops tier-less lanes', () => {
  const ids = activeLanes(config.lanes).map(l => l.id);
  assert.ok(!ids.includes('money'), 'money has no tiers and needs no job');
  assert.ok(ids.includes('pets'));
});

const lane = (over = {}) => ({ id: 'a', index: 0, tiers: [], ...over });
const cfg = (...lanes) => ({ portBase: 19100, lanes });

test('duplicate indexes are rejected, and the message names both lanes', () => {
  assert.throws(
    () => validateConfig(cfg(lane(), lane({ id: 'b' }))),
    /duplicate lane index 0 \(a and b\)/,
  );
});

test('duplicate ids are rejected', () => {
  assert.throws(
    () => validateConfig(cfg(lane(), lane({ index: 1 }))),
    /duplicate lane id: a/,
  );
});

test('an unknown tier is rejected', () => {
  assert.throws(
    () => validateConfig(cfg(lane({ tiers: ['smoke'] }))),
    /unknown tier smoke/,
  );
});

test('an e2e tier without a spec list is rejected', () => {
  assert.throws(
    () => validateConfig(cfg(lane({ tiers: ['e2e'] }))),
    /needs an e2e spec list/,
  );
  assert.doesNotThrow(() =>
    validateConfig(cfg(lane({ tiers: ['e2e'], e2e: ['x.spec.ts'] }))),
  );
});

test('a live tier without a liveEnv is rejected', () => {
  assert.throws(
    () => validateConfig(cfg(lane({ tiers: ['live'] }))),
    /needs a liveEnv name/,
  );
});
