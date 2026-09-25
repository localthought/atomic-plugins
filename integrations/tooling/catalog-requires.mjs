/**
 * The derived `requires` on catalog.json entries (design
 * docs/design/server-plugin-routes.md, section 0.5): e.g.
 * `["persistent-host", "plugin-routes:read-only", "public-origin",
 * "wasm-sandbox"]`, so a client can compare an entry with the node's
 * `hostFeatures` without parsing manifests. Authors never write it by hand:
 * it comes from the manifest that the package's committed plugin.js exports,
 * through manifest-http.mjs's port of the host's rules.
 *
 *   node integrations/tooling/catalog-requires.mjs check   # CI (via certify.mjs too)
 *   node integrations/tooling/catalog-requires.mjs write   # after a manifest change
 *
 * Which entries must carry it: the entry whose shortname is the package's
 * directory name under integrations/ (the same match certify.mjs uses for
 * `version`), when that package's manifest is version 3 or needs the
 * `plugin-routes` feature. Any other entry that carries it must carry exactly
 * the derived list. Entries reached through `pluginUrl` or a bridge have no
 * package here, so they are not checked.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeGating } from './manifest-http.mjs';
import { root } from './lanes.mjs';

export const REQUIRES =
  'https://atomicdata.dev/integrations/properties/requires';
const SHORTNAME = 'https://atomicdata.dev/properties/shortname';

/**
 * The `manifest` a bundle exports, or `null` when it exports none. Read in a
 * child process: plugin.js is an ES module, and a synchronous caller
 * (certify.mjs's discover) can't `await import()` it.
 */
export function readManifest(pluginJs) {
  if (!existsSync(pluginJs) || !readFileSync(pluginJs, 'utf8').trim())
    return null;
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.manifest ?? null));',
      pluginJs,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (r.status !== 0)
    throw new Error(
      `could not load ${pluginJs}: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`,
    );

  return JSON.parse(r.stdout || 'null');
}

/**
 * `describeGating` of the package at `path` (relative to `base`), or `null`
 * when its plugin.js exports no manifest. Throws with the package path when
 * the manifest's http block is invalid.
 */
export function packageGating(base, path) {
  const manifest = readManifest(resolve(base, path, 'plugin.js'));
  if (manifest === null || manifest.schemaVersion === undefined) return null;

  try {
    return describeGating(manifest);
  } catch (error) {
    throw new Error(`${path}: invalid manifest: ${error.message}`);
  }
}

/** Whether a package's catalog entry must carry `requires`. */
export const needsRequires = gating =>
  !!gating && (gating.schemaVersion === 3 || gating.gated);

const same = (a, b) =>
  Array.isArray(a) &&
  a.length === b.length &&
  a.every((value, i) => value === b[i]);

/**
 * Problems with one package's entry, as strings naming `path`. `card` is its
 * catalog entry, if any.
 */
export function requiresProblems(path, gating, card) {
  const declared = card?.[REQUIRES];

  if (!needsRequires(gating)) {
    if (declared === undefined) return [];
    if (!gating)
      return [
        `${path}: catalog.json carries requires, but plugin.js exports no versioned manifest to derive it from`,
      ];
  }

  const expected = JSON.stringify(gating.requires);
  const what = gating.gated
    ? `a gated plugin (needs plugin-routes:${gating.gate.needed})`
    : `a version ${gating.schemaVersion} manifest`;

  if (!card)
    return [
      `${path}: ${what} needs a catalog.json entry with shortname "${path.split('/').at(-1)}" carrying requires ${expected}`,
    ];
  if (declared === undefined)
    return [
      `${path}: ${what} has no requires in catalog.json; it must be ${expected} (node integrations/tooling/catalog-requires.mjs write)`,
    ];
  if (!same(declared, gating.requires))
    return [
      `${path}: catalog.json requires ${JSON.stringify(declared)} does not match what the manifest derives, ${expected} (node integrations/tooling/catalog-requires.mjs write)`,
    ];

  return [];
}

/** Package directories under integrations/ that ship a plugin.js. */
export function bundledPackages(base = root) {
  return readdirSync(resolve(base, 'integrations'), { withFileTypes: true })
    .filter(
      d =>
        d.isDirectory() &&
        existsSync(resolve(base, 'integrations', d.name, 'plugin.js')),
    )
    .map(d => d.name)
    .sort();
}

const readCatalog = base => {
  const path = resolve(base, 'integrations/catalog.json');

  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
};

/** Every package's problems, for `check`. */
export function catalogRequiresProblems(base = root) {
  const catalog = readCatalog(base);

  return bundledPackages(base).flatMap(id => {
    const path = `integrations/${id}`;
    const card = catalog.find(e => e[SHORTNAME] === id);

    return requiresProblems(path, packageGating(base, path), card);
  });
}

/**
 * Sets `requires` on each entry that needs it to the derived list and
 * returns the ids it changed. It never creates an entry: a gated package
 * without one still fails `check`.
 */
export function writeCatalogRequires(base = root) {
  const path = resolve(base, 'integrations/catalog.json');
  const catalog = readCatalog(base);
  const changed = [];

  for (const id of bundledPackages(base)) {
    const gating = packageGating(base, `integrations/${id}`);
    const card = catalog.find(e => e[SHORTNAME] === id);
    if (!card || !needsRequires(gating)) continue;
    if (same(card[REQUIRES], gating.requires)) continue;
    card[REQUIRES] = gating.requires;
    changed.push(id);
  }

  if (changed.length)
    writeFileSync(path, JSON.stringify(catalog, null, 2) + '\n');

  return changed;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.argv[2];

  if (mode === 'check') {
    const problems = catalogRequiresProblems();
    for (const problem of problems) console.error(problem);
    process.exitCode = problems.length ? 1 : 0;
  } else if (mode === 'write') {
    const changed = writeCatalogRequires();
    console.info(
      changed.length
        ? `Updated requires for ${changed.join(', ')}`
        : 'catalog.json requires already match the manifests',
    );
  } else {
    console.error('Usage: catalog-requires.mjs check | write');
    process.exitCode = 1;
  }
}
