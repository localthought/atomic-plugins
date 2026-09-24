/**
 * The per-plugin CI lanes, loaded and validated from integrations/lanes.json.
 *
 * `.github/workflows/ci.yml` and `run-lane.mjs` both go through this module so
 * the lane list, its path filters and its port blocks are stated exactly once.
 * Before this existed the list was written out three times inside ci.yml (the
 * `changes` job's `outputs:`, its `filters:` and every step's `if:`), which is
 * how integrations/calendar/ shipped ungated. See integrations/PARALLEL_LANES.md.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Directories under integrations/ that are not a plugin lane. */
export const NON_LANE_DIRECTORIES = ['tooling'];

export const TIERS = ['contract', 'node', 'typecheck', 'unit', 'live', 'e2e'];

export function validateConfig(config) {
  const { lanes } = config;
  if (!Array.isArray(lanes) || !lanes.length)
    throw new Error('lanes.json must declare a non-empty lanes array');
  if (!Number.isInteger(config.portBase))
    throw new Error('lanes.json must declare an integer portBase');
  if (!Number.isInteger(config.sharedIndex))
    throw new Error('lanes.json must declare an integer sharedIndex');

  const seenIds = new Set();
  const seenIndexes = new Map();

  for (const lane of lanes) {
    if (!lane.id || typeof lane.id !== 'string')
      throw new Error('every lane needs a string id');
    if (!Number.isInteger(lane.index) || lane.index < 0)
      throw new Error(`lane ${lane.id}: index must be a non-negative integer`);
    if (seenIds.has(lane.id)) throw new Error(`duplicate lane id: ${lane.id}`);
    // An index is permanent: it is what the port block is derived from, so
    // reusing one silently points two lanes at the same three ports.
    if (lane.index === config.sharedIndex)
      throw new Error(
        `lane ${lane.id}: index ${lane.index} is reserved for the non-lane CI jobs`,
      );
    if (seenIndexes.has(lane.index))
      throw new Error(
        `duplicate lane index ${lane.index} (${seenIndexes.get(lane.index)} and ${lane.id}); indexes are permanent, leave holes instead of renumbering`,
      );
    seenIds.add(lane.id);
    seenIndexes.set(lane.index, lane.id);
    if (!Array.isArray(lane.tiers))
      throw new Error(`lane ${lane.id}: tiers must be an array`);
    for (const tier of lane.tiers)
      if (!TIERS.includes(tier))
        throw new Error(`lane ${lane.id}: unknown tier ${tier}`);

    if (lane.tiers.includes('node')) {
      if (!Array.isArray(lane.nodeTests) || !lane.nodeTests.length)
        throw new Error(
          `lane ${lane.id}: a node tier needs a non-empty nodeTests list`,
        );

      for (const path of lane.nodeTests) {
        if (
          typeof path !== 'string' ||
          !path.startsWith(`integrations/${lane.id}/`) ||
          !path.endsWith('.test.mjs') ||
          path.split('/').some(part => part === '..' || part === '.') ||
          path.includes('\\') ||
          path.includes('*')
        )
          throw new Error(
            `lane ${lane.id}: nodeTests must name explicit .test.mjs files inside its plugin folder`,
          );
      }
    }

    if (lane.tiers.includes('e2e') && !lane.e2e?.length)
      throw new Error(`lane ${lane.id}: an e2e tier needs an e2e spec list`);
    if (lane.tiers.includes('live') && !lane.liveEnv)
      throw new Error(`lane ${lane.id}: a live tier needs a liveEnv name`);

    if (lane.paths !== undefined) {
      if (!Array.isArray(lane.paths))
        throw new Error(`lane ${lane.id}: paths must be an array`);
      for (const path of lane.paths)
        if (!SHARED_PACKAGES.some(pkg => path.startsWith(`${pkg}/`)))
          throw new Error(
            `lane ${lane.id}: path ${path} is not in a shared package (${SHARED_PACKAGES.join(', ')}); a lane owns only integrations/${lane.id}/`,
          );
    }
  }

  return config;
}

export function loadLanes(base = root) {
  return validateConfig(
    JSON.parse(readFileSync(resolve(base, 'integrations/lanes.json'), 'utf8')),
  );
}

/** Every lane's three listeners, derived so CI logs and local runs agree. */
export function lanePorts(lane, config) {
  const base = config.portBase + lane.index * 10;

  return Object.fromEntries(
    Object.entries(config.roleOffsets).map(([role, offset]) => [
      role,
      base + offset,
    ]),
  );
}

/** Ports for the CI jobs that are not a plugin lane. */
export const sharedPorts = config =>
  lanePorts({ index: config.sharedIndex }, config);

/**
 * The shared, independently built packages at the repo root that a plugin may
 * consume by source (e.g. integrations/issue-tracker/devonian/ imports the
 * `devonian` package). A lane may list paths in these under `paths`, so a
 * change there still runs the plugin code that depends on it; it may never
 * list another plugin's directory.
 */
export const SHARED_PACKAGES = ['devonian', 'syncables', 'reflector'];

/**
 * The paths a lane runs on, for dorny/paths-filter: its own directory, plus
 * any shared-package `paths` it declares.
 */
export const laneFilter = lane => [
  `integrations/${lane.id}/**`,
  ...(lane.paths ?? []),
];

/** Lanes that produce an actual matrix job; a tier-less lane is covered elsewhere. */
export const activeLanes = lanes => lanes.filter(l => l.tiers.length > 0);

/**
 * Plugin directories with no lane entry. Returning them rather than throwing
 * lets lanes.test.mjs report every missing one at once.
 */
export function unlanedDirectories(lanes, base = root) {
  const ids = new Set(lanes.map(l => l.id));

  return readdirSync(resolve(base, 'integrations'), { withFileTypes: true })
    .filter(d => d.isDirectory() && !NON_LANE_DIRECTORIES.includes(d.name))
    .map(d => d.name)
    .filter(name => !ids.has(name));
}

/** Lanes naming a directory that no longer exists. */
export function danglingLanes(lanes, base = root) {
  return lanes
    .map(l => l.id)
    .filter(id => !existsSync(resolve(base, 'integrations', id)));
}

/**
 * Paths that can affect every lane. A change here fans out to all of them
 * rather than being attributed to one plugin.
 */
export const SHARED_FILTER = [
  'integrations/tooling/**',
  'integrations/lanes.json',
  'integrations/catalog.json',
  'integrations/*.md',
  'integrations/tsconfig.e2e.json',
  '.atomic-server-ref',
  '.github/workflows/ci.yml',
  // ci.yml's publish-image job calls it.
  '.github/workflows/atomic-server-e2e-image.yml',
];

/** The `filters:` block for dorny/paths-filter, generated so it can't drift. */
export function filtersYaml(config) {
  const block = (name, paths) =>
    `${name}:\n${paths.map(p => `  - '${p}'`).join('\n')}`;

  // A lane's shared-package `paths` go into `any` too: build-server, which
  // every lane job needs, is gated on it.
  const lanePaths = [...new Set(config.lanes.flatMap(l => l.paths ?? []))];

  return [
    block('shared', SHARED_FILTER),
    ...config.lanes.map(l => block(l.id, laneFilter(l))),
    // apps/ holds the committed drive app modules; shared-checks' `apps.mjs
    // check` guards them (and a change there comes with a catalog.json one).
    block('any', [
      'integrations/**',
      'apps/**',
      ...SHARED_FILTER,
      ...lanePaths,
    ]),
  ].join('\n');
}

/**
 * The matrix for a run, from dorny/paths-filter's `changes` output (a JSON
 * array of the filter names that matched). `shared` selects every lane.
 */
export function matrixFor(config, changed) {
  const names = new Set(changed);
  const lanes = activeLanes(config.lanes).filter(
    l => names.has('shared') || names.has(l.id),
  );

  return lanes.map(l => ({ lane: l.id, tiers: l.tiers.join(',') }));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const config = loadLanes();
  const [mode, argument] = process.argv.slice(2);

  if (mode === 'filters') process.stdout.write(filtersYaml(config) + '\n');
  else if (mode === 'matrix')
    process.stdout.write(
      JSON.stringify(matrixFor(config, JSON.parse(argument ?? '[]'))) + '\n',
    );
  else if (mode === 'ports')
    process.stdout.write(
      JSON.stringify(
        Object.fromEntries(config.lanes.map(l => [l.id, lanePorts(l, config)])),
        null,
        2,
      ) + '\n',
    );
  else {
    console.error('Usage: lanes.mjs filters | matrix <changed-json> | ports');
    process.exit(1);
  }
}
