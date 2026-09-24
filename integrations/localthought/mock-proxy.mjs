/** Local-only integration-proxy fixture. Never deploy this service. */
import { fixtures, selectPlatforms } from './fixtures/index.mjs';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pkceChallenge = verifier =>
  createHash('sha256').update(verifier).digest('base64url');

/**
 * `platforms` restricts which fixtures load (see fixtures/index.mjs); it
 * defaults to MOCK_PROXY_PLATFORMS, and to every fixture when that is unset.
 */
export function mockProxy({
  frontendOrigin = process.env.MOCK_FRONTEND_ORIGIN ?? 'http://localhost:6747',
  platforms = process.env.MOCK_PROXY_PLATFORMS,
} = {}) {
  const selected = selectPlatforms(
    Array.isArray(platforms) ? platforms.join(',') : platforms,
  );
  if (selected.missing.length)
    console.warn(
      `mock-proxy: no fixture for ${selected.missing.join(', ')}; not served`,
    );
  const instances = Object.fromEntries(
    selected.platforms.map(id => [id, fixtures[id].create()]),
  );
  const codes = new Map();
  const handoffs = new Map();

  const issueCode = platform => {
    const code = randomBytes(32).toString('base64url');
    codes.set(code, platform);

    return code;
  };

  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PATCH, DELETE, OPTIONS',
    );
    // As integration-proxy's browser_cors(): If-Match in, ETag and
    // Retry-After out, so a conditional write works the same here.
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, If-Match',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-Connection-Code, Link, Retry-After, ETag',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);

      return res.end();
    }

    const url = new URL(req.url, 'http://localhost');

    const json = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };

    if (url.pathname === '/catalog') return json(200, selected.platforms);
    const catalogFile = url.pathname.match(
      /^\/catalog\/([^/]+)\.(selection\.json|yaml)$/,
    );

    if (catalogFile && Object.hasOwn(instances, catalogFile[1])) {
      const fixture = fixtures[catalogFile[1]];
      if (catalogFile[2] === 'selection.json')
        return json(200, { query_overrides: [] });
      if (fixture.document) return json(200, fixture.document);

      if (fixture.documentFile) {
        res.writeHead(200, { 'Content-Type': 'application/yaml' });

        return res.end(readFileSync(fixture.documentFile));
      }
    }

    if (url.pathname === '/connect') {
      const p = url.searchParams;
      const platform = p.get('platform');
      const verifierChallenge = p.get('code_challenge');
      if (
        !Object.hasOwn(instances, platform) ||
        !verifierChallenge ||
        p.get('code_challenge_method') !== 'S256' ||
        p.get('credentials') !== 'connection' ||
        !p.get('user_id')
      )
        return json(400, { error: 'Invalid connection request' });
      let redirect;

      try {
        redirect = new URL(p.get('redirect_uri'));
      } catch {
        return json(400, { error: 'Invalid callback' });
      }

      if (
        redirect.origin !== frontendOrigin ||
        !['/app/integrations', '/app/devonian-demo'].includes(
          redirect.pathname,
        ) ||
        !redirect.searchParams.get('integration_state') ||
        redirect.searchParams.get('platform') !== platform
      )
        return json(400, { error: 'Invalid callback' });

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });

        return res.end(
          `<h1>Mock integration proxy</h1><p>Signed in as mock-user.</p><p>Use the selected ${fixtures[platform].title} account to sync with your Atomic Data Hub.</p><form method="post"><button>Use LocalThought to sync ${fixtures[platform].title} with your Atomic Data Hub</button></form>`,
        );
      }

      if (req.method !== 'POST') return json(405, {});
      const handoff = randomBytes(32).toString('base64url');
      handoffs.set(handoff, {
        platform,
        userId: p.get('user_id'),
        codeChallenge: verifierChallenge,
      });
      redirect.searchParams.set('connection_code', handoff);
      res.writeHead(303, { Location: redirect.href });

      return res.end();
    }

    if (url.pathname === '/connect/redeem') {
      if (req.method !== 'POST') return json(405, {});
      let body;

      try {
        let text = '';

        for await (const chunk of req) {
          text += chunk;
          if (text.length > 16 * 1024) return json(413, {});
        }

        body = JSON.parse(text);
      } catch {
        return json(400, { error: 'Invalid redemption body' });
      }

      const handoff = handoffs.get(body?.code);
      if (
        !handoff ||
        typeof body?.code_verifier !== 'string' ||
        !equal(pkceChallenge(body.code_verifier), handoff.codeChallenge)
      )
        return json(400, { error: 'Invalid or consumed connection code' });
      handoffs.delete(body.code);

      return json(200, {
        connection_code: issueCode(handoff.platform),
        platform: handoff.platform,
      });
    }

    // Test-side driver for a fixture that offers `control(command)`, so an
    // e2e spec in another process can change provider data or inject
    // failures between syncs. Local-only, like the rest of this server.
    const driver = url.pathname.match(/^\/__fixture\/([^/]+)$/);

    if (driver) {
      const instance = Object.hasOwn(instances, driver[1])
        ? instances[driver[1]]
        : undefined;
      if (typeof instance?.control !== 'function') return json(404, {});
      if (req.method !== 'POST') return json(405, {});
      let command;

      try {
        let text = '';

        for await (const chunk of req) {
          text += chunk;
          if (text.length > 64 * 1024) return json(413, {});
        }

        command = text ? JSON.parse(text) : {};
      } catch {
        return json(400, { error: 'Invalid fixture command' });
      }

      return json(200, instance.control(command) ?? {});
    }

    // Test-side drivers over HTTP, for e2e specs, which run in another process
    // than this mock: POST /fixture/<platform>/<driver> with a JSON array of
    // arguments. Only the names a fixture lists in its `drivers`.
    const namedDriver = url.pathname.match(/^\/fixture\/([^/]+)\/([^/]+)$/);

    if (namedDriver) {
      const [, platform, name] = namedDriver;
      if (
        req.method !== 'POST' ||
        !Object.hasOwn(instances, platform) ||
        !(fixtures[platform].drivers ?? []).includes(name)
      )
        return json(404, {});
      let args;

      try {
        let text = '';
        for await (const chunk of req) text += chunk;
        args = text ? JSON.parse(text) : [];
        if (!Array.isArray(args)) throw new Error('arguments must be an array');
      } catch (error) {
        return json(400, { error: String(error) });
      }

      try {
        return json(200, (await instances[platform][name](...args)) ?? null);
      } catch (error) {
        return json(409, { error: String(error) });
      }
    }

    if (url.pathname.startsWith('/proxy/')) {
      const code = req.headers.authorization?.replace(/^Bearer /, '');
      const platform = codes.get(code);
      if (!platform)
        return json(401, { error: 'Invalid or consumed connection code' });
      codes.delete(code);
      const headers = { 'X-Connection-Code': issueCode(platform) };
      if (!url.pathname.startsWith(`/proxy/${platform}/`))
        return json(403, {}, headers);

      const fixture = fixtures[platform];
      let input = {};

      if (fixture.jsonBody) {
        try {
          let body = '';

          for await (const chunk of req) {
            body += chunk;
            if (body.length > 1024 * 1024) return json(413, {}, headers);
          }

          if (body) input = JSON.parse(body);
        } catch {
          return json(400, { error: 'Invalid request body' }, headers);
        }
      }

      // Only the one request header the real proxy forwards upstream besides
      // Content-Type (proxy.rs upstream_request); never Authorization.
      const forwarded = req.headers['if-match']
        ? { 'if-match': req.headers['if-match'] }
        : {};
      const result = instances[platform].request(
        req.method,
        url,
        input,
        forwarded,
      );

      return json(result.status, result.body, {
        ...headers,
        ...result.headers,
      });
    }

    json(404, {});
  });
  // Test-side drivers, e.g. server.fixtures['github-issues'].createIssue().
  // The short aliases predate the registry; callers outside this repo
  // (atomic-server's browser/e2e specs) may still use them.
  server.fixtures = instances;
  server.github = instances['github-issues'];
  server.calendar = instances['google-calendar'];
  server.clockify = instances.clockify;

  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  mockProxy().listen(
    Number(process.env.MOCK_PROXY_PORT ?? 19090),
    process.env.MOCK_PROXY_HOST ?? '127.0.0.1',
    function () {
      const { address, port } = this.address();
      console.log(
        `Mock integration proxy listening on http://${address}:${port}`,
      );
    },
  );
}
