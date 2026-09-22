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

export const TIERS = ['typecheck', 'unit', 'live', 'e2e'];

export function validateConfig(config) {
  const { lanes } = config;
  if (!Array.isArray(lanes) || !lanes.length)
    throw new Error('lanes.json must declare a non-empty lanes array');
  if (!Number.isInteger(config.portBase))
    throw new Error('lanes.json must declare an integer portBase');

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
    if (lane.tiers.includes('e2e') && !lane.e2e?.length)
      throw new Error(`lane ${lane.id}: an e2e tier needs an e2e spec list`);
    if (lane.tiers.includes('live') && !lane.liveEnv)
      throw new Error(`lane ${lane.id}: a live tier needs a liveEnv name`);
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

/**
 * The e2e tier must use canonicalPorts: those values are compiled into the
 * shared atomic-server build's frontend and cannot be overridden at runtime
 * (integrations/HANDOFF-runtime-urls.md is the task that removes this).
 */
export function portsForTier(lane, config, tier) {
  return tier === 'e2e' ? config.canonicalPorts : lanePorts(lane, config);
}

/** The directories a lane owns, for dorny/paths-filter. */
export const laneFilter = lane => [`integrations/${lane.id}/**`];

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
];

/** The `filters:` block for dorny/paths-filter, generated so it can't drift. */
export function filtersYaml(config) {
  const block = (name, paths) =>
    `${name}:\n${paths.map(p => `  - '${p}'`).join('\n')}`;

  return [
    block('shared', SHARED_FILTER),
    ...config.lanes.map(l => block(l.id, laneFilter(l))),
    block('any', ['integrations/**', ...SHARED_FILTER]),
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
