// Import public upstream test DATA, not implementation code. Pass the authoritative checkout.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
if (!process.argv[2]) throw Error('Pass a willow_test_vectors checkout');
const root = resolve(process.argv[2]);
const fixture = {
  source: 'https://codeberg.org/worm-blossom/willow_test_vectors',
  commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  suites: {},
};

for (const type of [
  'EncodeEntry',
  'encode_entry',
  'EncodePath',
  'encode_path',
]) {
  fixture.suites[type] = [];

  for (const kind of ['yay', 'nay'])
    for (const id of readdirSync(resolve(root, 'codec', type, kind)).sort()) {
      const path = resolve(root, 'codec', type, kind, id);
      const canonical = resolve(root, 'codec', type, 'reencoded', id);
      fixture.suites[type].push({
        id,
        kind,
        bytes: readFileSync(path).toString('base64'),
        ...(kind === 'yay' && existsSync(canonical)
          ? { canonical: readFileSync(canonical).toString('base64') }
          : {}),
      });
    }
}

writeFileSync(
  new URL('./fixtures/upstream-codecs.json.gz', import.meta.url),
  gzipSync(JSON.stringify(fixture), { level: 9 }),
);
