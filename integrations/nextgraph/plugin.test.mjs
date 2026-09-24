import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {parseResult,ntriples,insertData,run,manifest,P,MAX_BYTES,SELECT} from './plugin.mjs';
const fixture = await readFile(new URL('./fixtures/select.json',import.meta.url),'utf8');
const PLAIN = 'https://atomicdata.dev/classes/PlainText';
const config = {mode:'import',parent:'https://atomic.example/folder',id:'sample',name:'NextGraph snapshot',result:fixture};
const context = () => ({config:{...config},query:()=>[],read:()=>assert.fail('unexpected read'),http:()=>assert.fail('no transport')});
const row = (s,p,o) => JSON.stringify({head:{vars:['s','p','o']},results:{bindings:[{s,p,o}]}});
const uri = value => ({type:'uri',value});
const literal = value => ({type:'literal',value});
test('supported NextGraph SELECT result retains exact decimal lexical form', () => {
  assert.match(SELECT,/LIMIT 257$/);
  assert.equal(parseResult(fixture).results.bindings[1].o.value,'9007199254740993.123456789');
  assert.equal(ntriples(fixture),'<did:ng:z:alice> <http://xmlns.com/foaf/0.1/name> "Alice"@en .\n<did:ng:z:alice> <did:ng:z:balance> "9007199254740993.123456789"^^<http://www.w3.org/2001/XMLSchema#decimal> .');
});
test('reviewed import uses actual native PlainText fields, never Loro JSON', () => {
  const result = run(context()); const intent = result.intents[0];
  assert.equal(intent.op,'create');assert.deepEqual(intent.isA,[PLAIN]);
  assert.equal(intent.set[P.description],fixture);assert.equal(intent.set[P.media],'application/sparql-results+json');
  assert.equal(intent.set[P.name],config.name);assert.equal(intent.parent,config.parent);
  assert.equal(Object.keys(intent.set).some(k=>k.endsWith('documentContent')),false);
});
test('export reads stored atoms with host API and proposes a standard SPARQL Update document', () => {
  const c = context(); const imported = run(c).intents[0];
  c.config = {...config,mode:'export',id:'export',sourceSubject:'https://atomic.example/snapshot'};
  c.read = subject => {assert.equal(subject,c.config.sourceSubject);return {...imported.set,[P.isA]:imported.isA};};
  const exported=run(c).intents[0];assert.equal(exported.set[P.description],insertData(fixture));
  assert.equal(exported.set[P.media],'application/sparql-update');assert.deepEqual(exported.isA,[PLAIN]);
});
test('denied source read propagates and no write plan is returned', () => {
  const c=context();c.config={...config,mode:'export',sourceSubject:'https://atomic.example/private'};
  c.read=()=>{throw Error('permission denied');};c.query=()=>assert.fail('must not plan after denial');
  assert.throws(()=>run(c),/permission denied/);
});
test('duplicate snapshot blocks implicit overwrite and retry duplication preflight', () => {
  const c=context();c.query=()=>['https://atomic.example/existing'];assert.throws(()=>run(c),/already exists/);
});
test('blank labels are remapped consistently and cannot inject SPARQL', () => {
  const label='danger } ; DROP ALL ; #';
  const text=row({type:'bnode',value:label},uri('urn:p'),{type:'bnode',value:label});
  assert.equal(ntriples(text),'_:b0 <urn:p> _:b0 .');
});
test('quotes, backslashes and newlines remain one escaped literal', () => {
  const value='" } ; DROP ALL ; #\n\\';
  assert.equal(ntriples(row(uri('urn:s'),uri('urn:p'),literal(value))),'<urn:s> <urn:p> "\\\" } ; DROP ALL ; #\\n\\\\" .');
});
test('malformed terms and injected IRIs are refused', () => {
  for(const object of [literal(3),{type:'literal',value:'x',datatype:'urn:x','xml:lang':'en'}, {type:'literal',value:'x','xml:lang':'en; DROP'},uri('urn:o> } DROP ALL'),uri('urn:o%ZZ'),{type:'triple',value:'rdfstar'}])assert.throws(()=>parseResult(row(uri('urn:s'),uri('urn:p'),object)));
  assert.throws(()=>parseResult(row(literal('bad subject'),uri('urn:p'),literal('x'))));
  assert.throws(()=>parseResult(row(uri('urn:s'),{type:'bnode',value:'x'},literal('x'))));
});
test('strict result shape refuses incomplete/unbound rows, ASK, arbitrary columns', () => {
  for(const text of ['null','{}','{',JSON.stringify({head:{vars:['x']},results:{bindings:[]}}),JSON.stringify({head:{vars:['s','p','o']},boolean:true,results:{bindings:[]}}),JSON.stringify({head:{vars:['s','p','o']},results:{bindings:[{}]}})])assert.throws(()=>parseResult(text));
});
test('row sentinel and UTF-8 size limits reject incomplete snapshots', () => {
  const r={s:uri('urn:s'),p:uri('urn:p'),o:literal('x')};
  assert.throws(()=>parseResult(JSON.stringify({head:{vars:['s','p','o']},results:{bindings:Array(257).fill(r)}})),/256/);
  assert.throws(()=>parseResult(' '.repeat(MAX_BYTES+1)),/65536/);
  assert.throws(()=>parseResult(row(uri('urn:s'),uri('urn:p'),literal('é'.repeat(MAX_BYTES/2)))),/65536/);
  assert.throws(()=>ntriples(row(uri('urn:s'),uri('urn:p'),literal('\ud800'))));
});
test('empty graph is valid and cannot invent triples',()=>{
  const empty=JSON.stringify({head:{vars:['s','p','o']},results:{bindings:[]}});
  assert.equal(ntriples(empty),'');assert.equal(insertData(empty),'INSERT DATA {\n\n}');
});
test('config and wrong atom source types fail without mutation',()=>{
  for(const patch of [{mode:'sync'},{parent:'not an iri'},{id:'../x'}])assert.throws(()=>run({...context(),config:{...config,...patch}}));
  const c=context();c.config={...config,mode:'export',sourceSubject:'urn:s'};c.read=()=>({[P.description]:fixture,[P.media]:'text/plain'});assert.throws(()=>run(c),/snapshot/);
});
test('bundle builds reproducibly without broker dependencies',async()=>{
  const path=new URL('./build.mjs',import.meta.url).pathname;
  execFileSync(process.execPath,[path]);const first=await readFile(new URL('./dist/plugin.js',import.meta.url),'utf8');
  execFileSync(process.execPath,[path]);assert.equal(await readFile(new URL('./dist/plugin.js',import.meta.url),'utf8'),first);
  assert.deepEqual(JSON.parse(await readFile(new URL('./dist/manifest.json',import.meta.url),'utf8')),manifest);
  const module=await import('data:text/javascript;base64,'+Buffer.from(first).toString('base64'));assert.equal(module.ntriples(fixture),ntriples(fixture));
  assert.equal(manifest.http,undefined);
});
