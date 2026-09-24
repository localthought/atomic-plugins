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
    [profile]: { [P.name]: 'Atomic news', [P.description]: '<script>Profile</script>', secret: 'NO' },
    [note]: { [P.isA]: ['https://atomicdata.dev/classes/Message'], [P.description]: 'Hello <script>alert(1)</script>\nWorld', secret: 'NO' },
    [document]: { [P.isA]: ['https://atomicdata.dev/classes/DocumentV2'], [P.name]: 'Design', 'https://atomicdata.dev/properties/documentContent': 'DO-NOT-EXPOSE-LORO' },
    ...rows,
  };
  return { config: { origin, username: 'news', profile, objects: [
    { id: 'note', subject: note, published: '2026-09-24T12:00:00.000Z' },
    { id: 'document', subject: document, published: '2026-09-24T11:00:00.000Z' },
    { id: 'private', subject: privateSubject, published: '2026-09-24T13:00:00.000Z' },
  ], ...overrides }, read(subject) { if (!(subject in data)) throw new Error('Permission denied'); return data[subject]; } };
}
function get(c, path, options = {}) { return handle(c, { method: 'GET', path, ...options }); }
function body(result) { assert.equal(result.status, 200); return JSON.parse(result.body); }
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
  assert.equal(message.content, '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;<br>World</p>');
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
  assert.deepEqual(page.orderedItems[0], body(get(ctx(), '/ap/activities/note')));
  assert.ok(!JSON.stringify(page).includes(privateSubject));
});
test('private source, private profile and unbound paths are not disclosed', () => {
  assert.equal(get(ctx(), '/ap/objects/private').status, 404);
  assert.equal(get(ctx(), '/ap/objects/missing').status, 404);
  assert.equal(get(ctx(), '/ap/objects/../profile').status, 404);
  const c = ctx(); c.read = () => { throw new Error('Private profile details'); };
  for (const path of ['/ap/actor', '/ap/outbox', '/nodeinfo', '/nodeinfo/2.1', '/webfinger']) {
    const response = get(c, path);
    assert.equal(response.status, 404);
    assert.ok(!response.body.includes('Private profile details'));
  }
});
test('WebFinger exact account matching, repeated resources and rel filtering', () => {
  const c = ctx();
  const response = get(c, '/.well-known/webfinger', { wellKnown: 'webfinger', query: { resource: 'acct:news@social.example' } });
  assert.equal(response.headers['content-type'], 'application/jrd+json');
  assert.equal(body(response).links[0].href, origin + '/ap/actor');
  assert.equal(get(c, '/webfinger', { query: { resource: 'acct:other@social.example' } }).status, 404);
  assert.equal(get(c, '/webfinger', { query: { resource: ['acct:news@social.example', 'x'] } }).status, 400);
  assert.deepEqual(body(get(c, '/webfinger', { query: { resource: 'acct:news@social.example', rel: 'other' } })).links, []);
  assert.equal(body(get(c, '/webfinger', { query: { resource: 'acct:news@social.example', rel: ['other', 'self'] } })).links.length, 1);
});
test('NodeInfo discovery does not claim enabled federation or count private objects', () => {
  const links = body(get(ctx(), '/.well-known/nodeinfo', { wellKnown: 'nodeinfo' }));
  assert.equal(links.links[0].href, origin + '/nodeinfo/2.1');
  const info = body(get(ctx(), '/nodeinfo/2.1'));
  assert.equal(info.version, '2.1');
  assert.deepEqual(info.protocols, []);
  assert.equal(info.metadata.federationEnabled, false);
  assert.equal(info.usage.localPosts, 2);
});
test('content negotiation supports both ActivityPub representations and q exclusions', () => {
  assert.equal(negotiate('application/activity+json'), 'application/activity+json');
  assert.equal(negotiate('application/ld+json; profile="https://www.w3.org/ns/activitystreams"'), `application/ld+json; profile="${AS}"`);
  assert.equal(negotiate('application/activity+json;q=0, application/ld+json;q=0, */*;q=1'), undefined);
  assert.equal(negotiate('text/html'), undefined);
  assert.equal(get(ctx(), '/ap/actor', { headers: { accept: 'text/html' } }).status, 406);
  assert.equal(get(ctx(), '/ap/actor', { headers: { accept: '*/*' } }).status, 200);
});
test('GET and HEAD status and headers agree; HEAD suppresses all bodies', () => {
  for (const path of ['/ap/actor', '/ap/objects/note', '/ap/outbox', '/ap/inbox', '/nodeinfo', '/nodeinfo/2.1', '/missing']) {
    const a = get(ctx(), path), b = get(ctx(), path, { method: 'HEAD' });
    assert.equal(b.status, a.status);
    assert.deepEqual(b.headers, a.headers);
    assert.equal(b.body, '');
  }
});
test('unsigned inbox and client writes never return successful receipt or intents', () => {
  for (const path of ['/ap/inbox', '/ap/outbox']) {
    const response = get(ctx(), path, { method: 'POST', caller: 'admin', body: { type: 'Create', actor: 'claimed identity' } });
    assert.equal(response.status, 501);
    assert.equal(response.intents, undefined);
  }
  assert.deepEqual(run(ctx()), { intents: [], problems: [] });
  assert.equal(get(ctx(), '/ap/actor', { method: 'DELETE' }).status, 405);
});
test('bounded stable pages do not repeat records and reject invalid cursors', () => {
  const objects = [], rows = {};
  for (let n = 0; n < 12; n++) {
    const id = 'item-' + String(n).padStart(2, '0'), subject = `https://atomic.example/${id}`;
    objects.push({ id, subject, published: '2026-09-24T12:00:00.000Z' });
    rows[subject] = { [P.isA]: ['https://atomicdata.dev/classes/PlainText'], [P.description]: id };
  }
  const c = ctx({ objects }, rows);
  const a = body(get(c, '/ap/outbox', { query: { page: '1' } }));
  const b = body(get(c, '/ap/outbox', { query: { page: '2' } }));
  assert.equal(a.orderedItems.length, 10);
  assert.equal(b.orderedItems.length, 2);
  assert.equal(new Set([...a.orderedItems, ...b.orderedItems].map(x => x.id)).size, 12);
  assert.equal(a.next, origin + '/ap/outbox?page=2');
  assert.equal(b.prev, origin + '/ap/outbox?page=1');
  for (const page of ['0', '-1', '1.2', ['1', '2']]) assert.equal(get(c, '/ap/outbox', { query: { page } }).status, 400);
  assert.equal(get(c, '/ap/outbox', { query: { page: '3' } }).status, 404);
});
test('invalid publication config, oversized text and unsupported classes fail closed', () => {
  for (const override of [{ origin: 'https://user:secret@host' }, { origin: origin + '/path' }, { username: '../admin' }, { objects: Array(51).fill({}) }, { objects: [{ id: 'bad', subject: note, published: '2026-02-31T00:00:00.000Z' }] }])
    assert.equal(get(ctx(override), '/ap/actor').status, 503);
  const c = ctx(); c.config.objects.push(c.config.objects[0]);
  assert.equal(get(c, '/ap/actor').status, 503);
  assert.equal(get(ctx({}, { [note]: { [P.isA]: ['https://atomicdata.dev/classes/Message'], [P.description]: 'x'.repeat(8193) } }), '/ap/objects/note').status, 404);
  assert.equal(get(ctx({}, { [note]: { [P.isA]: ['Secret'], [P.description]: 'no' } }), '/ap/objects/note').status, 404);
});
test('release builds reproducibly; public routes have anonymous principal and no writes', async () => {
  const source = await readFile(new URL('./plugin.js', import.meta.url), 'utf8');
  execFileSync(process.execPath, [new URL('./build.mjs', import.meta.url).pathname]);
  assert.equal(await readFile(new URL('./plugin.js', import.meta.url), 'utf8'), source);
  const built = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.deepEqual(built.handle(ctx(), { method: 'GET', path: '/ap/actor' }), get(ctx(), '/ap/actor'));
  const m = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url)));
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
  for (const claim of m.http.wellKnown) assert.ok(m.http.routes.some(r => r.id === claim.route));
});
