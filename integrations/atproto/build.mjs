import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { manifest } from './plugin.mjs';
const output = new URL('./dist/', import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(
  new URL('./plugin.mjs', import.meta.url),
  new URL('plugin.js', output),
);
await writeFile(
  new URL('manifest.json', output),
  JSON.stringify(manifest, null, 2) + '\n',
);
