import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  atomic,
  build,
  check,
  freshnessProblems,
  gateProblems,
  generate,
  literalProblems,
  parseBase,
  publishedProblems,
  readBase,
  readSource,
  root,
  sourceProblems,
} from './ontology.mjs';

const BASE = 'https://vocab.example/ontology';
const PAGES = 'https://someone.github.io/repo/ontology';
const NAME = 'https://atomicdata.dev/properties/name';
const STRING = 'https://atomicdata.dev/datatypes/string';

const source = () => ({
  releases: {
    v1: {
      name: 'Release 1',
      description: 'The first release.',
      classes: ['thing-v1'],
      properties: ['colour', 'owner'],
    },
  },
  classes: {
    'thing-v1': {
      name: 'Thing',
      description: 'A thing.',
      requires: [NAME],
      recommends: ['colour', 'owner'],
    },
  },
  properties: {
    colour: { name: 'Colour', description: 'Its colour.', datatype: STRING },
    owner: {
      name: 'Owner',
      description: 'Who owns it.',
      datatype: 'https://atomicdata.dev/datatypes/atomicURL',
      classtype: 'thing-v1',
    },
  },
});

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const put = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

/** A repository with the fixture ontology built and committed as `main`. */
function repository({ base = BASE, catalog } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-ontology-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  put(dir, 'ontology-kit/base.json', `${JSON.stringify({ base })}\n`);
  put(
    dir,
    'ontology-kit/source.json',
    `${JSON.stringify(source(), null, 2)}\n`,
  );
  if (catalog) put(dir, 'integrations/catalog.json', JSON.stringify(catalog));
  build({ base: dir });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'publish');

  return dir;
}

const using = (options, run) => {
  const dir = repository(options);

  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('parseBase takes a plain http(s) URL without a trailing slash', () => {
  assert.equal(parseBase(BASE), BASE);
  for (const bad of [
    `${BASE}/`,
    `${BASE}?x=1`,
    `${BASE}#x`,
    'ftp://vocab.example/o',
    'not a url',
    42,
  ])
    assert.throws(() => parseBase(bad), /base\.json/);
});

test('the fixture source has no problems', () => {
  assert.deepEqual(sourceProblems(source()), []);
});

test('sourceProblems finds bad datatypes, references and releases', () => {
  const s = source();
  s.properties.colour.datatype = 'https://atomicdata.dev/datatypes/colour';
  s.properties.size = { name: 'Size', description: 'x', datatype: STRING };
  s.classes['thing-v1'].recommends.push('weight');
  s.classes.Other = { name: 'O', description: 'o', requires: [] };
  s.properties.owner.classtype = 'nothing-v1';
  s.releases.v1.classes.push('ghost-v1');
  const problems = sourceProblems(s).join('\n');
  assert.match(problems, /colour: datatype .* is not one AtomicServer knows/);
  assert.match(problems, /property size is in no release/);
  assert.match(problems, /"weight" is neither a property defined here/);
  assert.match(problems, /class Other: a class name is a slug ending in -v<N>/);
  assert.match(problems, /class Other is in no release/);
  assert.match(problems, /owner: classtype: "nothing-v1" is neither a class/);
  assert.match(problems, /lists class ghost-v1, which is not defined/);
  assert.match(problems, /class thing-v1 uses weight, which the release/);
});

test('sourceProblems wants classtype only on link datatypes, and no duplicates', () => {
  const s = source();
  s.properties.colour.classtype = 'thing-v1';
  s.classes['thing-v1'].requires.push('colour');
  const problems = sourceProblems(s).join('\n');
  assert.match(
    problems,
    /colour: classtype needs an atomicURL or resourceArray/,
  );
  assert.match(problems, /thing-v1: listed twice: colour/);
});

test('generate writes JSON-AD terms with absolute subjects under the base', () => {
  const files = generate(source(), BASE);
  assert.deepEqual([...files.keys()].sort(), [
    'ontology-kit/terms.d.mts',
    'ontology-kit/terms.mjs',
    'ontology/classes/thing-v1',
    'ontology/properties/colour',
    'ontology/properties/owner',
    'ontology/v1',
  ]);
  const thing = JSON.parse(files.get('ontology/classes/thing-v1'));
  assert.equal(thing['@id'], `${BASE}/classes/thing-v1`);
  assert.deepEqual(thing[atomic.isA], [atomic.Class]);
  assert.equal(thing[atomic.parent], `${BASE}/v1`);
  assert.deepEqual(thing[atomic.requires], [NAME]);
  assert.deepEqual(thing[atomic.recommends], [
    `${BASE}/properties/colour`,
    `${BASE}/properties/owner`,
  ]);
  const owner = JSON.parse(files.get('ontology/properties/owner'));
  assert.equal(owner[atomic.classtype], `${BASE}/classes/thing-v1`);
  assert.deepEqual(owner[atomic.isA], [atomic.Property]);
  const release = JSON.parse(files.get('ontology/v1'));
  assert.deepEqual(release[atomic.isA], [atomic.Ontology]);
  assert.deepEqual(release[atomic.classes], [`${BASE}/classes/thing-v1`]);
  assert.ok(files.get('ontology/v1').endsWith('}\n'));
});

test('a term keeps the release that first listed it as its parent', () => {
  const s = source();
  s.releases.v2 = {
    name: 'Release 2',
    description: 'Adds a class.',
    classes: ['thing-v1', 'thing-v2'],
    properties: ['colour', 'owner'],
  };
  s.classes['thing-v2'] = {
    name: 'Thing',
    description: 'A thing, v2.',
    requires: [NAME, 'colour'],
  };
  const files = generate(s, BASE);
  assert.equal(
    JSON.parse(files.get('ontology/classes/thing-v1'))[atomic.parent],
    `${BASE}/v1`,
  );
  assert.equal(
    JSON.parse(files.get('ontology/classes/thing-v2'))[atomic.parent],
    `${BASE}/v2`,
  );
  assert.equal(
    JSON.parse(files.get('ontology/classes/thing-v2'))[atomic.recommends],
    undefined,
  );
});

test('generate refuses a source with problems', () => {
  const s = source();
  delete s.properties.colour.datatype;
  assert.throws(() => generate(s, BASE), /colour: datatype/);
});

test('the generated terms.mjs exports the same subjects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-ontology-terms-'));

  try {
    writeFileSync(
      join(dir, 'terms.mjs'),
      generate(source(), BASE).get('ontology-kit/terms.mjs'),
    );
    const terms = await import(pathToFileURL(join(dir, 'terms.mjs')).href);
    assert.equal(terms.BASE, BASE);
    assert.equal(terms.releases.v1, `${BASE}/v1`);
    assert.deepEqual(terms.properties.owner, {
      subject: `${BASE}/properties/owner`,
      datatype: 'https://atomicdata.dev/datatypes/atomicURL',
      classtype: `${BASE}/classes/thing-v1`,
    });
    assert.deepEqual(terms.classes['thing-v1'], {
      subject: `${BASE}/classes/thing-v1`,
      requires: [NAME],
      recommends: [`${BASE}/properties/colour`, `${BASE}/properties/owner`],
    });
    assert.ok(Object.isFrozen(terms.classes['thing-v1'].requires));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh repository checks clean against its own main', () =>
  using({}, dir => {
    assert.deepEqual(check({ base: dir, published: 'main' }), []);
  }));

test('freshness: an edited generated file or a stray term file is reported', () =>
  using({}, dir => {
    put(dir, 'ontology/properties/colour', '{}\n');
    put(dir, 'ontology/properties/stray', '{}\n');
    const problems = freshnessProblems(dir).join('\n');
    assert.match(
      problems,
      /ontology\/properties\/colour differs from a fresh build/,
    );
    assert.match(
      problems,
      /ontology\/properties\/stray: ontology\/ holds only/,
    );
  }));

test('a published term file may not change or disappear', () =>
  using({}, dir => {
    const s = source();
    s.properties.colour.description = 'Changed meaning.';
    put(dir, 'ontology-kit/source.json', JSON.stringify(s));
    build({ base: dir });
    rmSync(join(dir, 'ontology/properties/owner'));
    const problems = publishedProblems('main', dir).join('\n');
    assert.match(
      problems,
      /ontology\/properties\/colour is published at main and was changed/,
    );
    assert.match(
      problems,
      /ontology\/properties\/owner is published at main and was deleted/,
    );
  }));

test('build removes term files the source no longer produces, which check reports', () =>
  using({}, dir => {
    const s = source();
    s.releases.v1.properties = ['colour'];
    s.classes['thing-v1'].recommends = ['colour'];
    delete s.properties.owner;
    put(dir, 'ontology-kit/source.json', JSON.stringify(s));
    build({ base: dir });
    assert.match(
      check({ base: dir, published: 'main' }).join('\n'),
      /ontology\/properties\/owner is published at main and was deleted/,
    );
  }));

test('a new term next to published ones is fine', () =>
  using({}, dir => {
    const s = source();
    s.properties.size = {
      name: 'Size',
      description: 'Size.',
      datatype: STRING,
    };
    s.releases.v2 = {
      name: 'Release 2',
      description: 'Adds size.',
      classes: [],
      properties: ['size'],
    };
    put(dir, 'ontology-kit/source.json', JSON.stringify(s));
    build({ base: dir });
    assert.deepEqual(check({ base: dir, published: 'main' }), []);
  }));

test('a base move may rewrite published files, by exactly that substitution', () =>
  using({}, dir => {
    const moved = 'https://vocab.example.org/ontology';
    put(dir, 'ontology-kit/base.json', JSON.stringify({ base: moved }));
    build({ base: dir });
    assert.deepEqual(publishedProblems('main', dir), []);
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'ontology/classes/thing-v1'), 'utf8'))[
        '@id'
      ],
      `${moved}/classes/thing-v1`,
    );

    // ...but not with a change of meaning mixed in.
    const s = source();
    s.properties.colour.name = 'Color';
    put(dir, 'ontology-kit/source.json', JSON.stringify(s));
    build({ base: dir });
    assert.match(
      publishedProblems('main', dir).join('\n'),
      /ontology\/properties\/colour is published at main and was changed/,
    );
  }));

test('the base may be written literally only in base.json, generated files, bundles and prose', () =>
  using({}, dir => {
    const literal = 'vocab.example/ontology';
    put(
      dir,
      'integrations/x/app/main.ts',
      `const c = 'https://${literal}/x';\n`,
    );
    put(dir, 'integrations/x/README.md', `See https://${literal}.\n`);
    put(dir, 'integrations/x/plugin.js', `"https://${literal}"\n`);
    put(dir, 'apps/x/1.0.0/ui.js', `"https://${literal}"\n`);
    assert.deepEqual(
      literalProblems(dir).map(p => p.split(' ')[0]),
      ['integrations/x/app/main.ts'],
    );
  }));

const entry = (shortname, extra = {}) => ({
  'https://atomicdata.dev/properties/shortname': shortname,
  ...extra,
});
const ENABLED = 'https://atomicdata.dev/integrations/properties/enabled';

test('gate: while the base is on github.io, an entry using the ontology must be disabled', () =>
  using(
    {
      base: PAGES,
      catalog: [
        entry('uses', { [ENABLED]: true }),
        entry('uses-off', { [ENABLED]: false }),
        entry('unrelated', { [ENABLED]: true }),
        entry('devonian-google-calendar', { [ENABLED]: true }),
        entry('in-entry', { [ENABLED]: true, x: `${PAGES}/classes/thing-v1` }),
        entry('omitted'),
      ],
    },
    dir => {
      const kit =
        "import { classes } from '../../../ontology-kit/terms.mjs';\n";
      put(dir, 'integrations/uses/app/view.ts', kit);
      put(dir, 'integrations/uses-off/app/view.ts', kit);
      put(dir, 'integrations/unrelated/app/view.ts', 'export {};\n');
      put(dir, 'integrations/unrelated/README.md', 'See ontology-kit/.\n');
      put(dir, 'integrations/calendar/app/view.ts', kit);
      put(dir, 'integrations/omitted/app/view.ts', kit);
      const problems = gateProblems(dir);
      assert.deepEqual(
        problems.map(p => p.split(' ')[2]),
        ['uses', 'devonian-google-calendar', 'in-entry', 'omitted'],
      );
      assert.match(problems[0], /integrations\/uses\/app\/view\.ts/);
      assert.match(problems[0], /set "enabled": false/);
    },
  ));

test('gate: a base off github.io lets entries be enabled', () =>
  using({ catalog: [entry('uses', { [ENABLED]: true })] }, dir => {
    put(
      dir,
      'integrations/uses/app/view.ts',
      "import '../../../ontology-kit/terms.mjs';\n",
    );
    assert.deepEqual(gateProblems(dir), []);
  }));

test('this repository: the committed ontology matches a fresh build', () => {
  assert.deepEqual(freshnessProblems(root), []);
  assert.deepEqual(sourceProblems(readSource(root)), []);
  assert.deepEqual(literalProblems(root), []);
  assert.deepEqual(gateProblems(root), []);
});

test('this repository: the four shared classes reuse the host terms #177 names', async () => {
  const { classes, properties } = await import('./terms.mjs');
  const base = readBase(root);
  const task = 'https://atomicdata.dev/task/v1/';

  for (const name of [
    'event-v1',
    'issue-v1',
    'time-entry-v1',
    'bank-transaction-v1',
  ])
    assert.equal(classes[name].subject, `${base}/classes/${name}`);

  assert.deepEqual(classes['issue-v1'].recommends, [
    `${task}status`,
    `${task}body`,
    `${task}assignee`,
    `${task}due-date`,
  ]);
  assert.deepEqual(classes['event-v1'].requires, [
    NAME,
    properties['atomic-calendar-day'].subject,
  ]);
  assert.deepEqual(classes['time-entry-v1'].requires, [
    properties['work-start'].subject,
  ]);
  assert.equal(
    properties['work-project'].classtype,
    classes['work-project-v1'].subject,
  );
  assert.deepEqual(classes['bank-transaction-v1'].requires, [
    properties['bank-account'].subject,
    properties['bank-currency'].subject,
    properties['bank-amount'].subject,
    properties['bank-value-date'].subject,
  ]);
});
