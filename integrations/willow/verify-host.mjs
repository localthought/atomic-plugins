// Source contract check only, not a real host store or QuickJS execution.
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
if (!process.argv[2]) throw Error('Pass the pinned AtomicServer checkout');
const host = resolve(process.argv[2], 'browser/lib/src');
const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');
const { manifest, run } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
const manifestSource = stripTypeScriptTypes(
  readFileSync(resolve(host, 'plugin-manifest.ts'), 'utf8'),
).replace(
  './plugin-manifest-http.js',
  pathToFileURL(resolve(host, 'plugin-manifest-http.ts')).href,
);
const { validateManifest } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(manifestSource).toString('base64')
);
const { parseVerdict } = await import(
  pathToFileURL(resolve(host, 'plugin-run.ts')).href
);
validateManifest(manifest);
const verdict = run({
  config: {
    subjects: ['https://atomic.example/source'],
    properties: ['https://atomicdata.dev/properties/name'],
    outputParent: 'https://atomic.example/exports',
    namespace: '01'.repeat(32),
    subspace: '02'.repeat(32),
    pathPrefix: [],
    timestamp: '1',
  },
  read: () => ({ 'https://atomicdata.dev/properties/name': 'Example' }),
  query: () => [],
});
assert.equal(verdict.intents.length, 1);
assert.deepEqual(parseVerdict(verdict), verdict);
console.info(
  'Pinned host manifest and verdict parsers accept export; no host writes or live interoperability performed.',
);
