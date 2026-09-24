import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  handle,
  run,
  manifest,
  normalizeHandle,
  validateDid,
} from './plugin.mjs';
const did = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const context = () => ({
  trigger: { route: 'atproto-did' },
  config: { handle: 'user.example.com', did },
  read: () => assert.fail('No store reads'),
  query: () => assert.fail('No queries'),
  http: () => assert.fail('No network'),
});
const request = (method = 'GET') => ({
  method,
  path: '/.well-known/atproto-did',
  wellKnown: 'atproto-did',
  headers: {},
  query: {},
});
test('host v3 drive-host exclusive claim connects to declared anonymous route', () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.http.mount, 'drive-host');
  assert.deepEqual(manifest.http.wellKnown, [
    { name: 'atproto-did', kind: 'exclusive', route: 'atproto-did' },
  ]);
  assert.deepEqual(manifest.http.routes[0].methods, ['GET', 'HEAD']);
  assert.equal(manifest.http.routes[0].principal, 'anonymous');
});
test('HTTPS well-known method returns DID bytes without decoration', () => {
  const result = handle(context(), request());
  assert.equal(result.status, 200);
  assert.equal(result.body, did);
  assert.equal(result.headers['content-type'], 'text/plain');
  assert.equal(result.headers['cache-control'], 'no-store');
});
test('HEAD and direct declared route work with host request shape', () => {
  const get = handle(context(), request());
  const head = handle(context(), request('HEAD'));
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.deepEqual(head.headers, get.headers);
  assert.equal(
    handle(context(), { method: 'GET', path: '/atproto-did', wellKnown: null })
      .body,
    did,
  );
});
test('dispatch mismatch and arbitrary paths do not reveal DID', () => {
  for (const patch of [
    { path: '/other' },
    { wellKnown: 'webfinger' },
    { wellKnown: null },
    { path: '/atproto-did' },
  ]) {
    assert.equal(handle(context(), { ...request(), ...patch }).status, 404);
  }

  assert.equal(
    handle({ ...context(), trigger: { route: 'other' } }, request()).status,
    404,
  );
});
test('all unsupported methods refuse without effects', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'get'])
    assert.equal(handle(context(), request(method)).status, 405);
});
test('invalid/missing configuration returns generic unavailable and empty HEAD', () => {
  for (const config of [
    undefined,
    {},
    { handle: 'user.example.com', did: 'private\r\nsecret' },
    { handle: 'bad handle', did },
  ]) {
    const c = { ...context(), config };
    assert.equal(handle(c, request()).status, 503);
    assert.equal(handle(c, request('HEAD')).body, '');
    assert.throws(() => run(c));
  }
});
test('header and query values cannot select or replace identity', () => {
  const req = {
    ...request(),
    headers: {
      host: 'evil.com',
      origin: 'https://evil.com',
      'x-forwarded-host': 'evil.com',
    },
    query: { handle: 'evil.com', did: 'did:web:evil.com' },
  };
  assert.equal(handle(context(), req).body, did);
  // Actual host authority is absent from runtime input. Registry, not spoofed headers,
  // binds this installation to its drive hostname. No per-request authority claim.
});
test('production handles accept case folding and published syntax examples', () => {
  for (const value of [
    'jay.bsky.social',
    '8.cn',
    'XX.LCS.MIT.EDU',
    'a.co',
    'xn--notarealidn.com',
  ])
    assert.equal(normalizeHandle(value), value.toLowerCase());
});
test('reject whitespace, injection, invalid DNS and reserved production suffixes', () => {
  for (const value of [
    'user.example.com\n',
    'a.com\r\nX: y',
    '💩.com',
    'a..com',
    '-a.com',
    'a-.com',
    'a.8',
    'org',
    'a.com.',
    'a.onion',
    'a.local',
    'a.test',
    'a.example',
    'a.invalid',
    'a'.repeat(64) + '.com',
    'a.'.repeat(126) + 'co',
  ])
    assert.throws(() => normalizeHandle(value), value);
});
test('DID allows PLC and hostname-only web, rejects URI and header injection', () => {
  assert.equal(validateDid(did), did);
  assert.equal(
    validateDid('did:web:user.example.com'),
    'did:web:user.example.com',
  );
  for (const value of [
    'did:key:abc',
    did + '\n',
    did + '#key',
    did + '?x',
    'did:plc:abc',
    'did:plc:' + '0'.repeat(24),
    'did:web:example.com:path',
    'did:web:example.com%3A443',
    'did:web:EXAMPLE.com',
    'did:web:a.local',
  ])
    assert.throws(() => validateDid(value), value);
});
test('non-HTTP job validates configuration without producing mutations', () => {
  assert.deepEqual(run(context()), { intents: [], problems: [] });
});
test('build is reproducible, executable ESM and contains the exported manifest', async () => {
  const build = new URL('./build.mjs', import.meta.url);
  execFileSync(process.execPath, [build.pathname]);
  const first = await readFile(
    new URL('./dist/plugin.js', import.meta.url),
    'utf8',
  );
  const metadata = await readFile(
    new URL('./dist/manifest.json', import.meta.url),
    'utf8',
  );
  execFileSync(process.execPath, [build.pathname]);
  assert.equal(
    await readFile(new URL('./dist/plugin.js', import.meta.url), 'utf8'),
    first,
  );
  assert.equal(
    await readFile(new URL('./dist/manifest.json', import.meta.url), 'utf8'),
    metadata,
  );
  assert.deepEqual(JSON.parse(metadata), manifest);
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(first).toString('base64')
  );
  assert.equal(module.handle(context(), request()).body, did);
});
