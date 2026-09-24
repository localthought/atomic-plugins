/** QuickJS entry: no Node, sockets, credential parsing or private read bypass. */
export const P = Object.freeze({
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  media: 'https://atomicdata.dev/properties/mimetype',
  localId: 'https://atomicdata.dev/properties/localId',
});
export const MAX_BYTES = 32768;
const TYPES = ['text/plain', 'application/ld+json'];

export const manifest = {
  config: {
    key: 'solid',
    properties: {
      parent: {
        type: 'string',
        description:
          'Atomic destination parent, required for reviewed import jobs.',
      },
      document: {
        type: 'object',
        description:
          'Import document: id, name, mediaType and body; required for reviewed import jobs.',
      },
      exports: {
        type: 'object',
        description:
          'Public route map from safe document IDs to actual Atomic resource subjects.',
      },
    },
    required: [],
  },
  schemaVersion: 3,
  name: 'solid',
  namespace: 'atomic-plugins',
  capabilities: [
    {
      name: 'storage',
      reason:
        'Read explicitly exported public Atomic documents; reviewed jobs import documents.',
    },
  ],
  http: {
    mount: 'drive-prefix',
    reason:
      'Public document reads only; Atomic read permissions are enforced by the host.',
    routes: [
      {
        id: 'resource',
        path: '/resources/{id}',
        methods: ['GET', 'HEAD'],
        principal: 'anonymous',
        auth: 'none',
      },
    ],
  },
};

function fail(message) {
  throw new Error(message);
}

function iri(value) {
  return (
    typeof value === 'string' &&
    /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(value)
  );
}

export function bytes(text) {
  // encodeURIComponent also rejects unpaired surrogates; QuickJS has no TextEncoder.
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}|./g, 'x').length;
}

function bounded(body) {
  if (typeof body !== 'string')
    fail('Only UTF-8 text bodies are supported; blob storage is unavailable');
  if (bytes(body) > MAX_BYTES) fail('Document exceeds 32768 UTF-8 bytes');
}

/** Explicit expanded JSON-LD subset: named nodes, absolute predicates and string literals.
 * No remote contexts, blank nodes, nested graphs, lists, or numeric precision conversion.
 */
export function parseRdf(body) {
  bounded(body);
  const graph = JSON.parse(body);
  if (!Array.isArray(graph) || graph.length > 128)
    fail('Expected up to 128 expanded JSON-LD nodes');
  let triples = 0;

  for (const node of graph) {
    if (
      !node ||
      typeof node !== 'object' ||
      Array.isArray(node) ||
      !iri(node['@id'])
    )
      fail('Node needs an absolute @id');

    for (const [predicate, values] of Object.entries(node)) {
      if (predicate === '@id') continue;

      if (predicate === '@type') {
        if (!Array.isArray(values) || !values.every(iri))
          fail('Types must be absolute IRIs');
      } else {
        if (!iri(predicate) || !Array.isArray(values))
          fail('Expected absolute predicate and value array');

        for (const value of values) {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            fail('Expected expanded value');
          const keys = Object.keys(value);
          if (keys.length === 1 && iri(value['@id'])) continue;
          if (
            typeof value['@value'] !== 'string' ||
            keys.some(k => !['@value', '@type', '@language'].includes(k))
          )
            fail('Expected string literal or named node');
          if (
            '@type' in value &&
            (!iri(value['@type']) || '@language' in value)
          )
            fail('Invalid literal datatype');
          if (
            '@language' in value &&
            (typeof value['@language'] !== 'string' ||
              !/^[a-z]+(?:-[a-z0-9]+)*$/i.test(value['@language']))
          )
            fail('Invalid language');
        }
      }

      triples += values.length;
      if (triples > 512) fail('At most 512 RDF statements');
    }
  }

  return graph;
}

function validate(body, media) {
  bounded(body);
  if (!TYPES.includes(media))
    fail(
      'Unsupported media type; only text/plain and expanded application/ld+json',
    );
  if (media === 'application/ld+json') parseRdf(body);
}

/** Existing sandbox job verdicts become real Atomic commits only after host review. */
export function run(ctx) {
  const { parent, document } = ctx.config || {};
  if (
    !iri(parent) ||
    !document ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(document.id || '')
  )
    fail('Configure parent and document with a safe id');
  if (typeof document.name !== 'string' || document.name.length > 256)
    fail('Document name must be at most 256 characters');
  validate(document.body, document.mediaType);
  const identity = `solid:${parent}:${document.id}`;
  // Existing resources are never overwritten without a host concurrency primitive.
  if (ctx.query(P.localId, identity).length)
    fail(
      'Document already imported; conditional updates require host write support',
    );

  return {
    intents: [
      {
        op: 'create',
        localId: `solid-${document.id}`,
        parent,
        isA: ['https://atomicdata.dev/classes/PlainText'],
        set: {
          [P.name]: document.name,
          [P.description]: document.body,
          [P.media]: document.mediaType,
          [P.localId]: identity,
        },
      },
    ],
    problems: [],
  };
}

function response(status, body = '', headers = {}) {
  return { status, headers: { 'cache-control': 'no-store', ...headers }, body };
}

function accepts(header, media) {
  if (!header) return true;
  let best = -1,
    quality = 0;

  for (const range of header.split(',')) {
    const [type, ...params] = range.trim().toLowerCase().split(';');
    const qParam = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    const specificity =
      type === media
        ? 2
        : type === media.split('/')[0] + '/*'
          ? 1
          : type === '*/*'
            ? 0
            : -1;

    if (specificity > best) {
      best = specificity;
      quality = Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0;
    }
  }

  return best >= 0 && quality > 0;
}

/** Content-derived weak cache validator; never used to authorize writes. */
export function etag(media, body) {
  // Bounded body means a bounded validator. Avoid emitting impractically large tags:
  // weak FNV pair is for cache revalidation ONLY, never write concurrency.
  let a = 2166136261,
    b = 5381;
  const value = `${media}\n${body}`;

  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }

  return `W/"${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${bytes(value)}"`;
}
export function handle(ctx, request) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD')
    return response(
      501,
      'Inbound writes and blob storage require host support',
    );
  const id = request.params?.id;
  const exports = ctx.config?.exports;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(id || '') ||
    !exports ||
    !Object.prototype.hasOwnProperty.call(exports, id)
  )
    return response(404);
  const subject = exports[id];
  if (!iri(subject)) return response(500, 'Invalid export configuration');
  let resource;

  try {
    resource = ctx.read(subject);
  } catch {
    return response(404);
  }

  if (!resource) return response(404);
  const media = resource[P.media];
  const body = resource[P.description];

  try {
    validate(body, media);
  } catch {
    return response(415, 'Stored document representation is unsupported');
  }

  const headers = request.headers || {};
  const tag = etag(media, body);
  const out = {
    'content-type': media,
    etag: tag,
    vary: 'Accept',
    link: `<http://www.w3.org/ns/ldp#${media === 'application/ld+json' ? 'RDFSource' : 'NonRDFSource'}>; rel="type"`,
  };
  if (!accepts(headers.accept, media)) return response(406, '', out);
  // Strong comparison cannot succeed against our weak representation validator.
  if (headers['if-match'] && headers['if-match'].trim() !== '*')
    return response(412, '', out);
  const none = headers['if-none-match'];
  if (
    none &&
    (none.trim() === '*' ||
      none.split(',').some(v => v.trim().replace(/^W\//, '') === tag.slice(2)))
  )
    return response(304, '', out);

  return response(200, method === 'HEAD' ? '' : body, out);
}
