/** Dependency-free QuickJS read-only ActivityStreams projection of public atoms. */
export const AS = 'https://www.w3.org/ns/activitystreams';
export const PUBLIC = `${AS}#Public`;
export const P = Object.freeze({
  isA: 'https://atomicdata.dev/properties/isA',
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
});
const NOTE_CLASSES = ['https://atomicdata.dev/classes/Message', 'https://atomicdata.dev/classes/PlainText'];
const DOCUMENT_CLASSES = ['https://atomicdata.dev/classes/Document', 'https://atomicdata.dev/classes/DocumentV2'];
const MIME = 'application/activity+json';
const LD = `application/ld+json; profile="${AS}"`;
const SCHEMA = 'http://nodeinfo.diaspora.software/ns/schema/2.1';
const PAGE_SIZE = 10;
const MAX_ITEMS = 50;
const MAX_TEXT = 8192;
function validText(value, max = MAX_TEXT) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
function slug(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value); }
function httpsSubject(value) {
  return validText(value, 2048) && /^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?(?:\/[^\s\\]*)?$/.test(value);
}
export function html(text) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])).replace(/\r?\n/g, '<br>');
}
function config(ctx) {
  const c = ctx.config ?? {};
  if (!validText(c.origin, 255) || !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/.test(c.origin) || !slug(c.username) || !httpsSubject(c.profile))
    throw new Error('Invalid actor configuration');
  if (!Array.isArray(c.objects) || c.objects.length > MAX_ITEMS) throw new Error('Configure at most 50 object bindings');
  const ids = new Set();
  const subjects = new Set();
  for (const item of c.objects) {
    if (!item || !slug(item.id) || !httpsSubject(item.subject) ||
        typeof item.published !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(item.published) ||
        !Number.isFinite(Date.parse(item.published)) || new Date(item.published).toISOString() !== item.published ||
        ids.has(item.id) || subjects.has(item.subject)) throw new Error('Invalid or duplicate object binding');
    ids.add(item.id); subjects.add(item.subject);
  }
  return { ...c, actor: `${c.origin}/ap/actor`, account: `acct:${c.username}@${c.origin.slice(8)}` };
}
function readPublic(ctx, subject) {
  // manifest principal:anonymous -> pinned host ForAgent::Public, plus grants.
  // A returned resource is already subject to host permission checking.
  try { return ctx.read(subject); } catch { return undefined; }
}
function profile(ctx, c) {
  const row = readPublic(ctx, c.profile);
  if (!row || !validText(row[P.name], 255) || !row[P.name]) return undefined;
  return row;
}
export function objectFor(ctx, c, binding) {
  const row = readPublic(ctx, binding.subject);
  if (!row || !Array.isArray(row[P.isA])) return undefined;
  const note = row[P.isA].some(t => NOTE_CLASSES.includes(t));
  const article = row[P.isA].some(t => DOCUMENT_CLASSES.includes(t));
  if (!note && !article) return undefined;
  if (note && !validText(row[P.description])) return undefined;
  if (article && (!validText(row[P.name], 255) || !row[P.name])) return undefined;
  return {
    '@context': AS, id: `${c.origin}/ap/objects/${binding.id}`, type: note ? 'Note' : 'Article',
    attributedTo: c.actor, published: binding.published, to: [PUBLIC], url: binding.subject,
    ...(validText(row[P.name], 255) ? { name: row[P.name] } : {}),
    ...(note ? { content: `<p>${html(row[P.description])}</p>`, mediaType: 'text/html' } : {}),
    ...(article ? { summary: 'Open the linked Atomic document to read its content.' } : {}),
  };
}
function activity(c, object, id) {
  return { '@context': AS, id: `${c.origin}/ap/activities/${id}`, type: 'Create', actor: c.actor, published: object.published, to: [PUBLIC], object };
}
function visible(ctx, c) {
  return c.objects.map(binding => ({ binding, object: objectFor(ctx, c, binding) }))
    .filter(row => row.object)
    .sort((a, b) => a.binding.published === b.binding.published ? (a.binding.id < b.binding.id ? -1 : a.binding.id > b.binding.id ? 1 : 0) : a.binding.published > b.binding.published ? -1 : 1);
}
// Honor explicit q=0 exclusions even in the presence of a wildcard.
export function negotiate(accept) {
  if (accept === undefined || accept === '') return MIME;
  if (typeof accept !== 'string' || accept.length > 2048) return undefined;
  const entries = accept.split(',').map(raw => {
    const [type, ...parameters] = raw.trim().toLowerCase().split(';');
    const q = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    return { type: type.trim(), quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0 };
  });
  const quality = type => {
    const exact = entries.filter(e => e.type === type);
    const ranges = exact.length ? exact : entries.filter(e => e.type === 'application/*');
    const matches = ranges.length ? ranges : entries.filter(e => e.type === '*/*');
    return Math.max(0, ...matches.map(e => e.quality));
  };
  const a = quality(MIME), l = quality('application/ld+json');
  return a === 0 && l === 0 ? undefined : a >= l ? MIME : LD;
}
function reply(status, value, method, type = 'application/json') {
  return { status, headers: { 'content-type': type, 'cache-control': 'no-store', vary: 'Accept' }, body: method === 'HEAD' ? '' : JSON.stringify(value) };
}
export function handle(ctx, request) {
  const method = request.method;
  const path = request.path;
  const q = request.query ?? {};
  if (method === 'POST' && (path === '/ap/inbox' || path === '/ap/outbox'))
    return reply(501, { error: 'Signed ActivityPub delivery and authorized writes are unavailable on this host' }, method);
  if (method !== 'GET' && method !== 'HEAD') return reply(405, { error: 'Method not allowed' }, method);
  let c;
  try { c = config(ctx); } catch { return reply(503, { error: 'Actor configuration unavailable' }, method); }
  // No discovery, actor data, object counts or objects are exposed if the
  // backing profile itself is not readable anonymously.
  const source = profile(ctx, c);
  if (!source) return reply(404, { error: 'Not found' }, method);
  if (path === '/webfinger' || request.wellKnown === 'webfinger') {
    if (typeof q.resource !== 'string') return reply(400, { error: 'One resource parameter is required' }, method);
    if (q.resource !== c.account && q.resource !== c.actor) return reply(404, { error: 'Not found' }, method);
    const rels = q.rel === undefined ? undefined : Array.isArray(q.rel) ? q.rel : [q.rel];
    return reply(200, { subject: c.account, aliases: [c.actor], links: rels && !rels.includes('self') ? [] : [{ rel: 'self', type: MIME, href: c.actor }] }, method, 'application/jrd+json');
  }
  if (path === '/nodeinfo' || request.wellKnown === 'nodeinfo')
    return reply(200, { links: [{ rel: SCHEMA, href: `${c.origin}/nodeinfo/2.1` }] }, method);
  if (path === '/nodeinfo/2.1')
    return reply(200, { version: '2.1', software: { name: 'atomic-fediverse', version: '0.1.0' }, protocols: [], services: { inbound: [], outbound: [] }, openRegistrations: false, usage: { users: { total: 1 }, localPosts: visible(ctx, c).length }, metadata: { activityStreamsReadOnly: true, federationEnabled: false } }, method, `application/json; profile="${SCHEMA}#"`);
  const type = negotiate(request.headers?.accept);
  if (!type) return reply(406, { error: 'Request an ActivityStreams JSON representation' }, method);
  if (path === '/ap/actor') return reply(200, {
    '@context': AS, id: c.actor, type: 'Service', preferredUsername: c.username,
    name: source[P.name], summary: validText(source[P.description]) ? html(source[P.description]) : '',
    url: c.profile, inbox: `${c.origin}/ap/inbox`, outbox: `${c.origin}/ap/outbox`,
  }, method, type);
  if (path === '/ap/inbox') return reply(501, { error: 'Inbox is unavailable' }, method);
  if (path === '/ap/outbox') {
    const rows = visible(ctx, c);
    const base = `${c.origin}/ap/outbox`;
    if (q.page === undefined) return reply(200, { '@context': AS, id: base, type: 'OrderedCollection', totalItems: rows.length, first: `${base}?page=1` }, method, type);
    if (typeof q.page !== 'string' || !/^[1-9][0-9]{0,2}$/.test(q.page)) return reply(400, { error: 'Invalid page' }, method);
    const page = Number(q.page), start = (page - 1) * PAGE_SIZE;
    if (page > Math.max(1, Math.ceil(rows.length / PAGE_SIZE))) return reply(404, { error: 'Not found' }, method);
    return reply(200, { '@context': AS, id: `${base}?page=${page}`, type: 'OrderedCollectionPage', partOf: base,
      orderedItems: rows.slice(start, start + PAGE_SIZE).map(row => activity(c, row.object, row.binding.id)),
      ...(page > 1 ? { prev: `${base}?page=${page - 1}` } : {}),
      ...(start + PAGE_SIZE < rows.length ? { next: `${base}?page=${page + 1}` } : {}),
    }, method, type);
  }
  const match = /^\/ap\/(objects|activities)\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(path);
  if (match) {
    const binding = c.objects.find(item => item.id === match[2]);
    const object = binding && objectFor(ctx, c, binding);
    if (object) return reply(200, match[1] === 'objects' ? object : activity(c, object, binding.id), method, type);
  }
  return reply(404, { error: 'Not found' }, method);
}
export function run() { return { intents: [], problems: [] }; }
