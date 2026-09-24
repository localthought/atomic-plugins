/** NextGraph SELECT-result interchange adapter; QuickJS, no transport or broker. */
export const manifest = {
  schemaVersion: 3, name: 'nextgraph', namespace: 'atomic-plugins',
  capabilities: [{name:'storage', reason:'Read explicitly selected Atomic snapshots and propose reviewed PlainText resource imports/exports.'}],
};
export const P = Object.freeze({name:'https://atomicdata.dev/properties/name', description:'https://atomicdata.dev/properties/description',
  media:'https://atomicdata.dev/properties/mimetype', localId:'https://atomicdata.dev/properties/localId', isA:'https://atomicdata.dev/properties/isA'});
const PLAIN = 'https://atomicdata.dev/classes/PlainText';
export const SELECT = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 257';
export const MAX_BYTES = 65536;
function fail(message) { throw new Error(message); }
function size(text) { return encodeURIComponent(text).replace(/%[A-F0-9]{2}|./g, 'x').length; }
function bounded(text, limit = MAX_BYTES) {
  if (typeof text !== 'string' || size(text) > limit) fail(`Expected UTF-8 text within ${limit} bytes`);
}
function iri(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]+$/.test(value) && !/%(?![A-Fa-f0-9]{2})/.test(value);
}
function term(value, position) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.value !== 'string') fail('Invalid SPARQL binding');
  bounded(value.value);
  if (value.type === 'uri') {
    if (Object.keys(value).some(k => !['type','value'].includes(k)) || !iri(value.value)) fail('Invalid absolute RDF IRI');
  } else if (value.type === 'bnode') {
    if (position === 'p' || !value.value || Object.keys(value).some(k => !['type','value'].includes(k))) fail('Invalid blank node');
  } else if (value.type === 'literal' && position === 'o') {
    if (Object.keys(value).some(k => !['type','value','datatype','xml:lang'].includes(k))) fail('Unsupported literal field');
    if ('datatype' in value && (!iri(value.datatype) || 'xml:lang' in value)) fail('Invalid literal datatype');
    if ('xml:lang' in value && (typeof value['xml:lang'] !== 'string' || !/^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(value['xml:lang']))) fail('Invalid language');
  } else fail('Unsupported RDF term or position');
  return value;
}
/** NextGraph ReadQuery SELECT output follows W3C SPARQL Results JSON. */
export function parseResult(text) {
  bounded(text);
  const data = JSON.parse(text);
  const vars = data?.head?.vars;
  const rows = data?.results?.bindings;
  if ('boolean' in Object(data) || !Array.isArray(vars) || vars.length !== 3 || new Set(vars).size !== 3 || !['s','p','o'].every(v => vars.includes(v))) fail('Expected SELECT ?s ?p ?o result');
  if (!Array.isArray(rows) || rows.length > 256) fail('At most 256 triples; export is oversized or possibly truncated');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 3 || !['s','p','o'].every(k => Object.prototype.hasOwnProperty.call(row,k))) fail('Every row must bind s, p and o only');
    for (const key of ['s','p','o']) term(row[key],key);
  }
  return data;
}
export function ntriples(text) {
  const rows = parseResult(text).results.bindings;
  const blanks = new Map();
  function render(value) {
    if (value.type === 'uri') return `<${value.value}>`;
    if (value.type === 'bnode') {
      if (!blanks.has(value.value)) blanks.set(value.value, `_:b${blanks.size}`);
      return blanks.get(value.value);
    }
    let literal = JSON.stringify(value.value);
    if (value['xml:lang']) literal += `@${value['xml:lang']}`;
    else if (value.datatype) literal += `^^<${value.datatype}>`;
    return literal;
  }
  const result = rows.map(r => `${render(r.s)} ${render(r.p)} ${render(r.o)} .`).join('\n');
  bounded(result, MAX_BYTES * 2);
  return result;
}
export function insertData(text) {
  // No interpolated query/graph/URI supplied separately: every RDF term is validated.
  const result = `INSERT DATA {\n${ntriples(text)}\n}`;
  bounded(result, MAX_BYTES * 2);
  return result;
}
function create(ctx, config, body, media) {
  const identity = `nextgraph:${config.parent}:${config.id}`;
  if (ctx.query(P.localId,identity).length) fail('Snapshot id already exists; choose a new id for an explicit snapshot');
  return {intents:[{op:'create', localId:`nextgraph-${config.id}`, parent:config.parent, isA:[PLAIN],
    set:{[P.name]:config.name, [P.description]:body, [P.media]:media, [P.localId]:identity}}], problems:[]};
}
export function run(ctx) {
  const config = ctx.config || {};
  if (!iri(config.parent) || !/^[A-Za-z0-9_-]{1,64}$/.test(config.id || '') || typeof config.name !== 'string' || config.name.length > 256) fail('Configure parent, id and name');
  if (config.mode === 'import') {
    parseResult(config.result);
    return create(ctx, config, config.result, 'application/sparql-results+json');
  }
  if (config.mode === 'export') {
    if (!iri(config.sourceSubject)) fail('Configure the Atomic snapshot subject');
    // Real host read enforces installation/caller permissions. Failure must propagate.
    const source = ctx.read(config.sourceSubject);
    if (!source || source[P.media] !== 'application/sparql-results+json' || (!Array.isArray(source[P.isA]) || !source[P.isA].includes(PLAIN))) fail('Source is not a SPARQL-result PlainText snapshot');
    return create(ctx,config,insertData(source[P.description]),'application/sparql-update');
  }
  fail('Mode must be import or export');
}
