/**
 * Drive apps in the catalog: check them, and write a new version's module.
 *
 * A catalog.json entry is an installable drive app when it carries
 * `app-module` (the URL of the built ES module for exactly `version`) and
 * `app-module-integrity` (the SRI hash of those bytes). The host downloads the
 * module, refuses it unless the hash matches, and stores it as a new app's
 * entry point (atomic-server `browser/lib/src/catalog-app.ts`). The module is
 * `integrations/<shortname>/app/build.mjs`'s output, committed to this
 * repository at `apps/<shortname>/<version>/ui.js`. GitHub Pages publishes
 * `main` from the repository root (with the root `.nojekyll`, byte for byte),
 * so the catalog points at:
 *
 *   https://ontola.github.io/atomic-plugins/apps/<shortname>/<version>/ui.js
 *
 * Every released version stays at its own URL. A version file that is on
 * `main` is never changed or deleted, which `check --published` enforces; a
 * changed build needs a new version. Pages itself is mutable, which is why
 * the host's integrity check matters: a changed file is refused, not
 * installed.
 *
 *   node integrations/tooling/apps.mjs check [--published <ref>]  # CI
 *   node integrations/tooling/apps.mjs write [<id>]  # build into apps/, set url + integrity
 *
 * `check` compares with `origin/main` by default when that ref exists; CI
 * passes it explicitly on pull requests.
 *
 * Builds need the layout AGENTS.md describes (browser/ from the pinned
 * atomic-server, for esbuild) and `pnpm install` in each app's plugin folder.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const P = 'https://atomicdata.dev/integrations/properties/';

export const terms = {
  shortname: 'https://atomicdata.dev/properties/shortname',
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  version: `${P}version`,
  module: `${P}app-module`,
  integrity: `${P}app-module-integrity`,
};

/** Where GitHub Pages serves this repository's `main` (root folder). */
export const PAGES_BASE = 'https://ontola.github.io/atomic-plugins/';

/** The committed module of one app version, relative to the repository root. */
export const modulePath = (id, version) => `apps/${id}/${version}/ui.js`;
export const moduleUrl = (id, version) =>
  `${PAGES_BASE}${modulePath(id, version)}`;

/** `apps/<id>/<version>/ui.js` and nothing else lives under apps/. */
const MODULE_PATH =
  /^apps\/[a-z0-9][a-z0-9-]*\/[0-9A-Za-z][0-9A-Za-z.+-]*\/ui\.js$/;

export const integrityOf = bytes =>
  `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

export const catalogPath = (base = root) =>
  resolve(base, 'integrations/catalog.json');

export function readCatalog(base = root) {
  return JSON.parse(readFileSync(catalogPath(base), 'utf8'));
}

/** Catalog entries that are drive apps: they carry `app-module`. */
export function appEntries(catalog) {
  return catalog.filter(
    entry =>
      entry &&
      typeof entry === 'object' &&
      typeof entry[terms.module] === 'string',
  );
}

/**
 * Where an app's version is recorded: the plugin folder's package.json (the
 * #12 rule `certify.mjs` also enforces for a sandbox package), or, for a
 * folder that ships only an app and so has no certified package, a
 * `private` `app/package.json` holding just the version.
 */
export function versionFile(id, base = root) {
  for (const relativePath of [
    `integrations/${id}/package.json`,
    `integrations/${id}/app/package.json`,
  ])
    if (existsSync(resolve(base, relativePath))) return relativePath;

  return undefined;
}

/**
 * Everything about one app entry that does not need a build: the fields are
 * there, the version matches the folder's version file (`versionFile`), the
 * URL is the Pages one for that version, the committed module exists and its
 * hash is the pinned integrity, and the folder has an `app/build.mjs`.
 */
export function staticProblems(entry, base = root) {
  const id = entry[terms.shortname];
  const version = entry[terms.version];
  const problems = [];

  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id))
    return [`app entry has no usable shortname: ${JSON.stringify(id)}`];
  if (typeof version !== 'string' || !version)
    problems.push(`${id}: app entry needs a version`);
  if (!/^sha384-[A-Za-z0-9+/]+={0,2}$/.test(entry[terms.integrity] ?? ''))
    problems.push(`${id}: app-module-integrity must be a sha384 SRI hash`);

  if (version && !MODULE_PATH.test(modulePath(id, version)))
    problems.push(`${id}: version ${version} cannot be a URL path segment`);
  else if (version) {
    if (entry[terms.module] !== moduleUrl(id, version))
      problems.push(
        `${id}: app-module is ${entry[terms.module]}, expected ${moduleUrl(id, version)}`,
      );
    const committed = resolve(base, modulePath(id, version));
    const actual = existsSync(committed)
      ? integrityOf(readFileSync(committed))
      : undefined;
    if (!actual)
      problems.push(
        `${id}: ${modulePath(id, version)} is not committed; run \`node integrations/tooling/apps.mjs write ${id}\``,
      );
    else if (actual !== entry[terms.integrity])
      problems.push(
        `${id}: ${modulePath(id, version)} is ${actual}, the catalog pins ${entry[terms.integrity]}`,
      );
  }

  const file = versionFile(id, base);

  if (!file)
    problems.push(
      `${id}: neither integrations/${id}/package.json nor integrations/${id}/app/package.json records a version`,
    );
  else {
    const pkg = JSON.parse(readFileSync(resolve(base, file), 'utf8'));
    if (pkg.version !== version)
      problems.push(
        `${id}: catalog version ${version} does not match ${file} ${pkg.version}`,
      );
  }

  if (!existsSync(resolve(base, 'integrations', id, 'app/build.mjs')))
    problems.push(`${id}: integrations/${id}/app/build.mjs is missing`);

  return problems;
}

/** The app's module, built in memory by its own build.mjs. */
export async function buildApp(id, base = root) {
  const file = resolve(base, 'integrations', id, 'app/build.mjs');
  // Keyed by content, so a changed build.mjs is not served from the module
  // cache within one process.
  const version = createHash('sha1').update(readFileSync(file)).digest('hex');
  const { build } = await import(`${pathToFileURL(file).href}?${version}`);
  const { text } = await build();
  const bytes = Buffer.from(text, 'utf8');

  return { bytes, integrity: integrityOf(bytes) };
}

/** Every file under apps/, as repository-relative paths with `/`. */
export function committedModules(base = root) {
  const dir = resolve(base, 'apps');
  const found = [];

  const walk = at => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(relative(base, full).split(sep).join('/'));
    }
  };

  if (existsSync(dir)) walk(dir);

  return found.sort();
}

const git = (base, args) =>
  execFileSync('git', ['-C', base, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Whether `ref` names a commit in the repository at `base`. */
export function hasRef(ref, base = root) {
  try {
    git(base, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

    return true;
  } catch {
    return false;
  }
}

/** The files under apps/ at `ref`, as a map from path to git blob id. */
export function publishedModules(ref, base = root) {
  const published = new Map();

  for (const line of git(base, ['ls-tree', '-r', '-z', ref, '--', 'apps/'])
    .split('\0')
    .filter(Boolean)) {
    const [meta, path] = line.split('\t');
    published.set(path, meta.split(' ')[2]);
  }

  return published;
}

/** A file's git blob id, as `git hash-object` computes it (no filters). */
export const blobId = bytes =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');

/**
 * Published version files that the working tree changed or deleted. A
 * published file's URL is what installed apps recorded; its bytes must stay.
 */
export function publishedProblems(ref, base = root) {
  const problems = [];

  for (const [path, blob] of publishedModules(ref, base)) {
    const file = resolve(base, path);
    if (!existsSync(file))
      problems.push(
        `${path} is published at ${ref} and was deleted. Published versions stay available: restore it.`,
      );
    else if (blobId(readFileSync(file)) !== blob)
      problems.push(
        `${path} is published at ${ref} and was changed. Published versions are immutable: restore it and release a new version.`,
      );
  }

  return problems;
}

/**
 * All problems with the apps: per entry, `staticProblems` and a fresh build
 * that must equal the committed module; the shape of everything under apps/;
 * and, when `published` names a ref, that none of its version files changed.
 */
export async function check({ base = root, published } = {}) {
  const problems = [];

  for (const entry of appEntries(readCatalog(base))) {
    const found = staticProblems(entry, base);
    problems.push(...found);
    if (found.length) continue;
    const id = entry[terms.shortname];
    const path = modulePath(id, entry[terms.version]);
    const { integrity } = await buildApp(id, base);
    if (integrity !== entry[terms.integrity])
      problems.push(
        `${id}: a fresh build is ${integrity}, ${path} and the catalog pin ${entry[terms.integrity]}. ` +
          `If ${path} is not on main yet, run \`node integrations/tooling/apps.mjs write ${id}\`. ` +
          `If it is, it is immutable: bump the version in ${versionFile(id, base)} and catalog.json, then write.`,
      );
  }

  for (const path of committedModules(base))
    if (!MODULE_PATH.test(path))
      problems.push(
        `${path}: apps/ holds only apps/<id>/<version>/ui.js (see integrations/README.md, "Publishing a drive app")`,
      );

  if (published) problems.push(...publishedProblems(published, base));

  return problems;
}

/**
 * Builds each app entry (or only `only`) into `apps/<id>/<version>/ui.js` and
 * sets its URL and integrity. Refuses to change a version file that is
 * already published at `published`, before writing anything.
 */
export async function write({ only, base = root, published } = {}) {
  const catalog = readCatalog(base);
  const onMain = published ? publishedModules(published, base) : new Map();
  const builds = [];

  for (const entry of appEntries(catalog)) {
    const id = entry[terms.shortname];
    if (only && id !== only) continue;
    const version = entry[terms.version];
    const path = modulePath(id, version);
    if (!MODULE_PATH.test(path))
      throw new Error(`${id}: version ${version} cannot be a URL path segment`);
    const built = await buildApp(id, base);
    const blob = onMain.get(path);
    if (blob && blob !== blobId(built.bytes))
      throw new Error(
        `${id}: ${path} is published at ${published} with different bytes. ` +
          `Bump the version in ${versionFile(id, base)} and catalog.json first.`,
      );
    builds.push({ entry, id, version, path, ...built });
  }

  if (only && !builds.length)
    throw new Error(`${only} is not an app entry in catalog.json`);

  for (const { entry, id, version, path, bytes, integrity } of builds) {
    mkdirSync(dirname(resolve(base, path)), { recursive: true });
    writeFileSync(resolve(base, path), bytes);
    entry[terms.module] = moduleUrl(id, version);
    entry[terms.integrity] = integrity;
  }

  writeFileSync(catalogPath(base), `${JSON.stringify(catalog, null, 2)}\n`);

  return builds.map(({ path, bytes, integrity }) => ({
    path,
    bytes: bytes.length,
    integrity,
  }));
}

/** `--published <ref>`, else origin/main when it exists, else nothing. */
function publishedRef(args) {
  const at = args.indexOf('--published');

  if (at >= 0) {
    const ref = args[at + 1];
    if (!ref || !hasRef(ref))
      throw new Error(`--published ${ref ?? ''}: not a commit here`);
    args.splice(at, 2);

    return ref;
  }

  if (hasRef('origin/main')) return 'origin/main';
  console.warn(
    'apps: no origin/main here, so published versions are not compared',
  );

  return undefined;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'check') {
    const published = publishedRef(args);
    const problems = await check({ published });
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    console.info(
      `apps: ${appEntries(readCatalog()).length} app entr(y/ies) match their committed modules and builds` +
        (published ? `; no version published at ${published} changed` : ''),
    );
  } else if (command === 'write') {
    const published = publishedRef(args);
    for (const written of await write({ only: args[0], published }))
      console.info(JSON.stringify(written));
  } else {
    console.error(
      'usage: apps.mjs check [--published <ref>] | write [<id>] [--published <ref>]',
    );
    process.exit(2);
  }
}
