import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { handle, run, P, AS, PUBLIC, negotiate } from './plugin.mjs';
const origin = 'https://social.example';
const profile = 'https://atomic.example/profile';
const note = 'https://atomic.example/note';
const document = 'https://atomic.example/document';
const privateSubject = 'https://atomic.example/private';

function ctx(overrides = {}, rows = {}) {
  const data = {
    [profile]: {
      [P.name]: 'Atomic news',
      [P.description]: '<script>Profile</script>',
      secret: 'NO',
    },
    [note]: {
      [P.isA]: ['https://atomicdata.dev/classes/Message'],
      [P.description]: 'Hello <script>alert(1)</script>\nWorld',
      secret: 'NO',
    },
    [document]: {
      [P.isA]: ['https://atomicdata.dev/classes/DocumentV2'],
      [P.name]: 'Design',
      'https://atomicdata.dev/properties/documentContent': 'DO-NOT-EXPOSE-LORO',
    },
    ...rows,
  };

  return {
    config: {
      origin,
      username: 'news',
      profile,
      publication: {
        objects: [
          { id: 'note', subject: note, published: '2026-09-24T12:00:00.000Z' },
          {
            id: 'document',
            subject: document,
            published: '2026-09-24T11:00:00.000Z',
          },
          {
            id: 'private',
            subject: privateSubject,
            published: '2026-09-24T13:00:00.000Z',
          },
        ],
      },
      ...overrides,
      ...(Object.hasOwn(overrides, 'objects')
        ? { publication: { objects: overrides.objects } }
        : {}),
    },
    read(subject) {
      if (!(subject in data)) throw new Error('Permission denied');

      return data[subject];
    },
  };
}

function get(c, path, options = {}) {
  return handle(c, { method: 'GET', path, ...options });
}

function body(result) {
  assert.equal(result.status, 200);

  return JSON.parse(result.body);
}

test('single actor projects only selected public profile fields, escaping HTML', () => {
  const actor = body(get(ctx(), '/ap/actor'));
  assert.equal(actor.type, 'Service');
  assert.equal(actor.id, origin + '/ap/actor');
  assert.equal(actor.inbox, origin + '/ap/inbox');
  assert.equal(actor.outbox, origin + '/ap/outbox');
  assert.equal(actor.summary, '&lt;script&gt;Profile&lt;/script&gt;');
  assert.ok(!JSON.stringify(actor).includes('NO'));
  assert.equal(actor.publicKey, undefined);
});
test('public Message maps to Note; DocumentV2 is a link-only Article', () => {
  const message = body(get(ctx(), '/ap/objects/note'));
  assert.equal(message.type, 'Note');
  assert.equal(
    message.content,
    '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;<br>World</p>',
  );
  assert.equal(message.url, note);
  assert.deepEqual(message.to, [PUBLIC]);
  assert.equal(message.attributedTo, origin + '/ap/actor');
  const doc = body(get(ctx(), '/ap/objects/document'));
  assert.equal(doc.type, 'Article');
  assert.equal(doc.content, undefined);
  assert.equal(doc.url, document);
  assert.ok(!JSON.stringify(doc).includes('DO-NOT-EXPOSE-LORO'));
});
test('outbox contains ordered dereferenceable Create activities, omits private data', () => {
  const root = body(get(ctx(), '/ap/outbox'));
  assert.equal(root.totalItems, 2);
  assert.equal(root.first, origin + '/ap/outbox?page=1');
  const page = body(get(ctx(), '/ap/outbox', { query: { page: '1' } }));
  assert.equal(page.type, 'OrderedCollectionPage');
  assert.equal(page.partOf, root.id);
  assert.equal(page.orderedItems[0].object.id, origin + '/ap/objects/note');
  assert.equal(page.orderedItems[0].type, 'Create');
  assert.deepEqual(
    page.orderedItems[0],
    body(get(ctx(), '/ap/activities/note')),
  );
  assert.ok(!JSON.stringify(page).includes(privateSubject));
});
test('private source, private profile and unbound paths are not disclosed', () => {
  assert.equal(get(ctx(), '/ap/objects/private').status, 404);
  assert.equal(get(ctx(), '/ap/objects/missing').status, 404);
  assert.equal(get(ctx(), '/ap/objects/../profile').status, 404);
  const c = ctx();

  c.read = () => {
    throw new Error('Private profile details');
  };

  for (const path of [
    '/ap/actor',
    '/ap/outbox',
    '/nodeinfo',
    '/nodeinfo/2.1',
    '/webfinger',
  ]) {
    const response = get(c, path);
    assert.equal(response.status, 404);
    assert.ok(!response.body.includes('Private profile details'));
  }
});
test('WebFinger exact account matching, repeated resources and rel filtering', () => {
  const c = ctx();
  const response = get(c, '/.well-known/webfinger', {
    wellKnown: 'webfinger',
    query: { resource: 'acct:news@social.example' },
  });
  assert.equal(response.headers['content-type'], 'application/jrd+json');
  assert.equal(body(response).links[0].href, origin + '/ap/actor');
  assert.equal(
    get(c, '/webfinger', { query: { resource: 'acct:other@social.example' } })
      .status,
    404,
  );
  assert.equal(
    get(c, '/webfinger', {
      query: { resource: ['acct:news@social.example', 'x'] },
    }).status,
    400,
  );
  assert.deepEqual(
    body(
      get(c, '/webfinger', {
        query: { resource: 'acct:news@social.example', rel: 'other' },
      }),
    ).links,
    [],
  );
  assert.equal(
    body(
      get(c, '/webfinger', {
        query: { resource: 'acct:news@social.example', rel: ['other', 'self'] },
      }),
    ).links.length,
    1,
  );
});
test('NodeInfo discovery does not claim enabled federation or count private objects', () => {
  const links = body(
    get(ctx(), '/.well-known/nodeinfo', { wellKnown: 'nodeinfo' }),
  );
  assert.equal(links.links[0].href, origin + '/nodeinfo/2.1');
  const info = body(get(ctx(), '/nodeinfo/2.1'));
  assert.equal(info.version, '2.1');
  assert.deepEqual(info.protocols, []);
  assert.equal(info.metadata.federationEnabled, false);
  assert.equal(info.usage.localPosts, 2);
});
test('content negotiation supports both ActivityPub representations and q exclusions', () => {
  assert.equal(
    negotiate('application/activity+json'),
    'application/activity+json',
  );
  assert.equal(
    negotiate(
      'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    ),
    `application/ld+json; profile="${AS}"`,
  );
  assert.equal(
    negotiate(
      'application/activity+json;q=0, application/ld+json;q=0, */*;q=1',
    ),
    undefined,
  );
  assert.equal(negotiate('text/html'), undefined);
  assert.equal(
    get(ctx(), '/ap/actor', { headers: { accept: 'text/html' } }).status,
    406,
  );
  assert.equal(
    get(ctx(), '/ap/actor', { headers: { accept: '*/*' } }).status,
    200,
  );
});
test('GET and HEAD status and headers agree; HEAD suppresses all bodies', () => {
  for (const path of [
    '/ap/actor',
    '/ap/objects/note',
    '/ap/outbox',
    '/ap/inbox',
    '/nodeinfo',
    '/nodeinfo/2.1',
    '/missing',
  ]) {
    const a = get(ctx(), path),
      b = get(ctx(), path, { method: 'HEAD' });
    assert.equal(b.status, a.status);
    assert.deepEqual(b.headers, a.headers);
    assert.equal(b.body, '');
  }
});
test('unsigned inbox and client writes never return successful receipt or intents', () => {
  for (const path of ['/ap/inbox', '/ap/outbox']) {
    const response = get(ctx(), path, {
      method: 'POST',
      caller: 'admin',
      body: { type: 'Create', actor: 'claimed identity' },
    });
    assert.equal(response.status, 501);
    assert.equal(response.intents, undefined);
  }

  assert.deepEqual(run(ctx()), { intents: [], problems: [] });
  assert.equal(get(ctx(), '/ap/actor', { method: 'DELETE' }).status, 405);
});
test('bounded stable pages do not repeat records and reject invalid cursors', () => {
  const objects = [],
    rows = {};

  for (let n = 0; n < 12; n++) {
    const id = 'item-' + String(n).padStart(2, '0'),
      subject = `https://atomic.example/${id}`;
    objects.push({ id, subject, published: '2026-09-24T12:00:00.000Z' });
    rows[subject] = {
      [P.isA]: ['https://atomicdata.dev/classes/PlainText'],
      [P.description]: id,
    };
  }

  const c = ctx({ objects }, rows);
  const a = body(get(c, '/ap/outbox', { query: { page: '1' } }));
  const b = body(get(c, '/ap/outbox', { query: { page: '2' } }));
  assert.equal(a.orderedItems.length, 10);
  assert.equal(b.orderedItems.length, 2);
  assert.equal(
    new Set([...a.orderedItems, ...b.orderedItems].map(x => x.id)).size,
    12,
  );
  assert.equal(a.next, origin + '/ap/outbox?page=2');
  assert.equal(b.prev, origin + '/ap/outbox?page=1');
  for (const page of ['0', '-1', '1.2', ['1', '2']])
    assert.equal(get(c, '/ap/outbox', { query: { page } }).status, 400);
  assert.equal(get(c, '/ap/outbox', { query: { page: '3' } }).status, 404);
});
test('invalid publication config, oversized text and unsupported classes fail closed', () => {
  for (const override of [
    { origin: 'https://user:secret@host' },
    { origin: origin + '/path' },
    { username: '../admin' },
    { objects: Array(51).fill({}) },
    {
      objects: [
        { id: 'bad', subject: note, published: '2026-02-31T00:00:00.000Z' },
      ],
    },
  ])
    assert.equal(get(ctx(override), '/ap/actor').status, 503);
  const c = ctx();
  c.config.publication.objects.push(c.config.publication.objects[0]);
  assert.equal(get(c, '/ap/actor').status, 503);
  assert.equal(
    get(
      ctx(
        {},
        {
          [note]: {
            [P.isA]: ['https://atomicdata.dev/classes/Message'],
            [P.description]: 'x'.repeat(8193),
          },
        },
      ),
      '/ap/objects/note',
    ).status,
    404,
  );
  assert.equal(
    get(
      ctx({}, { [note]: { [P.isA]: ['Secret'], [P.description]: 'no' } }),
      '/ap/objects/note',
    ).status,
    404,
  );
});
test('release builds reproducibly; public routes have anonymous principal and no writes', async () => {
  const source = await readFile(
    new URL('./plugin.js', import.meta.url),
    'utf8',
  );
  execFileSync(process.execPath, [
    new URL('./build.mjs', import.meta.url).pathname,
  ]);
  assert.equal(
    await readFile(new URL('./plugin.js', import.meta.url), 'utf8'),
    source,
  );
  const built = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  assert.deepEqual(
    built.handle(ctx(), { method: 'GET', path: '/ap/actor' }),
    get(ctx(), '/ap/actor'),
  );
  const m = JSON.parse(
    await readFile(new URL('./manifest.json', import.meta.url)),
  );
  assert.deepEqual(built.manifest, m);
  assert.equal(m.schemaVersion, 3);
  assert.equal(m.http.mount, 'drive-host');

  for (const route of m.http.routes) {
    assert.equal(route.principal, 'anonymous');
    assert.equal(route.auth, 'none');
    assert.equal(route.writes, undefined);
    assert.equal(route.enqueues, undefined);
    if (route.methods.includes('POST')) assert.equal(route.body, 'json');
    if (route.methods.includes('GET')) assert.equal(route.body, undefined);
  }

  for (const claim of m.http.wellKnown)
    assert.ok(m.http.routes.some(r => r.id === claim.route));
});

test('Atomic collection query produces independent expected ordered wire objects', () => {
  const idProperty = 'https://atomicdata.dev/properties/localId';
  const publishedProperty = 'https://atomic.example/properties/published';
  const parent = 'https://atomic.example/feed';
  const c = ctx(
    { publication: { collection: { parent, idProperty, publishedProperty } } },
    {
      [note]: {
        [P.parent]: parent,
        [P.isA]: ['https://atomicdata.dev/classes/Message'],
        [P.description]: 'From atoms',
        [idProperty]: 'alpha',
        [publishedProperty]: '2026-09-25T09:00:00.000Z',
      },
      [document]: {
        [P.parent]: parent,
        [P.isA]: ['https://atomicdata.dev/classes/PlainText'],
        [P.description]: 'Earlier',
        [idProperty]: 'beta',
        [publishedProperty]: '2026-09-24T09:00:00.000Z',
      },
    },
  );

  c.query = (p, v) => {
    assert.equal(p, P.parent);
    assert.equal(v, parent);

    return [document, note, privateSubject];
  };

  const page = body(get(c, '/ap/outbox', { query: { page: '1' } }));
  assert.deepEqual(page.orderedItems[0], {
    '@context': AS,
    id: origin + '/ap/activities/alpha',
    type: 'Create',
    actor: origin + '/ap/actor',
    published: '2026-09-25T09:00:00.000Z',
    to: [PUBLIC],
    object: {
      '@context': AS,
      id: origin + '/ap/objects/alpha',
      type: 'Note',
      attributedTo: origin + '/ap/actor',
      published: '2026-09-25T09:00:00.000Z',
      to: [PUBLIC],
      url: note,
      content: '<p>From atoms</p>',
      mediaType: 'text/html',
    },
  });
  assert.equal(page.orderedItems.length, 2);
  assert.deepEqual(
    body(get(c, '/ap/objects/alpha')),
    page.orderedItems[0].object,
  );

  c.query = () => {
    throw Error('truncated query');
  };

  assert.equal(get(c, '/ap/outbox').status, 503);
});

test('collection identity ambiguity and parent escape fail closed', () => {
  const parent = 'https://atomic.example/feed',
    idProperty = 'https://atomicdata.dev/properties/localId',
    publishedProperty = 'https://atomic.example/published';
  const row = {
    [P.parent]: parent,
    [P.isA]: ['https://atomicdata.dev/classes/Message'],
    [P.description]: 'text',
    [idProperty]: 'same',
    [publishedProperty]: '2026-09-25T09:00:00.000Z',
  };
  const c = ctx(
    { publication: { collection: { parent, idProperty, publishedProperty } } },
    { [note]: row, [document]: { ...row } },
  );
  c.query = () => [note, document];
  assert.equal(get(c, '/ap/outbox').status, 503);
  c.query = () => Array(51).fill(note);
  assert.equal(get(c, '/ap/outbox').status, 503);
  c.query = () => [profile];
  assert.equal(body(get(c, '/ap/outbox')).totalItems, 0);
});

test('conditional representations track content, type, HEAD and precondition priority', () => {
  const c = ctx();
  const original = get(c, '/ap/objects/note');
  const tag = original.headers.etag;
  assert.match(tag, /^"[a-f0-9]{64}"$/);
  assert.equal(
    get(c, '/ap/objects/note', { method: 'HEAD' }).headers.etag,
    tag,
  );
  const unchanged = get(c, '/ap/objects/note', {
    headers: { 'if-none-match': 'W/' + tag },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, '');
  assert.equal(
    get(c, '/ap/objects/note', { headers: { 'if-match': 'W/' + tag } }).status,
    412,
  );
  assert.equal(
    get(c, '/ap/objects/note', {
      headers: { 'if-match': '"stale"', 'if-none-match': tag },
    }).status,
    412,
  );
  assert.equal(
    get(c, '/ap/objects/note', { headers: { 'if-none-match': 'broken' } })
      .status,
    400,
  );
  assert.notEqual(
    get(c, '/ap/objects/note', { headers: { accept: 'application/ld+json' } })
      .headers.etag,
    tag,
  );
  const changed = ctx(
    {},
    {
      [note]: {
        [P.isA]: ['https://atomicdata.dev/classes/Message'],
        [P.description]: 'Changed',
      },
    },
  );
  assert.equal(
    get(changed, '/ap/objects/note', { headers: { 'if-none-match': tag } })
      .status,
    200,
  );
  assert.notEqual(get(changed, '/ap/objects/note').headers.etag, tag);
  assert.equal(
    get(c, '/ap/objects/private', { headers: { 'if-none-match': '*' } }).status,
    404,
  );
});

test('portable ETag hash matches independent SHA256 including Unicode', async () => {
  const { createHash } = await import('node:crypto');
  const { sha256 } = await import('./sha256.mjs');
  for (const input of ['', 'abc', '🌍'.repeat(100), 'x'.repeat(1000)])
    assert.equal(
      sha256(input),
      createHash('sha256').update(input).digest('hex'),
    );
});

test('collection paging is independent of Atomic query order', () => {
  const parent = 'https://atomic.example/feed',
    idProperty = 'https://atomic.example/id',
    publishedProperty = 'https://atomic.example/published';
  const rows = {},
    subjects = [];

  for (let i = 0; i < 12; i++) {
    const id = 'item-' + String(i).padStart(2, '0'),
      subject = 'https://atomic.example/' + id;
    subjects.push(subject);
    rows[subject] = {
      [P.parent]: parent,
      [P.isA]: ['https://atomicdata.dev/classes/Message'],
      [P.description]: id,
      [idProperty]: id,
      [publishedProperty]: '2026-09-25T09:00:00.000Z',
    };
  }

  const c = ctx(
    { publication: { collection: { parent, idProperty, publishedProperty } } },
    rows,
  );
  c.query = () => subjects.toReversed();
  const first = body(get(c, '/ap/outbox', { query: { page: '1' } }));
  c.query = () => subjects;
  const second = body(get(c, '/ap/outbox', { query: { page: '2' } }));
  assert.deepEqual(
    [...first.orderedItems, ...second.orderedItems].map(
      item => item.object.url,
    ),
    subjects,
  );
  assert.equal(first.next, origin + '/ap/outbox?page=2');
  assert.equal(second.prev, origin + '/ap/outbox?page=1');
  assert.equal(body(get(c, '/ap/outbox')).totalItems, 12);
});

test('canonical Atomic profile and objects retain HTTPS protocol IDs and resolution links', () => {
  const canonicalProfile = 'atomic:agent:profileKey';
  const canonicalNote = 'atomic:noteGenesis';
  const canonicalDocument = 'atomic:genesis+/==';
  const reads = [];
  const c = ctx(
    {
      profile: canonicalProfile,
      objects: [
        {
          id: 'note',
          subject: canonicalNote,
          published: '2026-09-24T12:00:00.000Z',
        },
        {
          id: 'document',
          subject: canonicalDocument,
          published: '2026-09-24T11:00:00.000Z',
        },
      ],
    },
    {
      [canonicalProfile]: { [P.name]: 'Canonical actor' },
      [canonicalNote]: {
        [P.isA]: ['https://atomicdata.dev/classes/PlainText'],
        [P.description]: 'Actual atom content',
      },
      [canonicalDocument]: {
        [P.isA]: ['https://atomicdata.dev/classes/DocumentV2'],
        [P.name]: 'Native document',
      },
    },
  );
  const read = c.read;

  c.read = subject => {
    reads.push(subject);

    return read(subject);
  };

  const actor = body(get(c, '/ap/actor'));
  assert.equal(actor.id, origin + '/ap/actor');
  assert.equal(
    actor.url,
    origin + '/resource?subject=' + encodeURIComponent(canonicalProfile),
  );
  const projected = body(get(c, '/ap/objects/note'));
  assert.equal(projected.content, '<p>Actual atom content</p>');
  assert.equal(
    projected.url,
    origin + '/resource?subject=' + encodeURIComponent(canonicalNote),
  );
  const article = body(get(c, '/ap/objects/document'));
  assert.equal(
    article.url,
    origin + '/resource?subject=' + encodeURIComponent(canonicalDocument),
  );
  assert.equal(article.type, 'Article');
  assert.ok(reads.includes(canonicalProfile));
  assert.ok(reads.includes(canonicalNote));
});

test('legacy subject aliases canonicalize before reads and duplicate identity checks', () => {
  const c = ctx(
    {
      profile: 'did:ad:profileKey',
      objects: [
        {
          id: 'note',
          subject: 'did:ad:noteKey',
          published: '2026-09-24T12:00:00.000Z',
        },
      ],
    },
    {
      'atomic:profileKey': { [P.name]: 'Alias actor' },
      'atomic:noteKey': {
        [P.isA]: ['https://atomicdata.dev/classes/PlainText'],
        [P.description]: 'Alias note',
      },
    },
  );
  assert.equal(
    body(get(c, '/ap/objects/note')).url,
    origin + '/resource?subject=atomic%3AnoteKey',
  );
  c.config.publication.objects.push({
    id: 'duplicate',
    subject: 'atomic:noteKey',
    published: '2026-09-24T12:00:00.000Z',
  });
  assert.equal(get(c, '/ap/actor').status, 503);
});

test('collection canonical parent/property subjects and canonical query results publish native resources', () => {
  const parent = 'atomic:collectionGenesis',
    publishedProperty = 'atomic:publishedProperty';
  const c = ctx(
    {
      publication: {
        collection: {
          parent: 'did:ad:collectionGenesis',
          idProperty: 'did:ad:idProperty',
          publishedProperty,
        },
      },
    },
    {
      'atomic:noteKey': {
        [P.parent]: 'did:ad:collectionGenesis',
        [P.isA]: ['https://atomicdata.dev/classes/PlainText'],
        [P.description]: 'Canonical collection content',
        'did:ad:idProperty': 'native',
        [publishedProperty]: '2026-09-24T12:00:00.000Z',
      },
    },
  );

  c.query = (property, value) => {
    assert.equal(property, P.parent);
    assert.equal(value, parent);

    return ['did:ad:noteKey'];
  };

  const page = body(get(c, '/ap/outbox', { query: { page: '1' } }));
  assert.equal(page.orderedItems.length, 1);
  assert.equal(page.orderedItems[0].object.id, origin + '/ap/objects/native');
  assert.equal(
    page.orderedItems[0].object.url,
    origin + '/resource?subject=atomic%3AnoteKey',
  );
  c.query = () => ['did:ad:noteKey', 'atomic:noteKey'];
  assert.equal(get(c, '/ap/outbox').status, 503);
});

test('private canonical resources stay hidden even with a previously valid ETag', () => {
  const c = ctx(
    {
      objects: [
        {
          id: 'private',
          subject: 'atomic:privateNote',
          published: '2026-09-24T12:00:00.000Z',
        },
      ],
    },
    {
      'atomic:privateNote': {
        [P.isA]: ['https://atomicdata.dev/classes/PlainText'],
        [P.description]: 'Previously public',
      },
    },
  );
  const etag = get(c, '/ap/objects/private').headers.etag;
  const read = c.read;

  c.read = subject => {
    if (subject === 'atomic:privateNote') throw Error('Now private');

    return read(subject);
  };

  assert.equal(
    get(c, '/ap/objects/private', { headers: { 'if-none-match': etag } })
      .status,
    404,
  );
  assert.equal(body(get(c, '/ap/outbox')).totalItems, 0);
});

test('malformed Atomic identifiers and links are not valid local publication subjects', () => {
  for (const invalid of [
    'atomic:',
    'did:ad:',
    'atomic://open/foo',
    'atomic:agent:',
    'atomic:unknown:foo',
    'atomic:has space',
    'atomic:line\nbreak',
    'atomic:a?query=1',
    'atomic:a#fragment',
    'atomic:%61',
    'atomic:a===',
    'javascript:alert(1)',
  ]) {
    assert.equal(
      get(ctx({ profile: invalid }), '/ap/actor').status,
      503,
      invalid,
    );
    assert.equal(
      get(
        ctx({
          objects: [
            {
              id: 'invalid',
              subject: invalid,
              published: '2026-09-24T12:00:00.000Z',
            },
          ],
        }),
        '/ap/outbox',
      ).status,
      503,
      invalid,
    );
    const c = ctx({
      publication: {
        collection: {
          parent: 'atomic:parent',
          idProperty: 'atomic:id',
          publishedProperty: 'atomic:published',
        },
      },
    });
    c.query = () => [invalid];
    assert.equal(get(c, '/ap/outbox').status, 503, invalid);
  }
});
