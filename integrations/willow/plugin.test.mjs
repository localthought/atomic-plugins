import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');
const {
  run,
  exportCandidate,
  checkCandidate,
  william3,
  hex,
  utf8,
  P,
  manifest,
  decodeEntry,
} = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
const s = 'https://atomic.example/source',
  out = 'https://atomic.example/candidates',
  title = P.name;

function fixture() {
  const config = {
    subjects: [s],
    properties: [title],
    outputParent: out,
    namespace: '01'.repeat(32),
    subspace: '02'.repeat(32),
    pathPrefix: ['61746f6d6963'],
    timestamp: '1',
  };
  const resources = new Map([
    [
      s,
      {
        [title]: 'Hello 🌿',
        'https://atomic.example/secret': 'must not export',
      },
    ],
  ]);
  const ctx = {
    config,
    read: id => {
      if (!resources.has(id)) throw Error('Denied');

      return resources.get(id);
    },
    query: (property, value) =>
      [...resources].filter(([, r]) => r[property] === value).map(([id]) => id),
  };

  const apply = verdict => {
    assert.deepEqual(verdict.problems, []);
    for (const i of verdict.intents)
      if (i.op === 'create')
        resources.set(out + '/candidate', { [P.parent]: i.parent, ...i.set });
      else Object.assign(resources.get(i.subject), i.set);
  };

  return { ctx, resources, apply };
}

test('WILLIAM3 default digest agrees with the Willow25 published vector', () => {
  assert.equal(
    hex(william3(new Uint8Array())),
    '96d34c5478458231e364767952aaea02a31d2203c66f4365692ef91f351068d2',
  );
});
test('actual Atomic read adapter exports selected properties only and exact signing bytes', () => {
  const f = fixture(),
    candidate = exportCandidate(f.ctx, f.ctx.config, s);
  const payload = JSON.parse(Buffer.from(candidate.payload).toString());
  assert.deepEqual(payload, { '@id': s, [title]: 'Hello 🌿' });
  assert.doesNotMatch(
    Buffer.from(candidate.payload).toString(),
    /must not export/,
  );
  assert.deepEqual(
    checkCandidate(candidate.entryBytes, candidate.payload),
    candidate.entry,
  );
  assert.equal(candidate.entry.payloadLength, BigInt(candidate.payload.length));
  assert.equal(hex(candidate.entry.path.at(-1)), hex(utf8(s)));
});
test('candidate integrity check refuses mutated payload, length and noncanonical entry bytes', () => {
  const f = fixture(),
    c = exportCandidate(f.ctx, f.ctx.config, s),
    bad = c.payload.slice();
  bad[0] ^= 1;
  assert.throws(() => checkCandidate(c.entryBytes, bad), /digest/);
  assert.throws(
    () => checkCandidate(c.entryBytes, c.payload.slice(1)),
    /length/,
  );
  assert.throws(() =>
    checkCandidate(Uint8Array.from([...c.entryBytes, 0]), c.payload),
  );
});
test('run creates ordinary reviewed Atomic resource intents, never authorisations or public routes', () => {
  const f = fixture(),
    verdict = run(f.ctx),
    [intent] = verdict.intents;
  assert.deepEqual(verdict.problems, []);
  assert.equal(intent.op, 'create');
  assert.equal(intent.parent, out);
  assert.deepEqual(intent.isA, []);
  assert.equal(intent.set[P.baseline].status, 'unsigned');
  assert.equal(
    JSON.parse(intent.set[P.description]).entryHex,
    intent.set[P.baseline].entryHex,
  );
  assert.equal(manifest.http, undefined);
  assert.deepEqual(manifest.secrets, []);
});
test('reruns reuse stored candidate identity and changes require an increased logical timestamp', () => {
  const f = fixture();
  f.apply(run(f.ctx));
  assert.deepEqual(run(f.ctx).intents, []);
  f.resources.get(s)[title] = 'Changed';
  assert.match(run(f.ctx).problems[0].message, /Increase logical timestamp/);
  f.ctx.config.timestamp = '2';
  const changed = run(f.ctx);
  assert.equal(changed.intents[0].op, 'set');
  f.apply(changed);
  assert.equal(
    decodeEntry(
      Buffer.from(
        f.resources.get(out + '/candidate')[P.baseline].entryHex,
        'hex',
      ),
    ).timestamp,
    2n,
  );
});
test('local candidate edits, duplicate identities and denied source reads yield no effects', () => {
  const f = fixture();
  f.apply(run(f.ctx));
  f.resources.get(out + '/candidate')[P.description] = 'manual edit';
  assert.deepEqual(run(f.ctx).intents, []);
  assert.match(run(f.ctx).problems[0].message, /Local candidate edits/);
  const g = fixture();

  g.ctx.read = () => {
    throw Error('Denied');
  };

  assert.deepEqual(run(g.ctx).intents, []);
  assert.throws(
    () => exportCandidate(f.ctx, f.ctx.config, 'https://atomic.example/other'),
    /not approved/,
  );
});
test('batch failure is all-or-nothing at proposal time and property selection fails closed', () => {
  const f = fixture();
  f.ctx.config.subjects.push('https://atomic.example/missing');
  assert.deepEqual(run(f.ctx).intents, []);
  f.ctx.config.subjects = [s];
  f.ctx.config.properties = [];
  assert.equal(run(f.ctx).problems.length, 1);
  f.ctx.config.properties = [title];
  f.resources.get(s)[title] = 'x'.repeat(65536);
  assert.equal(run(f.ctx).problems.length, 1);
});
test('u64 timestamps are never rounded to JavaScript numbers', () => {
  const f = fixture();
  f.ctx.config.timestamp = '18446744073709551615';
  assert.equal(
    exportCandidate(f.ctx, f.ctx.config, s).entry.timestamp,
    18446744073709551615n,
  );

  for (const value of ['18446744073709551616', '-1', '1e3', '01', 1]) {
    f.ctx.config.timestamp = value;
    assert.equal(run(f.ctx).problems.length, 1);
  }
});
test('bundle reproduces from current codec, plugin and shared WILLIAM3 source', () => {
  execFileSync(process.execPath, [
    new URL('./build.mjs', import.meta.url).pathname,
    '--check',
  ]);
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\b(?:fetch\(|Buffer\.|process\.|require\()/);
});

test('canonical Atomic parent and source IDs produce valid export candidates', () => {
  const f = fixture();
  const subject = 'atomic:' + Buffer.alloc(64, 1).toString('base64');
  const parent = 'atomic:' + Buffer.alloc(64, 2).toString('base64');
  f.resources.set(subject, f.resources.get(s));
  f.ctx.config.subjects = [subject];
  f.ctx.config.outputParent = parent;
  const verdict = run(f.ctx);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.intents[0].parent, parent);
  const candidate = exportCandidate(f.ctx, f.ctx.config, subject);
  assert.equal(
    JSON.parse(Buffer.from(candidate.payload).toString())['@id'],
    subject,
  );
});

test('empty, legacy-link and control-containing Atomic subjects are refused', () => {
  for (const subject of [
    'atomic:',
    'atomic:?drive=x',
    'atomic://host/path',
    'atomic:bad\nvalue',
    'did:ad:',
    'https://',
  ]) {
    const f = fixture();
    f.ctx.config.outputParent = subject;
    assert.deepEqual(run(f.ctx).intents, []);
    assert.ok(run(f.ctx).problems.length);
    f.ctx.config.outputParent = out;
    f.ctx.config.subjects = [subject];
    assert.deepEqual(run(f.ctx).intents, []);
    assert.ok(run(f.ctx).problems.length);
  }
});
