// Explicit source-contract validation, separate from unit or live host evidence.
// node --experimental-strip-types integrations/remotestorage/verify-host.mjs /path/to/pinned/atomic-server
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { manifest, run } from './plugin.mjs';
if (!process.argv[2]) throw Error('Pass the pinned atomic-server checkout path');
const host=resolve(process.argv[2],'browser/lib/src');
const http=pathToFileURL(resolve(host,'plugin-manifest-http.ts')).href;
const source=stripTypeScriptTypes(readFileSync(resolve(host,'plugin-manifest.ts'),'utf8')).replace('./plugin-manifest-http.js',http);
const {validateManifest}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {parseVerdict}=await import(pathToFileURL(resolve(host,'plugin-run.ts')).href);
validateManifest(manifest);
const verdict=run({config:{table:'https://atomic.example/docs'},query:()=>[],read:()=>{throw Error('Unexpected read');},
  upload:{text:JSON.stringify({documents:[{path:'/notes/hello.txt',text:'Hello Atomic',contentType:'text/plain'}]})}});
assert.equal(verdict.intents.length,1);
assert.deepEqual(parseVerdict(verdict),verdict);
console.log('Pinned host manifest and verdict parsers accept this bundle contract; no host writes or interoperability performed.');
