/** QuickJS entry: no Node, sockets, credential parsing or private read bypass. */
export const P = Object.freeze({
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  media: 'https://atomicdata.dev/properties/mimetype',
  localId: 'https://atomicdata.dev/properties/localId',
});
export const MAX_BYTES = 32768;
const TYPES = ['text/plain', 'application/ld+json', 'text/turtle'];

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
    /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(value) &&
    ![...value].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
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
          bytes(value['@value']);
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

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Deliberately bounded RDF 1.1 Turtle subset. No base URL, blank nodes or lists. */
export function parseTurtle(body) {
  bounded(body);
  let offset = 0,
    statements = 0,
    expandedBytes = 0;
  const prefixes = new Map();
  const nodes = new Map();
  const error = () =>
    fail(`Unsupported or invalid Turtle at character ${offset}`);

  function space() {
    while (offset < body.length) {
      if (/[\t\r\n ]/.test(body[offset])) offset++;
      else if (body[offset] === '#') {
        while (offset < body.length && !/[\r\n]/.test(body[offset])) offset++;
      } else break;
    }
  }

  function take(pattern) {
    const found = pattern.exec(body.slice(offset));
    if (!found) return undefined;
    offset += found[0].length;

    return found[0];
  }

  function punctuation(mark) {
    space();
    if (body[offset] !== mark) error();
    offset++;
  }

  function escape(iriMode) {
    const code = body[offset++];

    if (code === 'u' || code === 'U') {
      const count = code === 'u' ? 4 : 8;
      const digits = body.slice(offset, offset + count);
      if (digits.length !== count || !/^[0-9A-Fa-f]+$/.test(digits)) error();
      offset += count;
      const value = Number.parseInt(digits, 16);
      if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) error();

      return String.fromCodePoint(value);
    }

    const escapes = {
      t: '\t',
      b: '\b',
      n: '\n',
      r: '\r',
      f: '\f',
      '"': '"',
      "'": "'",
      '\\': '\\',
    };
    if (iriMode || !Object.prototype.hasOwnProperty.call(escapes, code))
      error();

    return escapes[code];
  }

  function delimited(close, iriMode) {
    offset++;
    let value = '';

    while (offset < body.length) {
      const char = body[offset++];
      if (char === close) return value;

      if (char === '\\') value += escape(iriMode);
      else {
        if (char === '\n' || char === '\r') error();
        value += char;
      }
    }

    return error();
  }

  function reference() {
    space();
    let value;

    if (body[offset] === '<') value = delimited('>', true);
    else {
      // This subset intentionally excludes Unicode/escaped/dotted prefixed names.
      const name = take(
        /^(?:[A-Za-z][A-Za-z0-9_-]*)?:(?:[A-Za-z0-9_][A-Za-z0-9_-]*)?/,
      );
      if (name === undefined) error();
      const colon = name.indexOf(':');
      const prefix = name.slice(0, colon);
      if (!prefixes.has(prefix)) error();
      value = prefixes.get(prefix) + name.slice(colon + 1);
    }

    if (!iri(value)) error();
    bytes(value); // Reject invalid Unicode scalar values after escape decoding.

    return value;
  }

  function object() {
    space();

    if (body[offset] === '"' || body[offset] === "'") {
      const quote = body[offset];
      if (body.slice(offset, offset + 3) === quote.repeat(3)) error();
      const value = delimited(quote, false);
      bytes(value);
      const result = { '@value': value };

      if (body[offset] === '@') {
        offset++;
        const language = take(/^[A-Za-z]+(?:-[A-Za-z0-9]+)*/);
        if (!language) error();
        result['@language'] = language.toLowerCase();
      } else if (body.slice(offset, offset + 2) === '^^') {
        offset += 2;
        result['@type'] = reference();
      }

      return result;
    }

    const boolean = take(/^(?:true|false)(?=[\t\r\n ;,.#]|$)/);
    if (boolean) return { '@value': boolean, '@type': XSD + 'boolean' };
    const number = take(
      /^[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)[eE][+-]?[0-9]+|[0-9]*\.[0-9]+|[0-9]+)(?=[\t\r\n ;,.#]|$)/,
    );

    if (number) {
      const type = /[eE]/.test(number)
        ? 'double'
        : number.includes('.')
          ? 'decimal'
          : 'integer';

      return { '@value': number, '@type': XSD + type };
    }

    return { '@id': reference() };
  }

  function add(subject, predicate, value) {
    if (++statements > 512) fail('At most 512 RDF statements');
    expandedBytes +=
      bytes(subject) + bytes(predicate) + bytes(JSON.stringify(value)) + 32;
    if (expandedBytes > MAX_BYTES) fail('Expanded Turtle exceeds 32768 bytes');

    if (!nodes.has(subject)) {
      if (nodes.size >= 128) fail('At most 128 RDF nodes');
      nodes.set(subject, { '@id': subject });
    }

    const node = nodes.get(subject);
    if (!Object.prototype.hasOwnProperty.call(node, predicate))
      node[predicate] = [];
    node[predicate].push(value);
  }

  while (true) {
    space();
    if (offset === body.length) break;
    const directive = take(/^(?:@prefix|PREFIX)(?=[\t\r\n ])/i);

    if (directive) {
      if (directive.startsWith('@') && directive !== '@prefix') error();
      space();
      const prefix = take(/^(?:[A-Za-z][A-Za-z0-9_-]*)?:/);
      if (prefix === undefined) error();
      space();
      if (body[offset] !== '<') error();
      const namespace = reference();
      prefixes.set(prefix.slice(0, -1), namespace);
      if (directive === '@prefix') punctuation('.');
      continue;
    }

    const subject = reference();

    while (true) {
      space();
      const predicate = take(/^a(?=[\t\r\n <#])/) ? RDF_TYPE : reference();

      while (true) {
        add(subject, predicate, object());
        space();
        if (body[offset] !== ',') break;
        offset++;
      }

      space();
      if (body[offset] !== ';') break;

      while (body[offset] === ';') {
        offset++;
        space();
      }

      if (body[offset] === '.') break;
    }

    punctuation('.');
  }

  return [...nodes.values()];
}

/** Absolute triple form is valid Turtle; lexical strings never become JS numbers. */
export function serializeTurtle(graph) {
  // Use the same named-node graph subset as the expanded JSON-LD importer.
  parseRdf(JSON.stringify(graph));
  const lines = [];
  let outputBytes = 0;

  for (const node of graph) {
    for (const [predicate, values] of Object.entries(node)) {
      if (predicate === '@id') continue;

      for (const value of values) {
        const property = predicate === '@type' ? RDF_TYPE : predicate;
        let object;

        if (predicate === '@type') object = `<${value}>`;
        else if ('@id' in value) object = `<${value['@id']}>`;
        else {
          object = JSON.stringify(value['@value']);
          if (value['@language']) object += `@${value['@language']}`;
          else if (value['@type']) object += `^^<${value['@type']}>`;
        }

        const line = `<${node['@id']}> <${property}> ${object} .`;
        outputBytes += bytes(line) + (lines.length ? 1 : 0);
        if (outputBytes > MAX_BYTES)
          fail('Turtle representation exceeds 32768 bytes');
        lines.push(line);
      }
    }
  }

  const body = lines.join('\n');
  bounded(body);

  return body;
}

function validate(body, media) {
  bounded(body);
  if (!TYPES.includes(media))
    fail(
      'Unsupported media type; expected text/plain, text/turtle or expanded application/ld+json',
    );
  if (media === 'application/ld+json') return parseRdf(body);
  if (media === 'text/turtle') return parseTurtle(body);

  return undefined;
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

function qualityFor(header, media) {
  if (!header) return 1;
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

  return best >= 0 ? quality : 0;
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
  let media = resource[P.media];
  let body = resource[P.description];
  let graph;

  try {
    graph = validate(body, media);
  } catch {
    return response(415, 'Stored document representation is unsupported');
  }

  const headers = request.headers || {};
  const choices = graph
    ? [
        media,
        ...['text/turtle', 'application/ld+json'].filter(
          type => type !== media,
        ),
      ]
    : [media];
  const selected = choices
    .map(type => ({ type, quality: qualityFor(headers.accept, type) }))
    .sort((a, b) => b.quality - a.quality)[0];
  if (!selected || selected.quality <= 0)
    return response(406, '', { vary: 'Accept' });

  if (selected.type !== media) {
    try {
      body =
        selected.type === 'text/turtle'
          ? serializeTurtle(graph)
          : JSON.stringify(graph);
      bounded(body);
    } catch {
      return response(406, '', { vary: 'Accept' });
    }

    media = selected.type;
  }

  const tag = etag(media, body);
  const out = {
    'content-type': media,
    etag: tag,
    vary: 'Accept',
    link: `<http://www.w3.org/ns/ldp#${graph ? 'RDFSource' : 'NonRDFSource'}>; rel="type"`,
  };
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
