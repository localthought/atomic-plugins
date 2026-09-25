/**
 * Serves this repo's plugin catalog, standing in for what
 * ontola.github.io/atomic-plugins publishes. atomic-server used to embed an
 * `/integrations` route at build time (server/build.rs::embed_integrations,
 * removed in feat/plugin-debug 4bab16ee6), and even then it embedded its own
 * copy, never this repo's. This process serves the same filter the embed
 * used: a `plugin.js` anywhere under integrations/, plus the root
 * `catalog.json`. It also stands in for GitHub Pages for drive apps: it serves
 * the committed `apps/<id>/<version>/ui.js` files at `/apps/...`, the same
 * layout Pages publishes, and the catalog it serves points `app-module` there
 * (see `localCatalog`). So an e2e installs exactly the bytes this checkout
 * would publish, through the same integrity check a published version gets,
 * before they are on Pages.
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES_BASE, terms } from './apps.mjs';

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

/** The catalog's visibility gate for an entry. */
const ENABLED = 'https://atomicdata.dev/integrations/properties/enabled';

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** An `app-module` value that starts with the Pages base, as it is written. */
const PAGES_MODULE = new RegExp(
  `("${escapeRegExp(terms.module)}"\\s*:\\s*")${escapeRegExp(PAGES_BASE)}`,
  'g',
);

/**
 * The catalog with each drive app's `app-module` moved from GitHub Pages
 * (`PAGES_BASE`) to this server, which serves the same committed file at the
 * same path. It is a textual rewrite of just that URL prefix: every other byte
 * of the file is served as committed (CI's hosting-surface check compares
 * them), and the integrity hash is left alone, so the host still refuses a
 * module that does not match what the catalog pins — `apps.mjs check` is what
 * keeps the two equal. A URL outside Pages is served as it is. With
 * `enableApps` it also enables drive app entries (`enableAppEntries`).
 */
export function localCatalog(text, origin, { enableApps } = {}) {
  const moved = text.replace(PAGES_MODULE, (_, key) => `${key}${origin}/`);

  return enableApps ? enableAppEntries(moved, enableApps) : moved;
}

const ENABLED_FALSE = new RegExp(
  `("${escapeRegExp(ENABLED)}"\\s*:\\s*)false\\b`,
);

/**
 * `DEV_SERVER_ENABLE_APPS` as a set of shortnames, or `'all'`. Unset or
 * empty is `undefined`: the catalog's `enabled` is served as committed.
 */
export function parseEnableApps(value) {
  const ids = (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!ids.length) return undefined;

  return ids.includes('all') ? 'all' : new Set(ids);
}

/**
 * The catalog with `enabled: false` turned into `enabled: true` on the drive
 * app entries (those with `app-module`) that `enable` names, or on every
 * drive app entry for `'all'`. The lanes need it: the e2e installs through
 * the Integrations page's Drive apps section, which hides a disabled entry,
 * while the published catalog may keep an app disabled until its launch.
 * Like the `app-module` rewrite, it is textual, one `false` per entry, so
 * every other byte stays as committed; CI's hosting-surface check allows
 * exactly this change on app entries and nothing else. An entry that is not
 * a drive app is never touched, whatever `enable` says.
 */
export function enableAppEntries(text, enable) {
  const wanted = new Set(
    JSON.parse(text)
      .filter(
        entry =>
          entry &&
          typeof entry[terms.module] === 'string' &&
          entry[ENABLED] === false &&
          (enable === 'all' || enable.has(entry[terms.shortname])),
      )
      .map(entry => entry[terms.shortname]),
  );
  const done = new Set();
  // Top-level array elements, as JSON.stringify(catalog, null, 2) (apps.mjs
  // write) and oxfmt lay them out.
  const out = text.replace(/^ {2}\{\n[\s\S]*?\n {2}\}/gm, block => {
    const id = JSON.parse(block)[terms.shortname];
    if (!wanted.has(id)) return block;
    done.add(id);

    return block.replace(ENABLED_FALSE, '$1true');
  });

  for (const id of wanted)
    if (!done.has(id))
      throw new Error(`dev-server: could not enable ${id} in catalog.json`);

  return out;
}

/**
 * A committed drive app module (`apps/<id>/<version>/ui.js`) for a request
 * path, or undefined. The pattern admits no `/` or leading `.` in a segment,
 * so the path cannot leave apps/.
 */
export function appModuleFile(path, base = root) {
  if (
    !/^\/apps\/[a-z0-9][a-z0-9-]*\/[0-9A-Za-z][0-9A-Za-z.+-]*\/ui\.js$/.test(
      path,
    )
  )
    return undefined;
  const file = resolve(base, path.slice(1));

  return existsSync(file) ? file : undefined;
}

const CONTENT_TYPES = {
  plugin: 'text/javascript',
  catalog: 'application/json',
};

export function createDevServer({
  assetsRoot = root,
  enableApps = parseEnableApps(process.env.DEV_SERVER_ENABLE_APPS),
} = {}) {
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

    const path = req.url.split('?')[0];
    const appModule = appModuleFile(path, assetsRoot);
    const key = path.startsWith('/integrations/')
      ? path.slice('/integrations/'.length)
      : undefined;
    const file = appModule ?? (key !== undefined ? assets.get(key) : undefined);

    if (!file) {
      res.writeHead(404, cors).end();

      return;
    }

    const body =
      key === 'catalog.json'
        ? Buffer.from(
            localCatalog(
              readFileSync(file, 'utf8'),
              `http://${req.headers.host}`,
              { enableApps },
            ),
          )
        : readFileSync(file);

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
        CONTENT_TYPES[path.endsWith('.json') ? 'catalog' : 'plugin'],
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
