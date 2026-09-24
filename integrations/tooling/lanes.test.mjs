import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadLanes,
  validateConfig,
  lanePorts,
  sharedPorts,
  activeLanes,
  unlanedDirectories,
  danglingLanes,
  laneFilter,
  filtersYaml,
  root,
  PLUGIN_BUILD_DEPENDENCIES,
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

// The non-lane CI jobs run beside the lanes, so their block must be disjoint.
test('the shared block collides with no lane', () => {
  const shared = new Set(Object.values(sharedPorts(config)));
  for (const lane of config.lanes)
    for (const port of Object.values(lanePorts(lane, config)))
      assert.ok(!shared.has(port), `${lane.id} derives shared port ${port}`);
});

test('a lane may not claim the reserved shared index', () => {
  assert.throws(
    () => validateConfig({ ...cfg(lane({ index: 9 })), sharedIndex: 9 }),
    /reserved for the non-lane CI jobs/,
  );
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

test('a lane filter covers its own directory and only explicit sibling dependencies', () => {
  for (const lane of config.lanes) {
    const [own, ...extra] = laneFilter(lane);
    assert.equal(own, `integrations/${lane.id}/**`);
    for (const path of extra)
      assert.ok(
        !path.startsWith('integrations/') ||
          PLUGIN_BUILD_DEPENDENCIES[lane.id]?.includes(path),
        `${lane.id} claims ${path}`,
      );
  }
});

const lane = (over = {}) => ({ id: 'a', index: 0, tiers: [], ...over });

test('activeLanes drops tier-less lanes', () => {
  // Synthetic, not a real lane: which real lanes have tiers changes when one
  // gains its first tier (money did, for #95).
  assert.deepEqual(
    activeLanes([
      lane({ id: 'idle' }),
      lane({ id: 'busy', tiers: ['unit'] }),
    ]).map(l => l.id),
    ['busy'],
  );
});
const cfg = (...lanes) => ({ portBase: 19100, sharedIndex: 9, lanes });

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

test('lane paths are limited to shared packages', () => {
  assert.deepEqual(laneFilter(lane({ paths: ['devonian/src/**'] })), [
    'integrations/a/**',
    'devonian/src/**',
  ]);
  assert.throws(
    () => validateConfig(cfg(lane({ paths: ['integrations/b/**'] }))),
    /not in a shared package/,
  );
  assert.throws(
    () => validateConfig(cfg(lane({ paths: 'devonian/**' }))),
    /paths must be an array/,
  );
});

test('Willow WILLIAM3 dependency is exact, lane-specific and included in CI filters', () => {
  const path = 'integrations/willow-drop/william3.ts';
  const approved = lane({ id: 'willow', paths: [path] });
  assert.doesNotThrow(() => validateConfig(cfg(approved)));
  assert.ok(laneFilter(approved).includes(path));
  assert.match(
    filtersYaml(cfg(approved)),
    /integrations\/willow-drop\/william3\.ts/,
  );
  for (const wrong of [
    lane({ id: 'other', paths: [path] }),
    lane({ id: 'willow', paths: ['integrations/willow-drop/**'] }),
    lane({ id: 'willow', paths: ['integrations/willow-drop/drop.ts'] }),
  ])
    assert.throws(() => validateConfig(cfg(wrong)), /not in a shared package/);
});

// build-server, which every lane job needs, runs only when `any` matched, so
// a change to a lane's shared-package path must match `any` as well.
test('lane paths are also in the any filter', () => {
  const yaml = filtersYaml(cfg(lane({ paths: ['devonian/src/**'] })));
  const any = yaml.slice(yaml.indexOf('any:'));
  assert.match(any, /- 'devonian\/src\/\*\*'/);
});

test('node tiers require explicit plugin-owned test files', () => {
  assert.throws(
    () => validateConfig(cfg(lane({ tiers: ['node'] }))),
    /nodeTests/,
  );
  for (const path of [
    'integrations/b/x.test.mjs',
    'integrations/a/../b/x.test.mjs',
    'integrations/a/*.test.mjs',
    'integrations/a/source.mjs',
  ])
    assert.throws(
      () => validateConfig(cfg(lane({ tiers: ['node'], nodeTests: [path] }))),
      /nodeTests/,
    );
  assert.doesNotThrow(() =>
    validateConfig(
      cfg(lane({ tiers: ['node'], nodeTests: ['integrations/a/x.test.mjs'] })),
    ),
  );
});

test('node suite paths exist in every declared lane', () => {
  for (const entry of config.lanes)
    for (const path of entry.nodeTests ?? [])
      assert.ok(existsSync(resolve(root, path)), `missing test suite ${path}`);
});
