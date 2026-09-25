import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseTurtle,
  serializeTurtle,
  handle,
  run,
  P,
  MAX_BYTES,
} from './plugin.mjs';
const vectors = JSON.parse(
  await readFile(
    new URL('./fixtures/turtle-cases.json', import.meta.url),
    'utf8',
  ),
);
for (const vector of vectors.cases)
  test(`Turtle normative grammar: ${vector.name}`, () => {
    assert.deepEqual(parseTurtle(vector.input), vector.graph);
    assert.deepEqual(parseTurtle(serializeTurtle(vector.graph)), vector.graph);
  });
const turtle =
  '@prefix ex: <https://example.org/> .\nex:alice ex:name "Alice"@en .';
const graph = [
  {
    '@id': 'https://example.org/alice',
    'https://example.org/name': [{ '@value': 'Alice', '@language': 'en' }],
  },
];
const req = (accept, method = 'GET', extra = {}) => ({
  method,
  params: { id: 'alice' },
  headers: { accept, ...extra },
});
const context = (body = turtle, media = 'text/turtle') => ({
  config: {
    parent: 'https://atomic.example/folder',
    document: { id: 'alice', name: 'Alice', body, mediaType: media },
    exports: { alice: 'https://atomic.example/alice' },
  },
  query: () => [],
  read: () => ({ [P.description]: body, [P.media]: media }),
});
test('Turtle import uses actual PlainText atom intents and preserves source body', () => {
  const c = context();
  const intent = run(c).intents[0];
  assert.equal(intent.set[P.description], turtle);
  assert.equal(intent.set[P.media], 'text/turtle');

  c.read = subject => {
    assert.equal(subject, c.config.exports.alice);

    return intent.set;
  };

  assert.equal(handle(c, req('text/turtle')).body, turtle);
  assert.deepEqual(
    JSON.parse(handle(c, req('application/ld+json')).body),
    graph,
  );
});
test('stored JSON-LD generates Turtle with rdf:type and named-node references', () => {
  const value = [
    {
      '@id': 'urn:alice',
      '@type': ['urn:Person'],
      'urn:knows': [{ '@id': 'urn:bob' }],
    },
  ];
  const result = handle(
    context(JSON.stringify(value), 'application/ld+json'),
    req('text/turtle'),
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'text/turtle');
  assert.match(result.headers.link, /#RDFSource/);
  assert.deepEqual(parseTurtle(result.body), [
    {
      '@id': 'urn:alice',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': [
        { '@id': 'urn:Person' },
      ],
      'urn:knows': [{ '@id': 'urn:bob' }],
    },
  ]);
});
test('RDF negotiation honors quality and exact exclusions without converting plain text', () => {
  const c = context();
  for (const [accept, media] of [
    ['application/ld+json;q=1,text/turtle;q=0.5', 'application/ld+json'],
    ['text/turtle;q=0,*/*;q=0.8', 'application/ld+json'],
    ['*/*', 'text/turtle'],
    ['text/*;q=0.2,application/*;q=0.9', 'application/ld+json'],
  ])
    assert.equal(handle(c, req(accept)).headers['content-type'], media);
  for (const accept of [
    'application/rdf+xml',
    'text/turtle;q=0,application/ld+json;q=0',
    'text/plain',
  ])
    assert.equal(handle(c, req(accept)).status, 406);
  assert.equal(
    handle(context('just text', 'text/plain'), req('text/turtle')).status,
    406,
  );
});
test('representation-specific validators and HEAD apply after conversion', () => {
  const c = context();
  const a = handle(c, req('text/turtle'));
  const b = handle(c, req('application/ld+json'));
  assert.notEqual(a.headers.etag, b.headers.etag);
  assert.equal(b.headers.vary, 'Accept');
  assert.equal(
    handle(
      c,
      req('application/ld+json', 'GET', { 'if-none-match': b.headers.etag }),
    ).status,
    304,
  );
  assert.equal(
    handle(
      c,
      req('application/ld+json', 'GET', { 'if-none-match': a.headers.etag }),
    ).status,
    200,
  );
  const head = handle(c, req('application/ld+json', 'HEAD'));
  assert.deepEqual(head.headers, b.headers);
  assert.equal(head.body, '');
});
test('denied Atomic read never parses or reveals a representation', () => {
  const c = context();

  c.read = () => {
    throw Error('denied');
  };

  assert.equal(handle(c, req('text/turtle')).status, 404);
});
test('unsupported valid Turtle forms fail closed without claiming full Turtle conformance', () => {
  for (const text of [
    '@base <https://example.org/> . <a> <b> <c> .',
    '<relative> <urn:p> <urn:o> .',
    '_:b <urn:p> "x" .',
    '<urn:s> <urn:p> [] .',
    '<urn:s> <urn:p> ( <urn:o> ) .',
    '<urn:s> <urn:p> """long""" .',
    '@prefix ex: <urn:> . ex:a.b ex:p ex:o .',
  ])
    assert.throws(() => parseTurtle(text), text);
});
test('malformed escapes, literal suffixes and trailing syntax are rejected', () => {
  for (const text of [
    '<urn:s> <urn:p> "bad\\q" .',
    '<urn:s> <urn:p> "\\uD800" .',
    '<urn:s> <urn:p> "\\U00110000" .',
    '<urn:s> <urn:p> "x"@en- .',
    '<urn:s> <urn:p> "x"^^<relative> .',
    '<urn:s> <urn:p> "x"',
    '<urn:s> <urn:p> trueX .',
    '<urn:s> <urn:p> 1.2e .',
    '<urn:s\\u0000> <urn:p> <urn:o> .',
    '<urn:s> <urn:p> "line\nbreak" .',
  ])
    assert.throws(() => parseTurtle(text), text);
});
test('bounded parsing rejects excessive nodes, triples, UTF-8 and prefix expansion', () => {
  assert.throws(() => parseTurtle(' '.repeat(MAX_BYTES + 1)), /bytes/);
  assert.throws(
    () =>
      parseTurtle(
        Array.from(
          { length: 129 },
          (_, i) => `<urn:s${i}> <urn:p> <urn:o> .`,
        ).join('\n'),
      ),
    /128/,
  );
  assert.throws(
    () =>
      parseTurtle('<urn:s> <urn:p> ' + Array(513).fill('""').join(',') + ' .'),
    /512/,
  );
  assert.throws(
    () =>
      parseTurtle(
        '@prefix ex: <https://example.org/' +
          'a'.repeat(2000) +
          '> . ' +
          Array(10).fill('ex:s ex:p ex:o .').join('\n'),
      ),
    /Expanded/,
  );
});
test('stored malformed Turtle gets a representation error without mutation', () => {
  assert.equal(
    handle(context('<s> <p> <o> .'), req('application/ld+json')).status,
    415,
  );
  assert.throws(() => run(context('<s> <p> <o> .')));
});

test('expanded Turtle output cap cannot bypass native JSON-LD reads', () => {
  const value = [
    {
      '@id': 'https://example.org/' + 'a'.repeat(20000),
      'urn:p': [{ '@value': 'first' }, { '@value': 'second' }],
    },
  ];
  const c = context(JSON.stringify(value), 'application/ld+json');
  assert.equal(handle(c, req('application/ld+json')).status, 200);
  assert.equal(handle(c, req('text/turtle')).status, 406);
  assert.throws(() => serializeTurtle(value), /32768/);
});

for (const name of [
  'bareword_a_predicate',
  'bareword_decimal',
  'bareword_double',
  'IRIREF_datatype',
]) {
  test(`W3C upstream evaluation fixture: ${name}`, async () => {
    const input = await readFile(
      new URL(`./fixtures/w3c/${name}.ttl`, import.meta.url),
      'utf8',
    );
    const expected = await readFile(
      new URL(`./fixtures/w3c/${name}.nt`, import.meta.url),
      'utf8',
    );
    assert.equal(serializeTurtle(parseTurtle(input)), expected.trimEnd());
  });
}

for (const [name, valid] of [
  ['turtle-syntax-string-01', true],
  ['turtle-syntax-bad-num-01', false],
  ['turtle-syntax-bad-string-01', false],
]) {
  test(`W3C upstream syntax fixture: ${name}`, async () => {
    const input = await readFile(
      new URL(`./fixtures/w3c/${name}.ttl`, import.meta.url),
      'utf8',
    );
    if (valid) assert.doesNotThrow(() => parseTurtle(input));
    else assert.throws(() => parseTurtle(input));
  });
}
