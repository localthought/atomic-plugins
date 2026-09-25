import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { P, run, handle, sha256, manifest } from './plugin.mjs';
const table = 'https://atomic.example/documents';
const document = (path = '/public/notes/a.txt', text = 'hello') => ({
  path,
  text,
  contentType: 'text/plain; charset=utf-8',
});

function fixture(documents = []) {
  const resources = new Map();
  let next = 0;
  const ctx = {
    config: { table, publicCategories: { notes: table } },
    query: (property, value) =>
      [...resources].filter(([, r]) => r[property] === value).map(([s]) => s),
    read: subject => {
      if (!resources.has(subject)) throw Error('Denied or absent');

      return resources.get(subject);
    },
  };
  const proposal = docs =>
    run({ ...ctx, upload: { text: JSON.stringify({ documents: docs }) } });

  // Fixture application is deliberately not evidence of real Atomic host persistence.
  function apply(verdict) {
    assert.deepEqual(verdict.problems, []);

    for (const intent of verdict.intents) {
      if (intent.op === 'create')
        resources.set(table + '/' + ++next, {
          [P.parent]: intent.parent,
          ...intent.set,
        });
      else Object.assign(resources.get(intent.subject), intent.set);
    }
  }

  apply(proposal(documents));

  return { ctx, resources, proposal, apply };
}

const request = (
  path = '/storage/public/notes/a.txt',
  headers = {},
  method = 'GET',
) => ({ path, headers, method });

test('SHA-256 matches independent standard implementation for Unicode and multiple blocks', () => {
  for (const text of [
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'x'.repeat(1000),
    'é 🌍\r\n',
  ])
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
});
test('import uses actual create intent shape and exact UTF-8 source in editable description atoms', () => {
  const f = fixture(),
    doc = document('/notes/a.txt', 'é\r\n🌍');
  const verdict = f.proposal([doc]),
    [intent] = verdict.intents;
  assert.deepEqual(verdict.problems, []);
  assert.equal(intent.op, 'create');
  assert.equal(intent.parent, table);
  assert.deepEqual(intent.isA, []);
  assert.equal(intent.set[P.baseline].text, doc.text);
  assert.equal(intent.set[P.content], doc.text);
});
test('idempotent import and source update target persistent Atomic identity', () => {
  const f = fixture([document()]);
  assert.deepEqual(f.proposal([document()]).intents, []);
  const update = f.proposal([document(undefined, 'changed')]);
  assert.equal(update.intents[0].op, 'set');
  assert.equal(update.intents[0].subject, [...f.resources.keys()][0]);
  f.apply(update);
  assert.equal(handle(f.ctx, request()).body, 'changed');
});
test('local text atom edits block overwrite and prevent serving stale baseline', () => {
  const f = fixture([document()]);
  [...f.resources.values()][0][P.content] = 'local edit';
  const result = f.proposal([document(undefined, 'remote edit')]);
  assert.deepEqual(result.intents, []);
  assert.match(result.problems[0].message, /Local document edits/);
  assert.equal(handle(f.ctx, request()).status, 503);
});
test('an error in a batch yields no partial import intents', () => {
  const f = fixture();

  for (const bad of [
    document('/notes/../a'),
    document('/notes/a%2fb'),
    { ...document('/notes/blob'), contentType: 'image/png' },
    { ...document('/notes/html'), contentType: 'text/html' },
    { ...document('/notes/a'), text: '\ud800' },
  ]) {
    const result = f.proposal([document(), bad]);
    assert.deepEqual(result.intents, []);
    assert.equal(result.problems[0].severity, 'error');
  }

  assert.equal(f.proposal([document(), document()]).problems.length, 1);
});
test('persistent file-folder collisions and duplicate identities fail closed', () => {
  const f = fixture([document('/public/notes/a')]);
  assert.equal(f.proposal([document('/public/notes/a/b')]).problems.length, 1);
  f.resources.set(table + '/dup', { ...[...f.resources.values()][0] });
  assert.equal(f.proposal([document('/public/notes/a')]).problems.length, 1);
  assert.equal(handle(f.ctx, request('/storage/public/notes/a')).status, 503);
});
test('public reads return exact document text, type and stable content ETag', () => {
  const f = fixture([document(undefined, 'é\r\n🌍')]),
    result = handle(f.ctx, request());
  assert.equal(result.status, 200);
  assert.equal(result.body, 'é\r\n🌍');
  assert.equal(result.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(result.headers.etag, /^"[a-f0-9]{64}"$/);
  const head = handle(f.ctx, request(undefined, {}, 'HEAD'));
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers.etag, result.headers.etag);
});
test('read preconditions distinguish strong and weak validators and missing resources', () => {
  const f = fixture([document()]),
    tag = handle(f.ctx, request()).headers.etag;
  for (const value of [tag, 'W/' + tag, '"other", ' + tag, '*'])
    assert.equal(
      handle(f.ctx, request(undefined, { 'If-None-Match': value })).status,
      304,
    );
  assert.equal(
    handle(f.ctx, request(undefined, { 'if-match': tag })).status,
    200,
  );
  for (const value of ['"old"', 'W/' + tag])
    assert.equal(
      handle(f.ctx, request(undefined, { 'if-match': value })).status,
      412,
    );
  assert.equal(
    handle(f.ctx, request('/storage/public/notes/missing', { 'if-match': '*' }))
      .status,
    412,
  );
  assert.equal(
    handle(f.ctx, request(undefined, { 'if-none-match': 'garbage' })).status,
    400,
  );
});
test('folder listings contain immediate children, UTF-8 size and recursively changing versions', () => {
  const f = fixture([
    document(undefined, 'é'),
    document('/public/notes/sub/b.txt'),
  ]);
  const result = handle(f.ctx, request('/storage/public/notes/')),
    body = JSON.parse(result.body);
  assert.equal(result.headers['content-type'], 'application/ld+json');
  assert.deepEqual(Object.keys(body.items), ['a.txt', 'sub/']);
  assert.equal(body.items['a.txt']['Content-Length'], 2);
  assert.equal(
    body['@context'],
    'http://remotestorage.io/spec/folder-description',
  );
  assert.equal(
    body.items['sub/'].ETag,
    handle(f.ctx, request('/storage/public/notes/sub/')).headers.etag.slice(
      1,
      -1,
    ),
  );
  f.apply(f.proposal([document('/public/notes/sub/b.txt', 'new')]));
  const changed = handle(f.ctx, request('/storage/public/notes/'));
  assert.notEqual(changed.headers.etag, result.headers.etag);
  assert.notEqual(
    JSON.parse(changed.body).items['sub/'].ETag,
    body.items['sub/'].ETag,
  );
  assert.deepEqual(
    JSON.parse(handle(f.ctx, request('/storage/public/notes/absent/')).body)
      .items,
    {},
  );
});
test('category, private data, parent and host permissions remain independent bounds', () => {
  const f = fixture([
    document(),
    document('/notes/private'),
    document('/public/other/secret'),
  ]);
  assert.equal(
    handle(f.ctx, request('/storage/public/other/secret')).status,
    404,
  );
  assert.equal(handle(f.ctx, request('/storage/notes/private')).status, 401);
  assert.equal(
    handle(f.ctx, request('/storage/public/notes/private')).status,
    404,
  );
  assert.equal(
    handle(
      {
        ...f.ctx,
        read: () => {
          throw Error('private key in error');
        },
      },
      request(),
    ).status,
    503,
  );
  assert.doesNotMatch(
    handle(
      {
        ...f.ctx,
        read: () => {
          throw Error('private key in error');
        },
      },
      request(),
    ).body,
    /private key/,
  );
  const alien = {
    [P.parent]: 'https://elsewhere.example/private',
    ...[...f.resources.values()][0],
  };
  alien[P.parent] = 'https://elsewhere.example/private';
  assert.equal(handle({ ...f.ctx, read: () => alien }, request()).status, 404);
});
test('writes are neither registered nor executed, with no unauthenticated fallback', () => {
  const f = fixture([document()]);
  for (const method of ['PUT', 'DELETE', 'POST', 'PATCH'])
    assert.equal(handle(f.ctx, request(undefined, {}, method)).status, 405);
  assert.deepEqual(manifest.http.routes[0].methods, ['GET', 'HEAD']);
  assert.equal(manifest.http.routes[0].principal, 'anonymous');
  assert.equal(manifest.http.routes[0].cors, 'any-origin-no-credentials');
});
test('path validation refuses traversal and encoded separators but supports Unicode URL encoding', () => {
  const f = fixture([document('/public/notes/é.txt')]);
  assert.equal(
    handle(f.ctx, request('/storage/public/notes/%C3%A9.txt')).status,
    200,
  );
  for (const suffix of [
    '../secret',
    '%2e%2e/secret',
    'a%2Fb',
    'a%5Cb',
    '%252e%252e/secret',
    'a//b',
    'bad%GG',
  ])
    assert.equal(
      handle(f.ctx, request('/storage/public/notes/' + suffix)).status,
      400,
      suffix,
    );
});
test('unsafe JSON object member names survive folder serialization as ordinary keys', () => {
  const f = fixture([document('/public/notes/__proto__')]);
  const items = JSON.parse(
    handle(f.ctx, request('/storage/public/notes/')).body,
  ).items;
  assert.equal(Object.hasOwn(items, '__proto__'), true);
});
test('bundle is deterministic, self-contained and executable without Node host APIs', async () => {
  execFileSync(process.execPath, [
    new URL('./build.mjs', import.meta.url).pathname,
    '--check',
  ]);
  const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(
    source,
    /\b(?:require\(|Buffer\.|fetch\(|process\.|crypto\.)/,
  );
  const bundle = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  assert.equal(bundle.sha256('abc'), sha256('abc'));
  assert.equal(bundle.handle(fixture([document()]).ctx, request()).status, 200);
});

test('canonical Atomic parents and resource IDs support imports, updates and public reads', () => {
  const parent = 'atomic:' + Buffer.alloc(64, 1).toString('base64');
  const subject = 'atomic:' + Buffer.alloc(64, 2).toString('base64');
  const f = fixture();
  f.ctx.config = { table: parent, publicCategories: { notes: parent } };
  const created = f.proposal([document()]);
  assert.deepEqual(created.problems, []);
  assert.equal(created.intents[0].parent, parent);
  f.resources.set(subject, { [P.parent]: parent, ...created.intents[0].set });
  assert.equal(handle(f.ctx, request()).body, 'hello');
  assert.deepEqual(f.proposal([document()]).intents, []);
  assert.equal(
    f.proposal([document(undefined, 'changed')]).intents[0].subject,
    subject,
  );
});

test('empty, legacy-link and control-containing parent subjects are refused', () => {
  for (const parent of [
    'atomic:',
    'atomic:?drive=x',
    'atomic://host/path',
    'atomic:bad\nvalue',
    'did:ad:',
    'https://',
  ]) {
    const f = fixture();
    f.ctx.config = { table: parent, publicCategories: { notes: parent } };
    assert.match(
      f.proposal([document()]).problems[0].message,
      /parent subject/,
    );
    assert.equal(handle(f.ctx, request()).status, 503);
  }
});

test('import baselines carry source values and the observed previous values for host commit checks', () => {
  const f = fixture();
  const first = f.proposal([document()]);
  const source = { [P.name]: 'a.txt', [P.content]: 'hello' };
  assert.deepEqual(first.intents[0].set[P.baseline].values, source);
  assert.deepEqual(first.intents[0].set[P.baseline].previous, {});
  f.apply(first);
  const update = f.proposal([document(undefined, 'second')]);
  assert.deepEqual(update.intents[0].set[P.baseline].previous, source);
  assert.deepEqual(update.intents[0].set[P.baseline].values, {
    ...source,
    [P.content]: 'second',
  });
  f.apply(update);
  assert.deepEqual(f.proposal([document(undefined, 'second')]).intents, []);
  const third = f.proposal([document(undefined, 'third')]);
  assert.deepEqual(
    third.intents[0].set[P.baseline].previous,
    update.intents[0].set[P.baseline].values,
  );
  // A held preview keeps the original source snapshot so the host can reject
  // it if another import updates the baseline before Apply.
  assert.deepEqual(update.intents[0].set[P.baseline].previous, source);
});

test('local name edits and malformed legacy source baselines require review', () => {
  for (const mutate of [
    row => {
      row[P.name] = 'local title';
    },
    row => {
      delete row[P.baseline].values;
    },
    row => {
      row[P.baseline].values[P.content] = 'tampered';
    },
  ]) {
    const f = fixture([document()]);
    mutate([...f.resources.values()][0]);
    const result = f.proposal([document(undefined, 'remote update')]);
    assert.deepEqual(result.intents, []);
    assert.match(result.problems[0].message, /review/);
  }
});
