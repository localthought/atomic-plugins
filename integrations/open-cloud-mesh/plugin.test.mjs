import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { handle, parseShare, run, P, origin } from './plugin.mjs';
const doc = 'https://atomic.example/docs/project';
const peer = 'https://cloud.example';
const share = {
  name: 'Design.md',
  providerId: 'share-123',
  owner: 'alice@cloud.example',
  sender: 'alice@cloud.example',
  shareWith: 'bob@atomic.example',
  shareType: 'user',
  resourceType: 'file',
  protocol: {
    name: 'multi',
    webdav: {
      uri: 'remote.php/dav/share-123',
      permissions: ['read'],
      sharedSecret: 'DO-NOT-PERSIST',
    },
  },
};

function host(config = {}, rows = {}) {
  return {
    config: {
      publicOrigin: 'https://atomic.example',
      mode: 'import-reviewed-share',
      peerOrigin: peer,
      allowedPeers: { [peer]: true },
      recipient: share.shareWith,
      document: doc,
      shareJson: JSON.stringify(share),
      ...config,
    },
    read(s) {
      return (
        rows[s] ??
        (s === doc
          ? { [P.isA]: ['https://atomicdata.dev/classes/DocumentV2'] }
          : undefined)
      );
    },
    query(p, value) {
      return Object.keys(rows).filter(s => rows[s][p] === value);
    },
  };
}

function fail(c, re, rows) {
  const result = run(host(c, rows));
  assert.deepEqual(result.intents, []);
  assert.equal(result.problems[0].severity, 'error');
  assert.match(result.problems[0].message, re);
}

test('disabled discovery is explicit and never advertises unsupported file exchange', () => {
  const result = handle(host(), { method: 'GET', path: '/ocm-provider' });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), {
    enabled: false,
    apiVersion: '1.3.0',
    endPoint: 'https://atomic.example/ocm',
    resourceTypes: [],
  });
  assert.equal(
    handle(host(), { method: 'HEAD', path: '/ocm-provider' }).body,
    '',
  );
  assert.equal(
    handle(host({ publicOrigin: '' }), { method: 'GET', path: '/ocm-provider' })
      .status,
    503,
  );
});
test('receive fails closed even with invented caller and malicious payload', () => {
  const result = handle(host(), {
    method: 'POST',
    path: '/ocm/shares',
    caller: 'admin',
    body: JSON.stringify(share),
  });
  assert.equal(result.status, 501);
  assert.equal(result.intents, undefined);
  assert.equal(
    handle(host(), { method: 'GET', path: '/ocm/shares' }).status,
    405,
  );
  assert.equal(handle(host(), { method: 'GET', path: '/other' }).status, 404);
});
test('protocol parser drops WebDAV credentials and locations, preserves exact expiration', () => {
  const parsed = parseShare(
    JSON.stringify({ ...share, expiration: 1800000000 }),
  );
  assert.equal(parsed.expiration, '1800000000');
  assert.deepEqual(parsed.permissions, ['read']);
  assert.ok(!JSON.stringify(parsed).includes('DO-NOT-PERSIST'));
  assert.ok(!JSON.stringify(parsed).includes('remote.php'));
});
test('reviewed import produces native Message about the existing document', () => {
  const result = run(host());
  assert.deepEqual(result.problems, []);
  const intent = result.intents[0];
  assert.equal(intent.op, 'create');
  assert.equal(intent.parent, doc);
  assert.equal(intent.set[P.about], doc);
  assert.deepEqual(intent.isA, ['https://atomicdata.dev/classes/Message']);
  assert.equal(intent.set[P.name], 'OCM share: Design.md');
  assert.ok(!JSON.stringify(result).includes('DO-NOT-PERSIST'));
  assert.ok(!JSON.stringify(result).includes('documentContent'));
});
test('durable duplicate is a no-op across fresh runs; modifications conflict', () => {
  const intent = run(host()).intents[0];
  const row = { ...intent.set, [P.parent]: intent.parent, [P.isA]: intent.isA };
  assert.deepEqual(run(host({}, { receipt: row })), {
    intents: [],
    problems: [],
  });
  fail(
    { shareJson: JSON.stringify({ ...share, name: 'Changed' }) },
    /conflicts/,
    { receipt: row },
  );
  fail({}, /conflicts/, {
    receipt: { ...row, [P.about]: 'https://atomic.example/other' },
  });
  fail({}, /Ambiguous/, { a: row, b: row });
});
test('operator policy, scope and document type are required before any intent', () => {
  fail({ mode: 'network' }, /operator-reviewed/);
  fail({ allowedPeers: [] }, /not allowed/);
  fail({ recipient: 'other' }, /recipient/);
  fail({ document: 'https://atomic.example/missing' }, /accessible Atomic/);
  fail({}, /accessible Atomic/, {
    [doc]: { [P.isA]: ['https://atomicdata.dev/classes/File'] },
  });
  const c = host();

  c.read = () => {
    throw new Error('host denied read');
  };

  assert.deepEqual(run(c).intents, []);
});
test('bounded parsing refuses malformed, oversized, unsupported and ambiguous wire data', () => {
  for (const body of ['{', 'null', '[]', ' '.repeat(16385)])
    assert.throws(() => parseShare(body));
  for (const patch of [
    { name: '\n' },
    { shareType: 'group' },
    { resourceType: 'folder' },
    { expiration: 1.2 },
    { protocol: null },
    { providerId: 7 },
  ])
    assert.throws(() => parseShare(JSON.stringify({ ...share, ...patch })));
  assert.throws(
    () =>
      parseShare(
        JSON.stringify({
          ...share,
          protocol: {
            name: 'multi',
            webdav: {
              uri: 'x',
              permissions: ['read'],
              requirements: ['must-use-mfa'],
            },
          },
        }),
      ),
    /requirements/,
  );
});
test('origin parsing works without URL and refuses credentials, query and path', () => {
  assert.equal(origin(peer), peer);
  for (const bad of [
    'http://cloud.example',
    'https://user:pw@cloud.example',
    peer + '/path',
    peer + '?token=secret',
    'https://cloud.example\n',
  ])
    assert.throws(() => origin(bad));
});
test('self-contained release rebuilds reproducibly with executable manifest routes', async () => {
  const before = await readFile(
    new URL('./plugin.js', import.meta.url),
    'utf8',
  );
  execFileSync(process.execPath, [
    new URL('./build.mjs', import.meta.url).pathname,
  ]);
  assert.equal(
    await readFile(new URL('./plugin.js', import.meta.url), 'utf8'),
    before,
  );
  const built = await import(
    'data:text/javascript;base64,' + Buffer.from(before).toString('base64')
  );
  assert.deepEqual(built.run(host()), run(host()));
  const manifest = JSON.parse(
    await readFile(new URL('./manifest.json', import.meta.url)),
  );
  assert.deepEqual(built.manifest, manifest);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.http.mount, 'drive-host');

  for (const route of manifest.http.routes) {
    assert.equal(route.auth, 'none');
    assert.equal(route.writes, undefined);
    assert.equal(route.enqueues, undefined);
    assert.notEqual(
      handle(host(), { path: route.path, method: route.methods[0] }).status,
      404,
    );
  }
});
