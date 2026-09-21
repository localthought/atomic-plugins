/**
 * Stands in for the `/integrations` route atomic-server embeds at build
 * time (see server/build.rs::embed_integrations and server/src/routes.rs).
 * CI no longer drops this repo's integrations/ into the atomic-server
 * checkout before building it, so nothing atomic-server itself serves at
 * `/integrations` reflects this repo's plugins. This process serves them
 * instead — same filter atomic-server's embed uses (a `plugin.js` file
 * anywhere under integrations/, plus the root `catalog.json`) — and
 * proxies every other request through to a real running atomic-server, so
 * a single URL behaves like one atomic-server that happens to host this
 * repo's plugin catalog.
 */
import {
  createServer as createHttpServer,
  request as httpRequest,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function hostedAssets(base = root) {
  const integrationsDir = resolve(base, 'integrations');
  const assets = new Map();
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const isPluginBundle = entry.name === 'plugin.js';
      const isRootCatalog = entry.name === 'catalog.json' && depth === 1;
      if (!isPluginBundle && !isRootCatalog) continue;
      assets.set(relative(integrationsDir, full).split(sep).join('/'), full);
    }
  };
  walk(integrationsDir, 1);
  return assets;
}

const CONTENT_TYPES = {
  plugin: 'text/javascript',
  catalog: 'application/json',
};

export function createDevServer({ upstream, assetsRoot = root } = {}) {
  if (!upstream)
    throw new Error('createDevServer requires an upstream atomic-server URL');
  const assets = hostedAssets(assetsRoot);
  const upstreamUrl = new URL(upstream);
  const request =
    upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  return createHttpServer((req, res) => {
    if (req.url === '/integrations' || req.url.startsWith('/integrations/')) {
      const key = req.url.slice('/integrations/'.length).split('?')[0];
      const file = assets.get(key);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type':
          CONTENT_TYPES[key.endsWith('.json') ? 'catalog' : 'plugin'],
      });
      res.end(readFileSync(file));
      return;
    }
    const proxied = request(
      upstream + req.url,
      {
        method: req.method,
        headers: { ...req.headers, host: upstreamUrl.host },
      },
      upstreamRes => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    proxied.on('error', err => {
      res.writeHead(502).end(`dev-server: upstream error: ${err.message}`);
    });
    req.pipe(proxied);
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.DEV_SERVER_PORT || 9880);
  const upstream = process.env.DEV_SERVER_UPSTREAM;
  if (!upstream) {
    console.error(
      'Usage: DEV_SERVER_UPSTREAM=http://localhost:9883 ' +
        '[DEV_SERVER_PORT=9880] node dev-server.mjs',
    );
    process.exit(1);
  }
  const server = createDevServer({ upstream });
  server.on('error', e => {
    console.error(`dev-server: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, () => {
    const assets = [...hostedAssets().keys()];
    console.log(
      `dev-server: hosting ${assets.length} integration asset(s) ` +
        `(${assets.join(', ')}) on :${port}, proxying everything else to ${upstream}`,
    );
  });
}
