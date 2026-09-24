/**
 * Local-only integration-proxy fixture. Never deploy this service.
 *
 * It speaks the integration proxy's 0.2 protocol (ontola/atomic-plugins#54,
 * `integration-proxy/src/`): no proxy login; the page that redeems a handoff,
 * signing with the user's Atomic key, owns the connection; the owner
 * delegates it to app agents; a plugin frame calls `/proxy/{connection}/
 * {platform}/…` itself, with a capability the owner signed and a request
 * signature by the frame's own key. Every signature is checked exactly as
 * the real proxy checks it (`mock-proxy-auth.mjs`), so a host that signs
 * wrongly fails here too. What it does not have: Postgres, OAuth with a real
 * provider, sealed credentials, the 90-day idle sweep, the SaaS access policy.
 *
 * Providers are per-platform fixtures (fixtures/index.mjs). Test-side drivers
 * (`/__fixture/…`, `/fixture/<platform>/<driver>`) and introspection
 * (`/__mock/…`) need no signature: this server only ever listens locally.
 */
import { fixtures, selectPlatforms } from './fixtures/index.mjs';
import {
  ProxyRefusal,
  parseAgent,
  parseCapability,
  verifyCapability,
  verifyRequest,
} from './mock-proxy-auth.mjs';
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
/** 32 random bytes, base64url: the length of the proxy's ids and codes (43). */
const random = () => randomBytes(32).toString('base64url');
const escape = text =>
  String(text).replace(
    /[&<>"']/g,
    c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const HANDOFF_MS = 5 * 60 * 1000;
const REPLAY_MS = 10 * 60 * 1000;
const MAX_LABEL = 200;

/** Whether a fixture's catalog document declares an API-key scheme. */
const requiresApiKey = fixture =>
  Object.values(fixture.document?.components?.securitySchemes ?? {}).some(
    scheme => scheme?.type === 'apiKey',
  );

/**
 * `platforms` restricts which fixtures load (see fixtures/index.mjs); it
 * defaults to MOCK_PROXY_PLATFORMS, and to every fixture when that is unset.
 *
 * `baseUrl` is the proxy's public origin, as the real proxy's BASE_URL: the
 * URL every request signature covers and every capability's `aud`. It
 * defaults to MOCK_PROXY_BASE_URL, then to `http://127.0.0.1:<port>` once
 * listening. Clients must use exactly this origin.
 */
export function mockProxy({
  frontendOrigin = process.env.MOCK_FRONTEND_ORIGIN ?? 'http://localhost:6747',
  platforms = process.env.MOCK_PROXY_PLATFORMS,
  baseUrl = process.env.MOCK_PROXY_BASE_URL,
  now = Date.now,
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
  /** csrf -> the validated /connect request, until the consent form posts. */
  const consents = new Map();
  /** handoff code -> { platform, codeChallenge, expires }. */
  const handoffs = new Map();
  /** connection id -> row; delegations keyed by canonical agent. */
  const connections = new Map();
  /** `${owner} ${agent}` -> runtime row. */
  const runtimes = new Map();
  /** single-use record of signed requests: replay key -> expiry. */
  const used = new Map();

  const origin = () =>
    (baseUrl ?? `http://127.0.0.1:${server.address().port}`).replace(/\/$/, '');
  const stamp = () => new Date(now()).toISOString();

  /** `signature::authenticate`: verify, then spend. */
  const authenticate = (req, body) => {
    const verified = verifyRequest(
      req.headers,
      req.method,
      `${origin()}${req.url}`,
      body,
      now(),
    );
    for (const [key, expires] of used) if (expires < now()) used.delete(key);
    if (used.has(verified.replayKey)) throw new ProxyRefusal('replayed');
    used.set(verified.replayKey, now() + REPLAY_MS);

    return verified.agent;
  };

  const owned = (signer, id) => {
    const row = connections.get(id);
    if (!row) throw new ProxyRefusal('unknown_connection');
    if (row.owner !== signer) throw new ProxyRefusal('not_owner');

    return row;
  };

  const agentArg = id => {
    const agent = parseAgent(id);
    if (!agent)
      throw new ProxyRefusal('bad_request', 'agent must be an atomic:agent id');

    return agent;
  };

  const labelArg = label => {
    if (label === undefined || label === null) return null;
    if (typeof label !== 'string' || [...label].length > MAX_LABEL)
      throw new ProxyRefusal(
        'bad_request',
        'label is longer than 200 characters',
      );

    return label;
  };

  const strictBody = (body, allowed, required, usage) => {
    let value;

    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new ProxyRefusal('bad_request', usage);
    }

    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(k => !allowed.includes(k)) ||
      required.some(k => typeof value[k] !== 'string')
    )
      throw new ProxyRefusal('bad_request', usage);

    return value;
  };

  /** The standing of a signer for a connection (`Security::standing`). */
  const standing = (row, signer) => {
    if (row.owner === signer) return { kind: 'owner' };
    if (row.delegations.has(signer)) return { kind: 'delegate', app: signer };
    const runtime = runtimes.get(`${row.owner} ${signer}`);
    if (runtime && row.delegations.has(runtime.app))
      return { kind: 'runtime', app: runtime.app, runtime };

    return undefined;
  };

  /** `proxy::authenticate`. Returns the app that used it, if any. */
  const authenticateProxied = (req, body, row, platform) => {
    const authorization = req.headers.authorization;
    let caller;

    if (authorization !== undefined) {
      if (!authorization.startsWith('Capability '))
        throw new ProxyRefusal('unsupported_authorization');
      const parsed = parseCapability(authorization.slice('Capability '.length));
      verifyCapability(parsed, row.owner, origin(), Math.floor(now() / 1000));
      if (
        parsed.claims.connection_id !== row.connection_id ||
        parsed.claims.platform !== platform ||
        row.platform !== platform
      )
        throw new ProxyRefusal('capability_scope');
      if (!row.delegations.has(parsed.app))
        throw new ProxyRefusal('not_delegated');
      if (authenticate(req, body) !== parsed.cnf)
        throw new ProxyRefusal('capability_key_mismatch');
      caller = { kind: 'frame', app: parsed.app };
    } else {
      caller = standing(row, authenticate(req, body));
      if (!caller) throw new ProxyRefusal('not_delegated');
    }

    if (row.platform !== platform) throw new ProxyRefusal('platform_mismatch');
    row.last_used_at = stamp();
    if (caller.app) row.delegations.get(caller.app).last_used_at = stamp();
    if (caller.runtime) caller.runtime.last_used_at = stamp();

    return caller;
  };

  const listFor = owner => ({
    owner,
    connections: [...connections.values()]
      .filter(row => row.owner === owner)
      .map(publicRow),
    runtimes: [...runtimes.values()]
      .filter(r => r.owner === owner)
      .map(({ agent, app, label, created_at, last_used_at }) => ({
        agent,
        app,
        label,
        created_at,
        last_used_at,
      })),
  });

  const handle = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    // As integration-proxy's browser_cors(): the signature headers and
    // Authorization (for a capability) in; If-Match in, ETag and Retry-After
    // out, so a conditional write works the same here. Last-Page is exposed
    // for the Clockify fixture; the real proxy does not expose it (and the
    // host's frame client forwards only link, retry-after, etag and
    // content-type anyway).
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, If-Match, x-atomic-agent, x-atomic-public-key, x-atomic-timestamp, x-atomic-signature, x-atomic-signature-version',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Type, Link, Retry-After, ETag, X-Total-Count, X-Next-Page, Last-Page',
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

    const refuse = error => {
      if (!(error instanceof ProxyRefusal)) throw error;

      return json(
        error.status,
        { error: error.code, message: error.message },
        { 'Cache-Control': 'no-store' },
      );
    };

    /** The raw body, at most `limit` bytes; `undefined` when larger. */
    const readBody = async limit => {
      const chunks = [];
      let size = 0;

      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) return undefined;
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
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

    // GET /connect: the consent page. No login and no user_id: whoever
    // redeems the handoff, signing with their key, becomes the owner.
    if (url.pathname === '/connect') {
      if (req.method !== 'GET') return json(405, {});
      const p = url.searchParams;
      const platform = p.get('platform');
      const challenge = p.get('code_challenge') ?? '';
      // The retired flow's parameters: a host still sending them is stale.
      const legacy = ['user_id', 'credentials', 'tenant_id', 'user_id_sig'];
      if (
        !Object.hasOwn(instances, platform) ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        p.get('code_challenge_method') !== 'S256' ||
        legacy.some(name => p.has(name))
      )
        return json(400, { error: 'Invalid connection request' });
      let redirect;

      try {
        redirect = new URL(p.get('redirect_uri'));
      } catch {
        return json(400, { error: 'Invalid return address' });
      }

      // Stricter than the real proxy (any https, loopback http or atomic:
      // address): the e2e host must return to its own /app/integrations.
      if (
        redirect.origin !== frontendOrigin ||
        !['/app/integrations', '/app/devonian-demo'].includes(
          redirect.pathname,
        ) ||
        redirect.hash ||
        redirect.searchParams.has('connection_code') ||
        redirect.searchParams.has('error') ||
        !redirect.searchParams.get('integration_state') ||
        redirect.searchParams.get('platform') !== platform
      )
        return json(400, { error: 'Invalid return address' });

      const csrf = random();
      consents.set(csrf, {
        platform,
        codeChallenge: challenge,
        redirect: redirect.href,
        expires: now() + HANDOFF_MS,
      });
      const title = escape(fixtures[platform].title);
      const apiKey = requiresApiKey(fixtures[platform]);
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
      });

      // Mirrors templates.rs: an API-key platform asks for the key here; an
      // OAuth one would go to the provider next (the mock skips that).
      return res.end(
        `<h1>Mock integration proxy</h1><h2>Connect ${title}</h2><p>Destination: ${escape(redirect.origin)}</p><p>The destination finishes connecting by signing with your Atomic key; it becomes the connection's owner.</p><form method="post" action="/connect/authorize"><input type="hidden" name="csrf" value="${csrf}">${
          apiKey
            ? `<input type="password" name="api_key" aria-label="API key" placeholder="API key" required><button type="submit">Connect ${title}</button>`
            : `<button type="submit">Use LocalThought to sync ${title} with this destination</button>`
        }<button type="submit" name="cancel" value="1" formnovalidate>Cancel</button></form>`,
      );
    }

    // POST /connect/authorize: the consent form. The real proxy goes to the
    // provider's OAuth here (or seals the pasted key); the mock stands in for
    // the provider saying yes, and returns a single-use handoff code.
    if (url.pathname === '/connect/authorize') {
      if (req.method !== 'POST') return json(405, {});
      const body = await readBody(16 * 1024);
      if (!body) return json(413, {});
      const form = new URLSearchParams(body.toString('utf8'));
      const consent = consents.get(form.get('csrf') ?? '');
      consents.delete(form.get('csrf') ?? '');
      if (!consent || consent.expires < now())
        return json(400, { error: 'Invalid or expired consent' });
      const redirect = new URL(consent.redirect);

      if (form.get('cancel')) {
        redirect.searchParams.set('error', 'access_denied');
      } else {
        if (
          requiresApiKey(fixtures[consent.platform]) &&
          !form.get('api_key')?.trim()
        )
          return json(400, { error: 'An API key is required' });
        const code = random();
        handoffs.set(code, {
          platform: consent.platform,
          codeChallenge: consent.codeChallenge,
          expires: now() + HANDOFF_MS,
        });
        redirect.searchParams.set('connection_code', code);
      }

      res.writeHead(303, { Location: redirect.href });

      return res.end();
    }

    // POST /connect/redeem, signed: the signer becomes the owner.
    if (url.pathname === '/connect/redeem') {
      if (req.method !== 'POST') return json(405, {});
      const body = await readBody(16 * 1024);
      if (!body) return json(413, {});

      try {
        const owner = authenticate(req, body);
        const request = strictBody(
          body,
          ['code', 'code_verifier'],
          ['code', 'code_verifier'],
          'body must be {"code", "code_verifier"}',
        );
        const handoff = handoffs.get(request.code);
        if (
          !handoff ||
          handoff.expires < now() ||
          request.code_verifier.length < 43 ||
          !equal(pkceChallenge(request.code_verifier), handoff.codeChallenge)
        )
          throw new ProxyRefusal('invalid_handoff');
        handoffs.delete(request.code);
        const connectionId = random();
        connections.set(connectionId, {
          connection_id: connectionId,
          platform: handoff.platform,
          owner,
          created_at: stamp(),
          last_used_at: null,
          delegations: new Map(),
        });

        return json(
          200,
          { connection_id: connectionId, platform: handoff.platform, owner },
          { 'Cache-Control': 'no-store' },
        );
      } catch (error) {
        return refuse(error);
      }
    }

    // Management, signed by the owner.
    const management =
      url.pathname === '/connections' ||
      url.pathname === '/runtimes' ||
      /^\/(connections|runtimes)\/[^/]+(\/agents(\/[^/]+)?)?$/.test(
        url.pathname,
      );

    if (management) {
      const body = await readBody(16 * 1024);
      if (!body) return json(413, {});
      const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);

      try {
        const signer = authenticate(req, body);
        const [collection, id, sub, agent] = segments;
        const noStore = { 'Cache-Control': 'no-store' };

        if (collection === 'connections' && !id && req.method === 'GET')
          return json(200, listFor(signer), noStore);

        if (collection === 'connections' && id && !sub) {
          if (req.method !== 'DELETE') return json(405, {});
          owned(signer, id);
          connections.delete(id);
          res.writeHead(204, noStore);

          return res.end();
        }

        if (collection === 'connections' && sub === 'agents') {
          const row = owned(signer, id);

          if (!agent && req.method === 'POST') {
            const request = strictBody(
              body,
              ['agent', 'label'],
              ['agent'],
              'body must be {"agent", "label"?}',
            );
            const delegate = agentArg(request.agent);
            const label = labelArg(request.label);
            const previous = row.delegations.get(delegate);
            row.delegations.set(delegate, {
              agent: delegate,
              label,
              created_at: previous?.created_at ?? stamp(),
              last_used_at: previous?.last_used_at ?? null,
            });

            return json(
              200,
              { connection_id: id, agent: delegate, label },
              noStore,
            );
          }

          if (agent && req.method === 'DELETE') {
            row.delegations.delete(agentArg(agent));
            res.writeHead(204, noStore);

            return res.end();
          }

          return json(405, {});
        }

        if (collection === 'runtimes' && !id && req.method === 'POST') {
          const request = strictBody(
            body,
            ['app', 'agent', 'label'],
            ['app', 'agent'],
            'body must be {"app", "agent", "label"?}',
          );
          const app = agentArg(request.app);
          const runtime = agentArg(request.agent);
          if (runtime === app || runtime === signer)
            throw new ProxyRefusal(
              'bad_request',
              'a runtime must be its own agent, not the app or the owner',
            );
          const label = labelArg(request.label);
          runtimes.set(`${signer} ${runtime}`, {
            owner: signer,
            agent: runtime,
            app,
            label,
            created_at: stamp(),
            last_used_at: null,
          });

          return json(200, { app, agent: runtime, label }, noStore);
        }

        if (collection === 'runtimes' && id && req.method === 'DELETE') {
          runtimes.delete(`${signer} ${agentArg(id)}`);
          res.writeHead(204, noStore);

          return res.end();
        }

        return json(405, {});
      } catch (error) {
        return refuse(error);
      }
    }

    // Test-side introspection, as a spec in another process needs it:
    // every connection with its owner, delegations and runtimes; never a
    // credential (the mock holds none). Local-only, like the drivers.
    if (url.pathname === '/__mock/connections' && req.method === 'GET')
      return json(200, {
        connections: [...connections.values()].map(publicRow),
        runtimes: [...runtimes.values()],
      });

    // Test-side changes a person would make elsewhere (another device, the
    // proxy's own management UI): drop one delegation, or a whole
    // connection (as the 90-day idle sweep would).
    if (url.pathname === '/__mock/revoke' && req.method === 'POST') {
      const body = await readBody(16 * 1024);
      let command;

      try {
        command = JSON.parse(body?.toString('utf8') || '{}');
      } catch {
        return json(400, { error: 'Invalid command' });
      }

      const row = connections.get(command.connection_id);
      if (!row) return json(404, {});
      if (command.agent === undefined) connections.delete(row.connection_id);
      else row.delegations.delete(parseAgent(command.agent));

      return json(200, {});
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
        const text = (await readBody(64 * 1024))?.toString('utf8');
        if (text === undefined) return json(413, {});
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

    // ANY /proxy/{connection_id}/{platform}/{*path}
    // Matched on the path as sent: URL parsing would resolve a `%2e%2e`
    // segment before the traversal check could see it.
    const proxied = req.url
      .split('?')[0]
      .match(/^\/proxy\/([^/]+)\/([^/]+)\/(.*)$/);

    if (proxied) {
      const [, rawId, platform, rest] = proxied;
      if (
        rest
          .split('/')
          .some(s => ['.', '..'].includes(decodeURIComponent(s).trim()))
      )
        return refuse(
          new ProxyRefusal(
            'bad_request',
            'path must not contain traversal segments',
          ),
        );
      const body = await readBody(1024 * 1024);
      if (!body) return json(413, {});
      const row = connections.get(decodeURIComponent(rawId));

      try {
        if (!row) throw new ProxyRefusal('unknown_connection');
        authenticateProxied(req, body, row, platform);
      } catch (error) {
        return refuse(error);
      }

      if (!Object.hasOwn(instances, platform)) return json(404, {});
      const fixture = fixtures[platform];
      let input = {};

      if (fixture.jsonBody && body.length) {
        try {
          input = JSON.parse(body.toString('utf8'));
        } catch {
          return json(400, { error: 'Invalid request body' });
        }
      }

      // Fixtures see the provider path under `/proxy/<platform>/`, as they
      // did before connections moved into the path.
      const upstream = new URL(`/proxy/${platform}/${rest}${url.search}`, url);
      // Only the one request header the real proxy forwards upstream besides
      // Content-Type (proxy.rs upstream_request); never Authorization.
      const forwarded = req.headers['if-match']
        ? { 'if-match': req.headers['if-match'] }
        : {};
      // A fixture may answer asynchronously, or never (to simulate a lost
      // response; see the Clockify fixture's `applyThenDrop`).
      const result = await instances[platform].request(
        req.method,
        upstream,
        input,
        forwarded,
      );

      return json(result.status, result.body, result.headers ?? {});
    }

    json(404, {});
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      // A malformed request (e.g. a bad %-escape) must not take the mock down.
      console.error('mock-proxy:', error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // Test-side drivers, e.g. server.fixtures['github-issues'].createIssue().
  // The short aliases predate the registry; callers outside this repo
  // (atomic-server's browser/e2e specs) may still use them.
  server.fixtures = instances;
  server.github = instances['github-issues'];
  server.calendar = instances['google-calendar'];
  server.clockify = instances.clockify;
  /** In-process view of the proxy's own state, for tests. */
  server.proxyState = { connections, runtimes, handoffs };
  server.origin = origin;

  return server;
}

function publicRow(row) {
  return {
    connection_id: row.connection_id,
    platform: row.platform,
    owner: row.owner,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    delegations: [...row.delegations.values()],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const host = process.env.MOCK_PROXY_HOST ?? '127.0.0.1';
  const port = Number(process.env.MOCK_PROXY_PORT ?? 19090);
  mockProxy({
    baseUrl: process.env.MOCK_PROXY_BASE_URL ?? `http://${host}:${port}`,
  }).listen(port, host, function () {
    const { address, port: bound } = this.address();
    console.log(
      `Mock integration proxy listening on http://${address}:${bound}`,
    );
  });
}
