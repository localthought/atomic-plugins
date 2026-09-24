/** QuickJS-compatible remoteStorage text importer and public read adapter.
 * No network, filesystem, Buffer, URL, crypto or browser globals are required.
 */
export const P = Object.freeze({
  parent: 'https://atomicdata.dev/properties/parent',
  name: 'https://atomicdata.dev/properties/name',
  localId: 'https://atomicdata.dev/properties/localId',
  baseline: 'https://atomicdata.dev/properties/importBaseline',
  content: 'https://atomicdata.dev/properties/description',
});
const MAX_BYTES = 262144;
const MAX_RECORDS = 128;
const FOLDER_CONTEXT = 'http://remotestorage.io/spec/folder-description';
export const manifest = {
  schemaVersion: 3, name: 'remotestorage', namespace: 'atomic-plugins', version: '0.2.0',
  description: 'Import remoteStorage text exports as Atomic documents and serve explicitly public categories.',
  operations: [], secrets: [],
  capabilities: [{ name: 'storage', reason: 'Read scoped Atomic resources; propose reviewed document import intents.' }],
  config: {
    key: 'remotestorage',
    properties: {
      table: { type: 'string', description: 'Parent resource for reviewed text imports' },
      publicCategories: { type: 'object', description: 'Explicit public category to parent resource mapping; private parents are refused by host read permissions' },
    },
    required: ['table'],
  },
  accepts: [{ extensions: ['.json'], mediaTypes: ['application/json'], as: 'text', maxBytes: MAX_BYTES }],
  http: {
    mount: 'drive-prefix',
    reason: 'Read explicitly exported public text documents. No public write route or private-data authority.',
    routes: [{ id: 'public-storage', path: '/storage/public/{*rest}', methods: ['GET', 'HEAD'],
      principal: 'anonymous', auth: 'none', cors: 'any-origin-no-credentials' }],
  },
};

export function utf8(text) {
  // encodeURIComponent rejects unpaired surrogates, preventing silently changed bytes.
  const encoded = encodeURIComponent(text), out = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') { out.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(encoded.charCodeAt(i));
  }
  return out;
}
export function sha256(text) {
  const bytes = utf8(text), bits = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bits / 2 ** (i * 8)) & 255);
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) w[i] = (bytes[offset+i*4]<<24)|(bytes[offset+i*4+1]<<16)|(bytes[offset+i*4+2]<<8)|bytes[offset+i*4+3];
    for (let i = 16; i < 64; i++) {
      const a = w[i-15], b = w[i-2];
      w[i] = (w[i-16]+(rotr(a,7)^rotr(a,18)^(a>>>3))+w[i-7]+(rotr(b,17)^rotr(b,19)^(b>>>10)))|0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[i]+w[i])|0;
      const t2 = ((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))|0;
      [a,b,c,d,e,f,g,h] = [(t1+t2)|0,a,b,c,(d+t1)|0,e,f,g];
    }
    [a,b,c,d,e,f,g,h].forEach((v,i) => { H[i] = (H[i]+v)|0; });
  }
  return H.map(x => (x>>>0).toString(16).padStart(8,'0')).join('');
}
function fail(message) { throw new Error(message); }
export function pathParts(path) {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/')) fail('Invalid storage path');
  const folder = path.endsWith('/');
  const pieces = path.slice(1, folder ? -1 : undefined).split('/');
  if (pieces.length > 32) fail('Path depth limit exceeded');
  for (const part of pieces) {
    if (!part || part === '.' || part === '..' || /[%\\?#\x00-\x1f\x7f]/.test(part)) fail('Invalid storage path segment');
  }
  return { pieces, folder };
}
function validateDocument(doc) {
  const { pieces, folder } = pathParts(doc.path);
  if (folder || pieces.length < (pieces[0] === 'public' ? 3 : 2)) fail('Document path needs category and filename');
  if (typeof doc.text !== 'string' || utf8(doc.text).length > MAX_BYTES) fail('Only bounded UTF-8 text is supported');
  if (typeof doc.contentType !== 'string' || !/^(text\/[a-z0-9.+-]+|application\/(json|[a-z0-9.+-]+\+json))(; charset=utf-8)?$/i.test(doc.contentType)) fail('Only UTF-8 text/JSON media types are supported');
  if (/^text\/html(?:;|$)/i.test(doc.contentType)) fail('HTML cannot be served from the shared drive-prefix origin');
  return { path: doc.path, text: doc.text, contentType: doc.contentType };
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function baseline(resource) {
  const data = resource[P.baseline];
  if (!data || data.protocol !== 'remoteStorage-text-v1') return null;
  return validateDocument(data);
}
function sameDisplay(resource, doc) {
  return resource[P.content] === doc.text;
}
/** Existing host importer contract: proposals only; host previews, authorizes and applies. */
export function run(ctx) {
  try {
    const parent = ctx.config?.table;
    if (typeof parent !== 'string' || !/^(https?:\/\/|did:ad:)/.test(parent)) fail('Configure table with an Atomic parent subject');
    const text = ctx.upload?.text;
    if (typeof text !== 'string' || utf8(text).length > MAX_BYTES) fail('Upload a bounded JSON text export');
    const batch = JSON.parse(text);
    if (!Array.isArray(batch.documents) || batch.documents.length > MAX_RECORDS) fail('Expected at most 128 documents');
    const documents = batch.documents.map(validateDocument);
    if (new Set(documents.map(d=>d.path)).size !== documents.length) fail('Duplicate document path');
    // File/folder collisions are rejected even across separate import runs.
    const subjects = ctx.query(P.parent, parent);
    if (!Array.isArray(subjects) || subjects.length > MAX_RECORDS) fail('Destination exceeds 128 records');
    const existing = subjects.map(subject => ({ subject, resource: ctx.read(subject) })).filter(({resource})=>resource[P.parent]===parent);
    const existingDocs = existing.map(item=>({...item, doc:baseline(item.resource)})).filter(item=>item.doc);
    const paths = [...new Set([...existingDocs.map(item=>item.doc.path), ...documents.map(d=>d.path)])];
    if (paths.length > MAX_RECORDS) fail('Destination exceeds 128 documents');
    if (paths.some(a=>paths.some(b=>a!==b && b.startsWith(a+'/')))) fail('Document/folder path collision');
    const intents = [];
    for (const doc of documents) {
      const key = 'remotestorage:'+sha256(doc.path);
      const matches = existing.filter(({resource})=>resource[P.localId]===key);
      if (matches.length > 1) fail('Duplicate persistent document identity');
      const set = { [P.name]: doc.path.split('/').pop(), [P.localId]:key,
        [P.content]:doc.text, [P.baseline]:{protocol:'remoteStorage-text-v1', ...doc} };
      if (!matches.length) intents.push({op:'create',localId:key,parent,isA:[],set});
      else {
        const {subject,resource} = matches[0], previous = baseline(resource);
        if (!previous || previous.path!==doc.path || !sameDisplay(resource,previous)) fail('Local document edits require review before replacing source text');
        if (canonical(previous)!==canonical(doc)) intents.push({op:'set',subject,set});
      }
    }
    return { intents, problems: [] };
  } catch (error) {
    return { intents: [], problems: [{ severity:'error',message:error.message }] };
  }
}

/** Actual ctx.query returns subjects; ctx.read returns Atomic JSON-AD property maps. */
export function readCategory(ctx, category) {
  if (!/^[a-zA-Z0-9_-]+$/.test(category)) fail('Invalid category');
  const exports = ctx.config?.publicCategories;
  if (!exports || !Object.prototype.hasOwnProperty.call(exports,category)) return null;
  const parent = exports[category];
  if (typeof parent!=='string' || !/^(https?:\/\/|did:ad:)/.test(parent)) fail('Invalid category parent');
  const subjects = ctx.query(P.parent,parent);
  if (!Array.isArray(subjects) || subjects.length>MAX_RECORDS) fail('Category exceeds 128 records');
  const records = [];
  for (const subject of subjects) {
    const resource = ctx.read(subject); // host applies anonymous AND installation rights
    if (resource[P.parent]!==parent) continue;
    const doc = baseline(resource);
    if (!doc || !doc.path.startsWith('/public/'+category+'/')) continue;
    if (!sameDisplay(resource,doc)) fail('Local edits require a reviewed text export before serving');
    records.push(doc);
  }
  if (new Set(records.map(d=>d.path)).size!==records.length) fail('Ambiguous storage path');
  if (records.some(a=>records.some(b=>a!==b && b.path.startsWith(a.path+'/')))) fail('Document/folder path collision');
  return records;
}
function header(request,name) {
  const pairs = Object.entries(request.headers || {}).filter(([key])=>key.toLowerCase()===name);
  if (pairs.length>1 || (pairs.length && typeof pairs[0][1]!=='string')) fail('Ambiguous request header');
  return pairs[0]?.[1];
}
function etag(doc) { return '"'+sha256(canonical(doc))+'"'; }
function tagMatches(value, tag, weak) {
  if (value.trim()==='*') return true;
  // Quoted opaque tags may contain commas; parse them without split(',').
  if (!value.trim()) fail('Malformed ETag condition');
  const tags = value.match(/(?:W\/)?"[^"\x00-\x20\x7f]*"/g) || [];
  if (tags.join(',')!==value.replace(/\s*,\s*/g,',').trim()) fail('Malformed ETag condition');
  return tags.some(t=>weak ? t.replace(/^W\//,'')===tag : t===tag);
}
function folderRepresentation(docs, path) {
  const items = Object.create(null), folders = new Set();
  for (const doc of docs.filter(d=>d.path.startsWith(path))) {
    const rest=doc.path.slice(path.length), slash=rest.indexOf('/');
    if (slash<0) items[rest]={'ETag':etag(doc).slice(1,-1),'Content-Type':doc.contentType,'Content-Length':utf8(doc.text).length};
    else folders.add(rest.slice(0,slash+1));
  }
  for (const key of folders) items[key]={'ETag':folderRepresentation(docs,path+key).tag.slice(1,-1)};
  const body=canonical({'@context':FOLDER_CONTEXT,items});
  return {body,tag:'"'+sha256(body)+'"'};
}
function response(status, body='', headers={}) {
  return {status,headers:{'cache-control':'no-cache','content-type':'text/plain; charset=utf-8',
    'access-control-expose-headers':'ETag, Content-Type',
    'access-control-allow-methods':'GET, HEAD, OPTIONS',
    'access-control-allow-headers':'If-Match, If-None-Match',...headers},body};
}
/** Only public reads are registered. Authenticated writes require missing host facilities. */
export function handle(ctx, request) {
  try {
    const method = request.method;
    if (!['GET','HEAD'].includes(method)) return response(405,'Method not allowed',{allow:'GET, HEAD, OPTIONS'});
    // Decode each URI segment once; refuse encoded separators and nested escapes.
    if (typeof request.path!=='string' || !request.path.startsWith('/storage/public/')) return response(401,'Private storage requires host-verified scoped bearer tokens',{'www-authenticate':'Bearer'});
    const path = request.path.slice('/storage'.length).split('/').map(part=>{
      const decoded=decodeURIComponent(part);
      if (decoded.includes('/')) fail('Encoded path separator');
      return decoded;
    }).join('/'), {pieces,folder} = pathParts(path);
    const category = pieces[1];
    if (!category) return response(404);
    let docs;
    try { docs=readCategory(ctx,category); } catch { return response(503,'Atomic storage snapshot unavailable'); }
    if (!docs) return response(404);
    let body, type, tag;
    if (folder) {
      ({body,tag}=folderRepresentation(docs,path)); type='application/ld+json';
    } else {
      const doc=docs.find(d=>d.path===path);
      if (!doc) return response(header(request,'if-match')!==undefined ? 412 : 404);
      body=doc.text; type=doc.contentType; tag=etag(doc);
    }
    const headers={'content-type':type,etag:tag};
    const match=header(request,'if-match'), none=header(request,'if-none-match');
    if (match!==undefined && !tagMatches(match,tag,false)) return response(412,'',headers);
    if (none!==undefined && tagMatches(none,tag,true)) return response(304,'',headers);
    return response(200,method==='HEAD'?'':body,headers);
  } catch { return response(400,'Invalid remoteStorage request'); }
}
