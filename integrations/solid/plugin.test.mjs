import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, run, parseRdf, P, MAX_BYTES, manifest } from './plugin.mjs';
const subject = 'https://pod.example/doc';
const rdf =
  '[{"@id":"https://example.org/alice","http://xmlns.com/foaf/0.1/name":[{"@value":"Alice","@language":"en"}]}]';

function ctx(body = 'hello', mediaType = 'text/plain') {
  return {
    config: {
      parent: 'https://pod.example/folder',
      document: { id: 'doc', name: 'Document', body, mediaType },
      exports: { doc: subject },
    },
    query: () => [],
    read: () => ({ [P.description]: body, [P.media]: mediaType }),
  };
}

const req = (headers = {}, method = 'GET', id = 'doc') => ({
  method,
  headers,
  params: { id },
});
test('actual host route contract: anonymous reads only, no auth claim', () => {
  assert.deepEqual(manifest.http.routes[0].methods, ['GET', 'HEAD']);
  assert.equal(manifest.http.routes[0].principal, 'anonymous');
});
test('reviewed import emits existing host create intent and native PlainText atoms', () => {
  const c = ctx();
  const result = run(c);
  const intent = result.intents[0];
  assert.equal(intent.op, 'create');
  assert.equal(intent.parent, c.config.parent);
  assert.deepEqual(intent.isA, ['https://atomicdata.dev/classes/PlainText']);
  assert.equal(intent.set[P.description], 'hello');
  assert.equal(
    'https://atomicdata.dev/properties/documentContent' in intent.set,
    false,
  );

  // Test double models only committed atom retrieval; does not claim a live host commit.
  c.read = s => {
    assert.equal(s, subject);

    return intent.set;
  };

  assert.equal(handle(c, req()).body, 'hello');
});
test('expanded RDF lexical body survives reviewed import and read', () => {
  const c = ctx(rdf, 'application/ld+json');
  const intent = run(c).intents[0];
  c.read = () => intent.set;
  const result = handle(c, req({ accept: 'application/ld+json' }));
  assert.equal(result.body, rdf);
  assert.match(result.headers.link, /#RDFSource/);
});
test('duplicate import never blindly overwrites', () => {
  const c = ctx();
  c.query = () => [subject];
  assert.throws(() => run(c), /already imported/);
});
test('host permission denial returns indistinguishable not found', () => {
  const c = ctx();

  c.read = () => {
    throw Error('private details');
  };

  assert.deepEqual(handle(c, req()), handle(c, req({}, 'GET', 'missing')));
});
test('export keys cannot traverse or read prototype or arbitrary URI', () => {
  const c = ctx();
  c.read = () => assert.fail('unexpected read');
  for (const id of [
    '../doc',
    '%2fdoc',
    'constructor',
    '__proto__',
    'https://private',
  ])
    assert.equal(handle(c, req({}, 'GET', id)).status, 404);
});
test('mutation cannot call read or produce intents', () => {
  const c = ctx();
  c.read = () => assert.fail('unexpected read');
  for (const method of ['PUT', 'PATCH', 'POST', 'DELETE'])
    assert.equal(handle(c, req({}, method)).status, 501);
});
test('HEAD preserves GET metadata but strips body', () => {
  const get = handle(ctx(), req());
  const head = handle(ctx(), req({}, 'HEAD'));
  assert.equal(head.body, '');
  assert.deepEqual(head.headers, get.headers);
});
test('conditional read weak matching and wildcard', () => {
  const c = ctx();
  const tag = handle(c, req()).headers.etag;
  for (const value of [tag, tag.slice(2), '*', `"other", ${tag}`])
    assert.equal(handle(c, req({ 'if-none-match': value })).status, 304);
  assert.equal(
    handle(ctx('changed'), req({ 'if-none-match': tag })).status,
    200,
  );
  assert.equal(handle(c, req({ 'if-match': tag })).status, 412);
  assert.equal(handle(c, req({ 'if-match': '*' })).status, 200);
});
test('Accept honors exact exclusion over wildcard and unsupported media', () => {
  for (const accept of [
    'application/ld+json',
    'text/plain;q=0, */*;q=1',
    '*/*;q=0',
  ])
    assert.equal(handle(ctx(), req({ accept })).status, 406);
  assert.equal(handle(ctx(), req({ accept: 'text/*' })).status, 200);
});
test('UTF-8 limits apply before parsing and storage', () => {
  assert.equal(handle(ctx('x'.repeat(MAX_BYTES)), req()).status, 200);
  assert.throws(() => run(ctx('é'.repeat(MAX_BYTES / 2 + 1))), /bytes/);
  assert.throws(() => run(ctx('\ud800')), URIError);
});
test('reject binary and unsupported RDF serialization without fake blobs', () => {
  assert.throws(
    () => run(ctx('bytes', 'application/octet-stream')),
    /Unsupported/,
  );
  assert.throws(
    () => run(ctx('<s> <p> <o>.', 'application/rdf+xml')),
    /Unsupported/,
  );
});
test('parser rejects remote contexts, relative identifiers, malformed RDF, numbers', () => {
  const bad = [
    '[{"@id":"urn:a","urn:p":[{"@value":"x","@language":["en"]}]}]',
    '{}',
    '{',
    '[{"@id":"relative"}]',
    '[{"@id":"urn:a","@context":"https://evil"}]',
    '[{"@id":"urn:a","urn:p":[{"@value":1}]}]',
    '[{"@id":"urn:a","urn:p":[{"@value":"x","@type":"urn:t","@language":"en"}]}]',
  ];
  for (const body of bad) assert.throws(() => parseRdf(body));
});
test('parser accepts typed exact strings and references; bounds graph size', () => {
  const graph = [
    {
      '@id': 'urn:a',
      '@type': ['urn:type'],
      'urn:p': [
        { '@id': 'urn:b' },
        {
          '@value': '9007199254740993',
          '@type': 'http://www.w3.org/2001/XMLSchema#integer',
        },
      ],
    },
  ];
  assert.deepEqual(parseRdf(JSON.stringify(graph)), graph);
  assert.throws(
    () => parseRdf(JSON.stringify(Array(129).fill({ '@id': 'urn:a' }))),
    /128/,
  );
});

test('bundle and manifest build reproducibly and emitted ESM executes', async () => {
  const { readFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const build = new URL('./build.mjs', import.meta.url).pathname;
  execFileSync(process.execPath, [build]);
  const source = await readFile(
    new URL('./dist/plugin.js', import.meta.url),
    'utf8',
  );
  const metadata = await readFile(
    new URL('./dist/manifest.json', import.meta.url),
    'utf8',
  );
  execFileSync(process.execPath, [build]);
  assert.equal(
    await readFile(new URL('./dist/plugin.js', import.meta.url), 'utf8'),
    source,
  );
  assert.equal(
    await readFile(new URL('./dist/manifest.json', import.meta.url), 'utf8'),
    metadata,
  );
  assert.deepEqual(JSON.parse(metadata), manifest);
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  assert.equal(module.handle(ctx(), req()).body, 'hello');
});

test('manifest declares each consumed installation config field with host-supported types', () => {
  assert.deepEqual(Object.keys(manifest.config.properties), [
    'parent',
    'document',
    'exports',
  ]);
  assert.deepEqual(manifest.config.required, []);

  for (const field of Object.values(manifest.config.properties)) {
    assert.ok(['string', 'object'].includes(field.type));
    assert.equal(typeof field.description, 'string');
    assert.ok(field.description.length > 0);
  }
});
