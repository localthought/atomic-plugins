/**
 * Stands in for the `/integrations` route atomic-server embeds at build time
 * (see server/build.rs::embed_integrations and server/src/routes.rs). CI no
 * longer drops this repo's integrations/ into the atomic-server checkout
 * before building it, so nothing atomic-server itself serves at
 * `/integrations` reflects this repo's plugins. This process serves them
 * instead, using the same filter the embed does: a `plugin.js` anywhere under
 * integrations/, plus the root `catalog.json`.
 *
 * That is all it does. It used to also reverse-proxy everything else through
 * to a real atomic-server, so that one origin looked like an atomic-server
 * hosting this repo's catalog. That existed only because the catalog URL was
 * compiled into the frontend and therefore had to be same-origin with the
 * server. Since atomic-server#1621 the catalog URL is seeded at runtime and
 * independently of `SERVER_URL`, so clients talk to atomic-server directly —
 * the topology atomic-server's own dagger e2e pipeline uses — and fetch the
 * catalog from here cross-origin.
 *
 * Fronting atomic-server could not be made to work anyway: it derives the
 * origin it answers under from the request's `Host`
 * (server/src/context.rs::RequestContext::new), while its stored resources
 * are bootstrapped under `config.rs::get_origin()`, which is built from
 * `ATOMIC_PORT` — the bind port, with no override. Forwarding `Host` made
 * signed auth proofs verify but left every resource lookup resolving under an
 * origin with no data (`/server` → 401); rewriting `Host` fixed the lookups
 * and broke the proofs. There is no setting of that header that satisfies
 * both, which is why the proxy is gone rather than fixed.
 */
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
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

export function createDevServer({ assetsRoot = root } = {}) {
  const assets = hostedAssets(assetsRoot);

  return createHttpServer((req, res) => {
    // The SPA is served from atomic-server's origin and fetches the catalog
    // from here, so every read of it is cross-origin. These assets are public
    // build artifacts of this repository and carry no credentials.
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type, If-None-Match',
      'access-control-expose-headers': 'ETag',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();

      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, cors).end();

      return;
    }

    if (req.url !== '/integrations' && !req.url.startsWith('/integrations/')) {
      res.writeHead(404, cors).end();

      return;
    }

    const key = req.url.slice('/integrations/'.length).split('?')[0];
    const file = assets.get(key);

    if (!file) {
      res.writeHead(404, cors).end();

      return;
    }

    const body = readFileSync(file);
    // atomic-server serves its embedded copy of these assets as cacheable
    // static files; this matches that. Content-addressed, so it stays correct
    // when a plugin bundle is rebuilt. Note this did NOT fix the Integrations
    // page refetching the catalog on every render (7 times per run, with or
    // without it) — that churn is in the data-browser component, not here.
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ...cors, etag }).end();

      return;
    }

    res.writeHead(200, {
      ...cors,
      etag,
      'cache-control': 'no-cache',
      'content-type':
        CONTENT_TYPES[key.endsWith('.json') ? 'catalog' : 'plugin'],
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.DEV_SERVER_PORT || 9880);
  const server = createDevServer();
  server.on('error', e => {
    console.error(`dev-server: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, () => {
    const assets = [...hostedAssets().keys()];
    console.log(
      `dev-server: hosting ${assets.length} integration asset(s) ` +
        `(${assets.join(', ')}) on :${port}`,
    );
  });
}
