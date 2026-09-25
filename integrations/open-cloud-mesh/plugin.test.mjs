import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  handle,
  parseShare,
  parseNotification,
  run,
  P,
  origin,
} from './plugin.mjs';
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

function savedReceipt() {
  const intent = run(host()).intents[0];

  return { ...intent.set, [P.parent]: intent.parent, [P.isA]: intent.isA };
}

function notify(row, type = 'SHARE_ACCEPTED', overrides = {}) {
  return run(
    host(
      {
        mode: 'apply-reviewed-notification',
        expectedState: 'recorded',
        notificationJson: JSON.stringify({
          notificationType: type,
          resourceType: 'file',
          providerId: 'share-123',
          notification: {
            message: 'Reviewed by operator',
            sharedSecret: 'NEVER-PUBLISH',
          },
        }),
        ...overrides,
      },
      { receipt: row },
    ),
  );
}

test('OCM1.3 notification fixture projects only the required public identity', () => {
  assert.deepEqual(
    parseNotification(
      '{"notificationType":"SHARE_ACCEPTED","resourceType":"file","providerId":"share-123","notification":{"sharedSecret":"secret"}}',
    ),
    {
      notificationType: 'SHARE_ACCEPTED',
      resourceType: 'file',
      providerId: 'share-123',
    },
  );
  for (const value of [
    JSON.stringify({
      notificationType: ['SHARE_ACCEPTED'],
      resourceType: 'file',
      providerId: 'x',
    }),
    'null',
    '[]',
    '{',
    JSON.stringify({
      notificationType: 'USER_REMOVED',
      resourceType: 'user',
      providerId: 'x',
    }),
    JSON.stringify({
      notificationType: 'REQUEST_RESHARE',
      resourceType: 'file',
      providerId: 'x',
    }),
    JSON.stringify({
      notificationType: 'SHARE_DECLINED',
      resourceType: 'file',
      providerId: 'x',
      notification: [],
    }),
    ' '.repeat(16385),
  ])
    assert.throws(() => parseNotification(value));
});
test('reviewed acceptance updates only persisted receipt metadata, then deduplicates', () => {
  const row = savedReceipt();
  const result = notify(row);
  assert.deepEqual(result.problems, []);
  assert.equal(result.intents.length, 1);
  const change = result.intents[0];
  assert.equal(change.op, 'set');
  assert.equal(change.subject, 'receipt');
  assert.deepEqual(
    Object.keys(change.set).sort(),
    [P.baseline, P.description].sort(),
  );
  assert.equal(change.set[P.baseline].state, 'accepted');
  assert.equal(change.set[P.baseline].lastNotification, 'SHARE_ACCEPTED');
  assert.equal(change.set[P.baseline].document, doc);
  assert.ok(!JSON.stringify(result).includes('NEVER-PUBLISH'));
  const persisted = { ...row, ...change.set };
  assert.deepEqual(notify(persisted), { intents: [], problems: [] });
  assert.deepEqual(run(host({}, { receipt: persisted })), {
    intents: [],
    problems: [],
  });
});
test('decline and unshare are conservative terminal receipt states', () => {
  const initial = savedReceipt();
  const declined = {
    ...initial,
    ...notify(initial, 'SHARE_DECLINED').intents[0].set,
  };
  assert.equal(declined[P.baseline].state, 'declined');
  const reopen = notify(declined, 'SHARE_ACCEPTED', {
    expectedState: 'declined',
  });
  assert.deepEqual(reopen.intents, []);
  assert.match(reopen.problems[0].message, /terminal/);
  const accepted = { ...initial, ...notify(initial).intents[0].set };
  const revoke = notify(accepted, 'SHARE_UNSHARED', {
    expectedState: 'accepted',
  });
  assert.equal(revoke.intents[0].set[P.baseline].state, 'unshared');
  const revoked = { ...accepted, ...revoke.intents[0].set };
  assert.deepEqual(
    notify(revoked, 'SHARE_UNSHARED', { expectedState: 'accepted' }),
    { intents: [], problems: [] },
  );
  assert.deepEqual(
    notify(revoked, 'SHARE_ACCEPTED', { expectedState: 'unshared' }).intents,
    [],
  );
  assert.equal(
    notify(initial, 'SHARE_UNSHARED').intents[0].set[P.baseline].state,
    'unshared',
  );
});
test('notification binding, expected-state and local-edit conflicts cannot mutate receipts', () => {
  const row = savedReceipt();
  for (const overrides of [
    { recipient: 'somebody-else' },
    {
      peerOrigin: 'https://other.example',
      allowedPeers: { 'https://other.example': true },
    },
    { expectedState: 'accepted' },
    {
      notificationJson:
        '{"notificationType":"SHARE_ACCEPTED","resourceType":"file","providerId":"another-share"}',
    },
  ])
    assert.deepEqual(notify(row, 'SHARE_ACCEPTED', overrides).intents, []);
  assert.deepEqual(
    notify({ ...row, [P.description]: 'Locally edited' }).intents,
    [],
  );
  assert.deepEqual(
    notify({ ...row, [P.about]: 'https://atomic.example/other' }).intents,
    [],
  );
  const duplicateHost = host(
    {
      mode: 'apply-reviewed-notification',
      expectedState: 'recorded',
      notificationJson:
        '{"notificationType":"SHARE_ACCEPTED","resourceType":"file","providerId":"share-123"}',
    },
    { a: row, b: row },
  );
  assert.deepEqual(run(duplicateHost).intents, []);
});
test('legacy receipts migrate only by exact reviewed reimport, and HTTP remains unavailable', () => {
  const row = savedReceipt();
  delete row[P.baseline];
  assert.deepEqual(notify(row).intents, []);
  const migration = run(host({}, { receipt: row }));
  assert.deepEqual(migration.problems, []);
  assert.deepEqual(Object.keys(migration.intents[0].set), [P.baseline]);
  assert.equal(migration.intents[0].set[P.baseline].state, 'recorded');
  assert.equal(
    handle(host(), {
      method: 'POST',
      path: '/ocm/notifications',
      body: '{"notificationType":"SHARE_UNSHARED"}',
      caller: 'pretend-peer',
    }).status,
    501,
  );
});

test('origin aliases share canonical identity and policy decisions', () => {
  for (const alias of [
    'https://CLOUD.Example',
    'HTTPS://cloud.example:443',
    'https://cloud.example:00443',
  ])
    assert.equal(origin(alias), peer);
  assert.equal(
    origin('https://CLOUD.example:08443'),
    'https://cloud.example:8443',
  );
  for (const invalid of [
    'https://cloud..example',
    'https://-cloud.example',
    'https://cloud-.example',
    'https://cloud.example.',
    'https://cloud.example:65536',
    'https://cloud.example:0',
    'https://127.0.0.1',
    'https://' + 'x'.repeat(64) + '.example',
  ])
    assert.throws(() => origin(invalid));
  const original = savedReceipt();
  const aliases = {
    peerOrigin: 'https://CLOUD.example:443',
    allowedPeers: { 'HTTPS://Cloud.Example:443': true },
  };
  assert.deepEqual(run(host(aliases, { receipt: original })), {
    intents: [],
    problems: [],
  });
  assert.equal(
    notify(original, 'SHARE_ACCEPTED', aliases).intents[0].set[P.baseline].peer,
    peer,
  );
  assert.deepEqual(
    run(host({ allowedPeers: { [peer]: true, [peer + ':443']: false } }))
      .intents,
    [],
  );
  assert.equal(
    run(host({ allowedPeers: { [peer]: true, [peer + ':443']: true } })).intents
      .length,
    1,
  );
});
test('precanonical default-port receipts fail closed rather than duplicate', () => {
  const legacy = savedReceipt();
  legacy[P.localId] = JSON.stringify([
    'ocm-receipt-v1',
    peer + ':443',
    share.providerId,
    share.shareWith,
  ]);
  const result = run(host({}, { legacy }));
  assert.deepEqual(result.intents, []);
  assert.match(result.problems[0].message, /Legacy origin alias/);
  assert.deepEqual(notify(legacy).intents, []);
});

test('canonical Atomic document subjects work for import and lifecycle', () => {
  const atomicDocument = 'atomic:7c084226d9a111e6bf26cec0c932ce01';
  const c = host(
    { document: atomicDocument },
    {
      [atomicDocument]: {
        [P.isA]: ['https://atomicdata.dev/classes/DocumentV2'],
      },
    },
  );
  const created = run(c);
  assert.deepEqual(created.problems, []);
  const intent = created.intents[0];
  assert.equal(intent.parent, atomicDocument);
  assert.equal(intent.set[P.about], atomicDocument);
  const row = {
    ...intent.set,
    [P.parent]: atomicDocument,
    [P.isA]: intent.isA,
  };
  const n = host(
    {
      document: atomicDocument,
      mode: 'apply-reviewed-notification',
      expectedState: 'recorded',
      notificationJson:
        '{"notificationType":"SHARE_ACCEPTED","resourceType":"file","providerId":"share-123"}',
    },
    {
      receipt: row,
      [atomicDocument]: {
        [P.isA]: ['https://atomicdata.dev/classes/DocumentV2'],
      },
    },
  );
  assert.equal(run(n).intents[0].set[P.baseline].document, atomicDocument);
  n.read = () => {
    throw Error('Denied by host');
  };
  assert.deepEqual(run(n).intents, []);
  for (const document of [
    'atomic:',
    'atomic://legacy',
    'atomic:bad name',
    'atomic:x?query',
  ])
    assert.deepEqual(run(host({ document })).intents, []);
});
