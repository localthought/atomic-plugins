/**
 * The shared ontology (ontola/atomic-plugins#177): build the published term
 * files, and check them.
 *
 * `ontology-kit/source.json` defines the terms, `ontology-kit/base.json` the
 * one base URL they are published under. `build` writes, from those two:
 *
 *   ontology/v<N>                     one release index (an Atomic Ontology)
 *   ontology/classes/<name>-v<N>      one Atomic Class per file
 *   ontology/properties/<shortname>   one Atomic Property per file
 *   ontology-kit/terms.mjs, terms.d.mts   the same subjects as constants
 *
 * The term files are JSON-AD with absolute subjects and no file extension:
 * GitHub Pages publishes `main` from the repository root, so
 * `ontology/classes/event-v1` is served at `<base>/classes/event-v1`, its own
 * subject (as `application/octet-stream`, which the host accepts: #177 spike
 * S1). They are committed, because Pages is a legacy build that serves
 * committed files.
 *
 *   node ontology-kit/ontology.mjs build
 *   node ontology-kit/ontology.mjs check [--published <ref>]   # CI
 *
 * `check` reports, and exits 1 on, any of:
 *   - a source problem (unknown datatype, a reference to an undefined term,
 *     a term in no release, ...);
 *   - a generated file that differs from a fresh build, or a stray file under
 *     ontology/;
 *   - a file under ontology/ that is published at `--published` (default
 *     origin/main when it exists) and was changed or deleted. The only
 *     allowed change is a base move: when base.json differs from the
 *     published one, a file may change by exactly that substitution;
 *   - the base URL written literally outside base.json and generated or
 *     built files (so a domain move stays one edit plus a rebuild);
 *   - while the base is on github.io, a catalog entry that references the
 *     ontology without `enabled: false` (see `gateProblems`).
 *
 * Node builtins and git only, like integrations/tooling/.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The folder Pages serves the terms from, relative to the repository root. */
export const TERMS_DIR = 'ontology';
export const KIT_DIR = 'ontology-kit';

const A = 'https://atomicdata.dev/';

export const atomic = {
  isA: `${A}properties/isA`,
  parent: `${A}properties/parent`,
  shortname: `${A}properties/shortname`,
  name: `${A}properties/name`,
  description: `${A}properties/description`,
  datatype: `${A}properties/datatype`,
  classtype: `${A}properties/classtype`,
  requires: `${A}properties/requires`,
  recommends: `${A}properties/recommends`,
  classes: `${A}properties/classes`,
  properties: `${A}properties/properties`,
  Class: `${A}classes/Class`,
  Property: `${A}classes/Property`,
  Ontology: `${A}class/ontology`,
};

/** The datatypes AtomicServer knows (browser/lib/src/datatypes.ts at the pin). */
export const DATATYPES = [
  'atomicURL',
  'boolean',
  'date',
  'float',
  'integer',
  'json',
  'markdown',
  'resourceArray',
  'slug',
  'string',
  'timestamp',
  'uri',
].map(d => `${A}datatypes/${d}`);

const LINK_DATATYPES = [
  `${A}datatypes/atomicURL`,
  `${A}datatypes/resourceArray`,
];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLASS_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/;
const RELEASE = /^v[1-9][0-9]*$/;
const ABSOLUTE = /^https:\/\/[^\s]+$/;

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

/**
 * The base URL from `base.json`: an absolute http(s) URL with no trailing
 * slash, query or fragment. Subjects are `<base>/<path>`.
 */
export function parseBase(value) {
  if (typeof value !== 'string')
    throw new Error('base.json: "base" must be a string');
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`base.json: "${value}" is not a URL`);
  }

  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error(`base.json: "${value}" must be http(s)`);
  const plain = url.href === value || url.href === `${value}/`;
  if (url.search || url.hash || value.endsWith('/') || !plain)
    throw new Error(
      `base.json: "${value}" must be a plain URL with no trailing slash, query or fragment`,
    );

  return value;
}

export const readBase = (base = root) =>
  parseBase(readJson(resolve(base, KIT_DIR, 'base.json')).base);

export const readSource = (base = root) =>
  readJson(resolve(base, KIT_DIR, 'source.json'));

/** The base without its scheme: what a bundle or a doc would contain. */
export const baseLiteral = ontologyBase =>
  ontologyBase.replace(/^https?:\/\//, '');

/** Whether terms under this base must stay out of enabled catalog entries. */
export const isTemporaryBase = ontologyBase =>
  new URL(ontologyBase).hostname.endsWith('.github.io');

export const subjects = ontologyBase => ({
  release: name => `${ontologyBase}/${name}`,
  klass: name => `${ontologyBase}/classes/${name}`,
  property: shortname => `${ontologyBase}/properties/${shortname}`,
});

/** Problems with source.json, independent of the base. */
export function sourceProblems(source) {
  const problems = [];
  const releases = source?.releases ?? {};
  const classes = source?.classes ?? {};
  const properties = source?.properties ?? {};

  const text = (what, value) => {
    if (typeof value !== 'string' || !value.trim())
      problems.push(`${what} needs a non-empty string`);
  };

  const propertyRef = (what, ref) => {
    if (ABSOLUTE.test(ref)) return;
    if (!Object.hasOwn(properties, ref))
      problems.push(
        `${what}: "${ref}" is neither a property defined here nor an absolute https URL`,
      );
  };

  const classRef = (what, ref) => {
    if (ABSOLUTE.test(ref)) return;
    if (!Object.hasOwn(classes, ref))
      problems.push(
        `${what}: "${ref}" is neither a class defined here nor an absolute https URL`,
      );
  };

  for (const [shortname, p] of Object.entries(properties)) {
    const at = `property ${shortname}`;
    if (!SLUG.test(shortname))
      problems.push(
        `${at}: shortname must be lowercase letters, digits and dashes`,
      );
    text(`${at}: name`, p.name);
    text(`${at}: description`, p.description);
    if (!DATATYPES.includes(p.datatype))
      problems.push(
        `${at}: datatype ${p.datatype} is not one AtomicServer knows`,
      );

    if (p.classtype !== undefined) {
      if (!LINK_DATATYPES.includes(p.datatype))
        problems.push(
          `${at}: classtype needs an atomicURL or resourceArray datatype`,
        );
      classRef(`${at}: classtype`, p.classtype);
    }
  }

  for (const [name, c] of Object.entries(classes)) {
    const at = `class ${name}`;
    if (!CLASS_NAME.test(name))
      problems.push(`${at}: a class name is a slug ending in -v<N>`);
    text(`${at}: name`, c.name);
    text(`${at}: description`, c.description);
    const requires = c.requires ?? [];
    const recommends = c.recommends ?? [];

    if (!Array.isArray(requires) || !Array.isArray(recommends)) {
      problems.push(`${at}: requires and recommends must be arrays`);
      continue;
    }

    for (const ref of [...requires, ...recommends]) propertyRef(at, ref);
    const all = [...requires, ...recommends];
    const dup = all.filter((ref, i) => all.indexOf(ref) !== i);
    if (dup.length)
      problems.push(`${at}: listed twice: ${[...new Set(dup)].join(', ')}`);
  }

  const released = { classes: new Set(), properties: new Set() };

  for (const [name, r] of Object.entries(releases)) {
    const at = `release ${name}`;
    if (!RELEASE.test(name)) problems.push(`${at}: a release is named v<N>`);
    text(`${at}: name`, r.name);
    text(`${at}: description`, r.description);
    const listed = new Set(r.properties ?? []);

    for (const c of r.classes ?? []) {
      released.classes.add(c);

      if (!Object.hasOwn(classes, c)) {
        problems.push(`${at}: lists class ${c}, which is not defined`);
        continue;
      }

      for (const ref of [
        ...(classes[c].requires ?? []),
        ...(classes[c].recommends ?? []),
      ])
        if (!ABSOLUTE.test(ref) && !listed.has(ref))
          problems.push(
            `${at}: class ${c} uses ${ref}, which the release does not list`,
          );
    }

    for (const p of r.properties ?? []) {
      released.properties.add(p);

      if (!Object.hasOwn(properties, p))
        problems.push(`${at}: lists property ${p}, which is not defined`);
      else {
        const t = properties[p].classtype;
        if (t && !ABSOLUTE.test(t) && !(r.classes ?? []).includes(t))
          problems.push(
            `${at}: property ${p} points at class ${t}, which the release does not list`,
          );
      }
    }
  }

  for (const c of Object.keys(classes))
    if (!released.classes.has(c)) problems.push(`class ${c} is in no release`);
  for (const p of Object.keys(properties))
    if (!released.properties.has(p))
      problems.push(`property ${p} is in no release`);

  return problems;
}

/** Release names in order: v1, v2, ... */
const releaseOrder = source =>
  Object.keys(source.releases).sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );

/** The first release that lists a term: its `parent`. */
function firstRelease(source, kind, name) {
  return releaseOrder(source).find(r =>
    (source.releases[r][kind] ?? []).includes(name),
  );
}

/** One JSON-AD document, as it is committed and served. */
export const render = resource => `${JSON.stringify(resource, null, 2)}\n`;

/**
 * Every file `build` writes, as a map from repository-relative path to its
 * text. Throws on a source problem.
 */
export function generate(source, ontologyBase) {
  const problems = sourceProblems(source);
  if (problems.length) throw new Error(problems.join('\n'));
  const s = subjects(ontologyBase);
  const ref = (kind, value) =>
    ABSOLUTE.test(value)
      ? value
      : kind === 'class'
        ? s.klass(value)
        : s.property(value);
  const files = new Map();

  for (const name of releaseOrder(source)) {
    const r = source.releases[name];
    files.set(
      `${TERMS_DIR}/${name}`,
      render({
        '@id': s.release(name),
        [atomic.isA]: [atomic.Ontology],
        [atomic.shortname]: `atomic-plugins-shared-${name}`,
        [atomic.name]: r.name,
        [atomic.description]: r.description,
        [atomic.classes]: (r.classes ?? []).map(c => s.klass(c)),
        [atomic.properties]: (r.properties ?? []).map(p => s.property(p)),
      }),
    );
  }

  for (const [name, c] of Object.entries(source.classes)) {
    const doc = {
      '@id': s.klass(name),
      [atomic.isA]: [atomic.Class],
      [atomic.parent]: s.release(firstRelease(source, 'classes', name)),
      [atomic.shortname]: name,
      [atomic.name]: c.name,
      [atomic.description]: c.description,
      [atomic.requires]: (c.requires ?? []).map(p => ref('property', p)),
    };
    if (c.recommends?.length)
      doc[atomic.recommends] = c.recommends.map(p => ref('property', p));
    files.set(`${TERMS_DIR}/classes/${name}`, render(doc));
  }

  for (const [shortname, p] of Object.entries(source.properties)) {
    const doc = {
      '@id': s.property(shortname),
      [atomic.isA]: [atomic.Property],
      [atomic.parent]: s.release(firstRelease(source, 'properties', shortname)),
      [atomic.shortname]: shortname,
      [atomic.name]: p.name,
      [atomic.description]: p.description,
      [atomic.datatype]: p.datatype,
    };
    if (p.classtype) doc[atomic.classtype] = ref('class', p.classtype);
    files.set(`${TERMS_DIR}/properties/${shortname}`, render(doc));
  }

  files.set(`${KIT_DIR}/terms.mjs`, termsModule(source, ontologyBase));
  files.set(`${KIT_DIR}/terms.d.mts`, termsTypes(source));

  return files;
}

const q = value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const key = name => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : q(name));

/**
 * terms.mjs is laid out the way oxfmt (browser/.oxfmtrc.json) formats it, so
 * CI's format check passes on the generated file: a property that doesn't
 * fit in WIDTH columns moves its value to the next line.
 */
const WIDTH = 80;

const field = (indent, name, value) => {
  const line = `${' '.repeat(indent)}${name}: ${value},`;

  return line.length <= WIDTH
    ? line
    : `${' '.repeat(indent)}${name}:\n${' '.repeat(indent + 2)}${value},`;
};

const HEADER =
  '// Generated by `node ontology-kit/ontology.mjs build` from\n' +
  '// ontology-kit/source.json and ontology-kit/base.json. Do not edit.\n';

/** terms.mjs: the subjects, for plugins to bundle (see README.md). */
function termsModule(source, ontologyBase) {
  const s = subjects(ontologyBase);
  const ref = value => (ABSOLUTE.test(value) ? value : s.property(value));
  const lines = [
    HEADER.trimEnd(),
    '',
    `export const BASE = ${q(ontologyBase)};`,
    '',
  ];

  lines.push('export const releases = Object.freeze({');
  for (const name of releaseOrder(source))
    lines.push(field(2, key(name), q(s.release(name))));
  lines.push('});', '');

  lines.push('export const properties = Object.freeze({');

  for (const [shortname, p] of Object.entries(source.properties)) {
    lines.push(`  ${key(shortname)}: Object.freeze({`);
    lines.push(field(4, 'subject', q(s.property(shortname))));
    lines.push(field(4, 'datatype', q(p.datatype)));
    if (p.classtype)
      lines.push(
        field(
          4,
          'classtype',
          q(ABSOLUTE.test(p.classtype) ? p.classtype : s.klass(p.classtype)),
        ),
      );
    lines.push('  }),');
  }

  lines.push('});', '');

  const list = (name, values) => {
    const items = values.map(v => q(ref(v)));
    const inline = `    ${name}: Object.freeze([${items.join(', ')}]),`;
    if (inline.length <= WIDTH) return [inline];

    return [
      `    ${name}: Object.freeze([`,
      ...items.map(item => `      ${item},`),
      '    ]),',
    ];
  };

  lines.push('export const classes = Object.freeze({');

  for (const [name, c] of Object.entries(source.classes)) {
    lines.push(`  ${key(name)}: Object.freeze({`);
    lines.push(field(4, 'subject', q(s.klass(name))));
    lines.push(...list('requires', c.requires ?? []));
    lines.push(...list('recommends', c.recommends ?? []));
    lines.push('  }),');
  }

  lines.push('});', '');

  return lines.join('\n');
}

/** terms.d.mts: the same shape, with the term names as literal keys. */
function termsTypes(source) {
  const lines = [
    HEADER.trimEnd(),
    '',
    "import type { SharedClass } from './resolver.mjs';",
    '',
    'export interface PropertyTerm {',
    '  readonly subject: string;',
    '  readonly datatype: string;',
    '  readonly classtype?: string;',
    '}',
    '',
    '/** The ontology base URL, from base.json at build time. */',
    'export declare const BASE: string;',
    '',
    'export declare const releases: {',
    ...releaseOrder(source).map(name => `  readonly ${key(name)}: string;`),
    '};',
    '',
    'export declare const properties: {',
    ...Object.keys(source.properties).map(
      p => `  readonly ${key(p)}: PropertyTerm;`,
    ),
    '};',
    '',
    'export declare const classes: {',
    ...Object.keys(source.classes).map(
      c => `  readonly ${key(c)}: SharedClass;`,
    ),
    '};',
    '',
  ];

  return lines.join('\n');
}

/** Every file under a directory, as repository-relative `/` paths. */
function filesUnder(dir, base) {
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

/**
 * Writes the generated files, and removes files under ontology/ that the
 * build no longer produces (which `check --published` then reports if they
 * were published).
 */
export function build({ base = root } = {}) {
  const files = generate(readSource(base), readBase(base));

  for (const stale of filesUnder(resolve(base, TERMS_DIR), base))
    if (!files.has(stale)) rmSync(resolve(base, stale));

  for (const [path, text] of files) {
    mkdirSync(dirname(resolve(base, path)), { recursive: true });
    writeFileSync(resolve(base, path), text);
  }

  return [...files.keys()];
}

/** Generated files that differ from a fresh build, and stray term files. */
export function freshnessProblems(base = root) {
  const files = generate(readSource(base), readBase(base));
  const problems = [];
  const fix =
    'run `node ontology-kit/ontology.mjs build` and commit the result';

  for (const [path, text] of files) {
    const file = resolve(base, path);
    if (!existsSync(file)) problems.push(`${path} is missing; ${fix}`);
    else if (readFileSync(file, 'utf8') !== text)
      problems.push(`${path} differs from a fresh build; ${fix}`);
  }

  for (const path of filesUnder(resolve(base, TERMS_DIR), base))
    if (!files.has(path))
      problems.push(
        `${path}: ${TERMS_DIR}/ holds only the build's term files (v<N>, classes/, properties/)`,
      );

  return problems;
}

const git = (base, args) =>
  execFileSync('git', ['-C', base, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export function hasRef(ref, base = root) {
  try {
    git(base, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

    return true;
  } catch {
    return false;
  }
}

export const blobId = bytes =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');

/** The files under ontology/ at `ref`, as a map from path to git blob id. */
export function publishedTerms(ref, base = root) {
  const published = new Map();

  for (const line of git(base, [
    'ls-tree',
    '-r',
    '-z',
    ref,
    '--',
    `${TERMS_DIR}/`,
  ])
    .split('\0')
    .filter(Boolean)) {
    const [meta, path] = line.split('\t');
    published.set(path, meta.split(' ')[2]);
  }

  return published;
}

/** base.json at `ref`, or undefined when it has none. */
function publishedBase(ref, base) {
  try {
    return parseBase(
      JSON.parse(git(base, ['show', `${ref}:${KIT_DIR}/base.json`])).base,
    );
  } catch {
    return undefined;
  }
}

/**
 * Published term files that the working tree changed or deleted. Servers
 * fetch a term once and keep it for ever (#177 spike S1), so a changed file
 * would never reach them; a change of meaning is a new term instead. The one
 * exception is a base move: when base.json changed, a file may differ from
 * its published bytes by exactly the old base replaced with the new one.
 */
export function publishedProblems(ref, base = root) {
  const problems = [];
  const oldBase = publishedBase(ref, base);
  const newBase = readBase(base);
  const moved = oldBase !== undefined && oldBase !== newBase;

  for (const [path, blob] of publishedTerms(ref, base)) {
    const file = resolve(base, path);

    if (!existsSync(file)) {
      problems.push(
        `${path} is published at ${ref} and was deleted. Published terms stay available: restore it.`,
      );
      continue;
    }

    const bytes = readFileSync(file);
    if (blobId(bytes) === blob) continue;

    if (moved) {
      const before = git(base, ['cat-file', 'blob', blob]);
      if (before.replaceAll(oldBase, newBase) === bytes.toString('utf8'))
        continue;
    }

    problems.push(
      `${path} is published at ${ref} and was changed. Published terms are immutable: restore it, and publish the change as a new term (a new property shortname, or <class>-v<N+1>).`,
    );
  }

  return problems;
}

/** Tracked and not-ignored untracked files, as repository-relative paths. */
function repositoryFiles(base) {
  return git(base, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
    .split('\0')
    .filter(Boolean)
    .filter(path => existsSync(resolve(base, path)));
}

/**
 * Where the base may be written literally: base.json, the generated files,
 * built bundles (which inline terms.mjs), and prose.
 */
export function mayContainBase(path) {
  return (
    path === `${KIT_DIR}/base.json` ||
    path === `${KIT_DIR}/terms.mjs` ||
    path.startsWith(`${TERMS_DIR}/`) ||
    path.startsWith('apps/') ||
    path.endsWith('/plugin.js') ||
    path.endsWith('.md')
  );
}

const readText = file => {
  const bytes = readFileSync(file);

  return bytes.includes(0) ? '' : bytes.toString('utf8');
};

/** Files that write the base literally where only base.json should. */
export function literalProblems(base = root) {
  const literal = baseLiteral(readBase(base));

  return repositoryFiles(base)
    .filter(path => !mayContainBase(path))
    .filter(path => readText(resolve(base, path)).includes(literal))
    .map(
      path =>
        `${path} contains the ontology base ${literal}; read it from ${KIT_DIR}/base.json or import ${KIT_DIR}/terms.mjs instead, so a domain move stays one edit`,
    );
}

const P = 'https://atomicdata.dev/integrations/properties/';
const catalogTerms = {
  shortname: 'https://atomicdata.dev/properties/shortname',
  enabled: `${P}enabled`,
  module: `${P}app-module`,
  version: `${P}version`,
};

/**
 * Catalog entries whose shortname is not their plugin folder's name. The
 * default match, shortname = `integrations/<folder>`, is the one
 * certify.mjs and catalog-requires.mjs use.
 */
export const ENTRY_FOLDERS = Object.freeze({
  'devonian-google-calendar': 'calendar',
});

const CODE = /\.(?:[cm]?[jt]sx?|json)$/;

/**
 * What in the repository ties a catalog entry to the ontology: the entry
 * itself, its committed drive app module, or code in its plugin folder that
 * contains the base or imports ontology-kit/.
 */
export function entryReferences(entry, files, base = root) {
  const literal = baseLiteral(readBase(base));
  const found = [];
  if (JSON.stringify(entry).includes(literal)) found.push('its catalog entry');
  const id = entry[catalogTerms.shortname];
  const version = entry[catalogTerms.version];

  if (typeof entry[catalogTerms.module] === 'string' && id && version) {
    const module = `apps/${id}/${version}/ui.js`;
    if (
      existsSync(resolve(base, module)) &&
      readText(resolve(base, module)).includes(literal)
    )
      found.push(module);
  }

  const folder = `integrations/${ENTRY_FOLDERS[id] ?? id}/`;

  for (const path of files) {
    if (!path.startsWith(folder) || !CODE.test(path)) continue;
    const text = readText(resolve(base, path));
    if (text.includes(literal) || text.includes(`${KIT_DIR}/`))
      found.push(path);
  }

  return found;
}

/**
 * The gate: while the base is on github.io, it is temporary (#177 §2.0), so
 * no drive outside tests may store its subjects. Every catalog entry that
 * references the ontology must therefore be `enabled: false`. The host's
 * `requires` can't express this: at the pin it ignores unknown tokens.
 */
export function gateProblems(base = root) {
  if (!isTemporaryBase(readBase(base))) return [];
  const catalogFile = resolve(base, 'integrations/catalog.json');
  if (!existsSync(catalogFile)) return [];
  const files = repositoryFiles(base);

  return readJson(catalogFile)
    .filter(entry => entry && typeof entry[catalogTerms.shortname] === 'string')
    .flatMap(entry => {
      if (entry[catalogTerms.enabled] === false) return [];
      const refs = entryReferences(entry, files, base);
      if (!refs.length) return [];

      return [
        `catalog entry ${entry[catalogTerms.shortname]} uses the ontology (${refs.join(', ')}) while its base ${readBase(base)} is on github.io, which is temporary: set "enabled": false until the stable ontology domain is in ${KIT_DIR}/base.json (see ${KIT_DIR}/README.md, "Gate")`,
      ];
    });
}

/** Everything `check` reports. */
export function check({ base = root, published } = {}) {
  const problems = sourceProblems(readSource(base));
  if (problems.length) return problems;
  problems.push(...freshnessProblems(base));
  if (published) problems.push(...publishedProblems(published, base));
  problems.push(...literalProblems(base), ...gateProblems(base));

  return problems;
}

function publishedRef(args) {
  const at = args.indexOf('--published');

  if (at >= 0) {
    const ref = args[at + 1];
    if (!ref || !hasRef(ref))
      throw new Error(`--published ${ref ?? ''}: not a commit here`);

    return ref;
  }

  if (hasRef('origin/main')) return 'origin/main';
  console.warn(
    'ontology: no origin/main here, so published terms are not compared',
  );

  return undefined;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'build') {
    for (const path of build()) console.info(path);
  } else if (command === 'check') {
    const published = publishedRef(args);
    const problems = check({ published });
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    console.info(
      `ontology: ${filesUnder(resolve(root, TERMS_DIR), root).length} term file(s) match a fresh build from ${readBase()}` +
        (published ? `; none published at ${published} changed` : ''),
    );
  } else {
    console.error('usage: ontology.mjs build | check [--published <ref>]');
    process.exit(2);
  }
}
