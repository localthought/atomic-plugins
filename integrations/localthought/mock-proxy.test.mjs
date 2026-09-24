/**
 * The mock integration proxy speaks the real proxy's 0.2 protocol
 * (ontola/atomic-plugins#54). Run without an atomic-server checkout:
 *
 *   node --test integrations/localthought/mock-proxy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { mockProxy } from './mock-proxy.mjs';
import {
  MAX_CAPABILITY_SECS,
  ProxyRefusal,
  agentFromPublicKey,
  mintCapability,
  parseAgent,
  parseCapability,
  testSigner,
  verifyCapability,
  verifyRequest,
} from './mock-proxy-auth.mjs';

const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const FRONTEND = 'http://localhost:6747';
const owner = testSigner(Buffer.alloc(32, 1));
const app = testSigner(Buffer.alloc(32, 2));
const frame = testSigner(Buffer.alloc(32, 3));
const stranger = testSigner(Buffer.alloc(32, 4));
const node = testSigner(Buffer.alloc(32, 5));

/** The shared golden vectors, copied from atomic-server into the proxy. */
const vectors = JSON.parse(
  readFileSync(
    new URL(
      '../../integration-proxy/tests/fixtures/atomic-request-v2-vectors.json',
      import.meta.url,
    ),
  ),
).vectors;

/**
 * atomic-server's capability vector (`browser/data-browser/src/helpers/
 * proxyConnections.test.ts`, "capability vector"), signed by the vectors'
 * user key; see plans/issue-54-atomic-server.md.
 */
const CAPABILITY_VECTOR =
  'eyJ2IjoyLCJjb25uZWN0aW9uX2lkIjoiY18xMjMiLCJwbGF0Zm9ybSI6Imdvb2dsZS1jYWxlbmRhciIsImF1ZCI6Imh0dHBzOi8vcHJveHkuZXhhbXBsZSIsImFwcCI6ImF0b21pYzphZ2VudDpBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFFIiwiY25mIjoiYXRvbWljOmFnZW50OkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkUiLCJleHAiOjE3OTAwMDA2MDB9.mKOEe3SnRDDRYFZ94kAqkXl_RnRy-pS-B5KdEzpdQVDPNE3PEHZq1e7aT9dL0GKhv00uZ2WiWmftEvto09xRDw';

async function start(options = {}) {
  const server = mockProxy({ frontendOrigin: FRONTEND, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const refusal = code => error =>
  error instanceof ProxyRefusal && error.code === code;

/** A v2-signed fetch, signed over exactly the URL and body sent. */
function signed(signer, method, url, { body, headers = {}, at } = {}) {
  return fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...signer.headers(method, new URL(url).href, body ?? '', at),
    },
    ...(body === undefined ? {} : { body }),
  });
}

async function errorOf(response) {
  return [response.status, (await response.json()).error];
}

function connectUrl(base, platform, extra = {}) {
  const url = new URL(`${base}/connect`);
  url.search = new URLSearchParams({
    redirect_uri: `${FRONTEND}/app/integrations?integration_state=abc&platform=${platform}`,
    platform,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  });

  return url;
}

/** The consent page and its form, as a browser would post it. */
async function consent(base, platform, fields = {}) {
  const page = await fetch(connectUrl(base, platform));
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];

  return {
    html,
    submit: () =>
      fetch(`${base}/connect/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, ...fields }),
      }),
  };
}

/**
 * The whole connect flow the data browser page runs: consent, redeem signed
 * by the owner, delegation to the app. Returns the connection id.
 */
async function connect(base, platform, fields = {}) {
  const { submit } = await consent(base, platform, fields);
  const back = new URL((await submit()).headers.get('location'));
  const code = back.searchParams.get('connection_code');
  const redeemed = await signed(owner, 'POST', `${base}/connect/redeem`, {
    body: JSON.stringify({ code, code_verifier: verifier }),
  });
  assert.equal(redeemed.status, 200);
  const { connection_id: id } = await redeemed.json();
  const delegated = await signed(
    owner,
    'POST',
    `${base}/connections/${id}/agents`,
    { body: JSON.stringify({ agent: app.agent, label: 'Test app' }) },
  );
  assert.equal(delegated.status, 200);

  return id;
}

/**
 * What a plugin frame does (atomic-server's view-client.js): a capability
 * from the page, then each request signed with the frame's own key.
 */
function frameClient(base, id, platform, claims = {}) {
  const capability = mintCapability(owner, {
    connection_id: id,
    platform,
    aud: base,
    app: app.agent,
    cnf: frame.agent,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  });

  return (method, path, { body, ifMatch, signer = frame, signal } = {}) =>
    fetch(`${base}/proxy/${id}/${platform}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Capability ${capability}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(ifMatch ? { 'If-Match': ifMatch } : {}),
        ...signer.headers(
          method,
          new URL(`${base}/proxy/${id}/${platform}${path}`).href,
          body ?? '',
        ),
      },
      ...(body === undefined ? {} : { body }),
    });
}

test('the shared v2 request vectors verify here, and nothing else does', () => {
  assert.ok(vectors.length >= 4);

  for (const v of vectors) {
    const headers = {
      'x-atomic-agent': v.agent,
      'x-atomic-public-key': v.public_key,
      'x-atomic-timestamp': String(v.timestamp),
      'x-atomic-signature': v.signature,
      'x-atomic-signature-version': '2',
    };
    assert.equal(
      verifyRequest(headers, v.method, v.url, v.body, v.timestamp).agent,
      v.agent,
      v.name,
    );
    // The same signer re-derives the same (deterministic) signature.
    assert.equal(
      testSigner(Buffer.from(v.private_key, 'base64')).headers(
        v.method,
        v.url,
        v.body,
        v.timestamp,
      )['x-atomic-signature'],
      v.signature.replace(/=+$/, ''),
      v.name,
    );

    for (const [method, url, body] of [
      [v.method === 'GET' ? 'POST' : 'GET', v.url, v.body],
      [v.method, `${v.url}x`, v.body],
      [v.method, v.url, `${v.body} `],
    ])
      assert.throws(
        () => verifyRequest(headers, method, url, body, v.timestamp),
        refusal('bad_signature'),
        v.name,
      );
    assert.throws(
      () =>
        verifyRequest(
          { ...headers, 'x-atomic-signature-version': undefined },
          v.method,
          v.url,
          v.body,
          v.timestamp,
        ),
      refusal('unsupported_signature_version'),
    );
    assert.throws(
      () =>
        verifyRequest(headers, v.method, v.url, v.body, v.timestamp + 300_001),
      refusal('stale_timestamp'),
    );
  }
});

test("atomic-server's capability vector verifies here", () => {
  const parsed = parseCapability(CAPABILITY_VECTOR);
  const user = parseAgent(
    'atomic:agent:O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik',
  );
  assert.deepEqual(parsed.claims, {
    v: 2,
    connection_id: 'c_123',
    platform: 'google-calendar',
    aud: 'https://proxy.example',
    app: `atomic:agent:${'A'.repeat(42)}E`,
    cnf: `atomic:agent:${'B'.repeat(42)}E`,
    exp: 1790000600,
  });
  verifyCapability(parsed, user, 'https://proxy.example', 1790000000);
  assert.throws(
    () =>
      verifyCapability(
        parsed,
        owner.agent,
        'https://proxy.example',
        1790000000,
      ),
    refusal('invalid_capability'),
  );
  assert.throws(
    () => verifyCapability(parsed, user, 'https://other.example', 1790000000),
    refusal('wrong_audience'),
  );
  assert.throws(
    () => verifyCapability(parsed, user, 'https://proxy.example', 1790000600),
    refusal('capability_expired'),
  );
  assert.throws(
    () =>
      verifyCapability(
        parsed,
        user,
        'https://proxy.example',
        1790000600 - MAX_CAPABILITY_SECS - 1,
      ),
    refusal('capability_too_long'),
  );
});

test('agent ids: both prefixes and alphabets, one canonical form', () => {
  const key = owner.publicKey;
  const standard = Buffer.from(key, 'base64url').toString('base64');
  for (const id of [
    `atomic:agent:${key}`,
    `did:ad:agent:${key}`,
    `atomic:agent:${standard}`,
    `did:ad:agent:${standard.replace(/=+$/, '')}`,
  ])
    assert.equal(parseAgent(id), owner.agent, id);
  for (const id of [
    'https://example.com/agents/x',
    `atomic:agent:${key.slice(1)}`,
    `atomic:agent:${key}!`,
    'atomic:agent:',
  ])
    assert.equal(parseAgent(id), undefined, id);
  assert.equal(agentFromPublicKey(key), owner.agent);
});

test('connect: consent without login, signed redeem makes the owner, delegation, frame capability', async () => {
  const { base, server, close } = await start({ platforms: '' });

  try {
    assert.deepEqual(await (await fetch(`${base}/catalog`)).json(), [
      'clockify',
      'github-issues',
      'google-calendar',
      'notion',
      'pets',
    ]);

    // The retired flow's parameters, a foreign return address, an unknown
    // platform and a weak challenge are all refused.
    for (const url of [
      connectUrl(base, 'pets', { user_id: 'synthetic-agent' }),
      connectUrl(base, 'pets', { credentials: 'connection' }),
      connectUrl(base, 'pets', { code_challenge: 'short' }),
      connectUrl(base, 'nope'),
    ])
      assert.equal((await fetch(url)).status, 400, url.href);
    const foreign = connectUrl(base, 'pets');
    foreign.searchParams.set(
      'redirect_uri',
      'http://evil.example/app/integrations?integration_state=abc&platform=pets',
    );
    assert.equal((await fetch(foreign)).status, 400);

    const { html, submit } = await consent(base, 'pets');
    assert.match(html, /Use LocalThought to sync Pets with this destination/);
    assert.doesNotMatch(html, /API key|GitHub|Google Calendar/);
    const back = new URL((await submit()).headers.get('location'));
    assert.equal(back.origin, FRONTEND);
    assert.equal(back.searchParams.get('platform'), 'pets');
    const code = back.searchParams.get('connection_code');
    assert.equal(code.length, 43);
    // The consent form is single use.
    assert.equal((await submit()).status, 400);

    const redeem = (signer, codeVerifier = verifier, extra = {}) =>
      signed(signer, 'POST', `${base}/connect/redeem`, {
        body: JSON.stringify({ code, code_verifier: codeVerifier, ...extra }),
      });
    const unsigned = await fetch(`${base}/connect/redeem`, {
      method: 'POST',
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    assert.deepEqual(await errorOf(unsigned), [401, 'missing_signature']);
    assert.deepEqual(await errorOf(await redeem(owner, 'b'.repeat(64))), [
      400,
      'invalid_handoff',
    ]);
    assert.deepEqual(await errorOf(await redeem(owner, verifier, { x: 1 })), [
      400,
      'bad_request',
    ]);
    const redeemed = await redeem(owner);
    assert.equal(redeemed.status, 200);
    const result = await redeemed.json();
    assert.deepEqual(Object.keys(result).sort(), [
      'connection_id',
      'owner',
      'platform',
    ]);
    assert.equal(result.platform, 'pets');
    assert.equal(result.owner, owner.agent);
    const id = result.connection_id;
    assert.deepEqual(await errorOf(await redeem(owner)), [
      400,
      'invalid_handoff',
    ]);

    // Listed for the owner only.
    const list = async signer =>
      (await signed(signer, 'GET', `${base}/connections`)).json();
    const mine = await list(owner);
    assert.equal(mine.owner, owner.agent);
    assert.deepEqual(
      mine.connections.map(c => [c.connection_id, c.platform, c.delegations]),
      [[id, 'pets', []]],
    );
    assert.deepEqual((await list(stranger)).connections, []);

    // Not delegated yet: a frame capability is refused.
    const call = frameClient(base, id, 'pets');
    assert.deepEqual(await errorOf(await call('GET', '/pets')), [
      403,
      'not_delegated',
    ]);

    // Only the owner delegates; a did:ad spelling is stored canonically.
    const delegate = (signer, body) =>
      signed(signer, 'POST', `${base}/connections/${id}/agents`, {
        body: JSON.stringify(body),
      });
    assert.deepEqual(
      await errorOf(await delegate(stranger, { agent: app.agent })),
      [403, 'not_owner'],
    );
    assert.deepEqual(
      await errorOf(await delegate(owner, { agent: 'https://x.example/a' })),
      [400, 'bad_request'],
    );
    const delegated = await delegate(owner, {
      agent: app.agent.replace('atomic:agent:', 'did:ad:agent:'),
      label: 'Pets app',
    });
    assert.deepEqual(await delegated.json(), {
      connection_id: id,
      agent: app.agent,
      label: 'Pets app',
    });

    // The frame's call reaches the fixture, with its paging headers.
    const first = await call('GET', '/pets');
    assert.equal(first.status, 200);
    assert.equal((await first.json()).length, 2);
    assert.match(first.headers.get('link'), /page=2/);
    assert.equal(first.headers.get('x-connection-code'), null);
    assert.equal((await (await call('GET', '/pets?page=2')).json()).length, 3);
    const listed = (await list(owner)).connections[0];
    assert.ok(listed.last_used_at);
    assert.ok(listed.delegations[0].last_used_at);

    // The owner and the delegated app may sign requests themselves.
    for (const signer of [owner, app])
      assert.equal(
        (await signed(signer, 'GET', `${base}/proxy/${id}/pets/pets`)).status,
        200,
      );
    assert.deepEqual(
      await errorOf(
        await signed(stranger, 'GET', `${base}/proxy/${id}/pets/pets`),
      ),
      [403, 'not_delegated'],
    );

    // A node's agent registered as a runtime of the app may too.
    assert.deepEqual(
      await errorOf(await signed(node, 'GET', `${base}/proxy/${id}/pets/pets`)),
      [403, 'not_delegated'],
    );
    const runtime = await signed(owner, 'POST', `${base}/runtimes`, {
      body: JSON.stringify({ app: app.agent, agent: node.agent, label: 'n' }),
    });
    assert.equal(runtime.status, 200);
    assert.equal(
      (await signed(node, 'GET', `${base}/proxy/${id}/pets/pets`)).status,
      200,
    );
    assert.deepEqual(
      (await list(owner)).runtimes.map(r => [r.agent, r.app]),
      [[node.agent, app.agent]],
    );
    assert.deepEqual(
      await errorOf(
        await signed(owner, 'POST', `${base}/runtimes`, {
          body: JSON.stringify({ app: app.agent, agent: owner.agent }),
        }),
      ),
      [400, 'bad_request'],
    );
    assert.equal(
      (
        await signed(
          owner,
          'DELETE',
          `${base}/runtimes/${encodeURIComponent(node.agent)}`,
        )
      ).status,
      204,
    );
    assert.deepEqual(
      await errorOf(await signed(node, 'GET', `${base}/proxy/${id}/pets/pets`)),
      [403, 'not_delegated'],
    );

    // Introspection for specs in another process.
    const state = await (await fetch(`${base}/__mock/connections`)).json();
    assert.deepEqual(
      state.connections.map(c => [c.owner, c.delegations.map(d => d.agent)]),
      [[owner.agent, [app.agent]]],
    );
    assert.equal(server.proxyState.connections.size, 1);

    // Revoking the delegation stops the frame at once; deleting the
    // connection makes it unknown.
    assert.equal(
      (
        await signed(
          owner,
          'DELETE',
          `${base}/connections/${id}/agents/${encodeURIComponent(app.agent)}`,
        )
      ).status,
      204,
    );
    assert.deepEqual(await errorOf(await call('GET', '/pets')), [
      403,
      'not_delegated',
    ]);
    assert.deepEqual(
      await errorOf(
        await signed(stranger, 'DELETE', `${base}/connections/${id}`),
      ),
      [403, 'not_owner'],
    );
    assert.equal(
      (await signed(owner, 'DELETE', `${base}/connections/${id}`)).status,
      204,
    );
    assert.deepEqual(await errorOf(await call('GET', '/pets')), [
      404,
      'unknown_connection',
    ]);
  } finally {
    await close();
  }
});

test('every refusal on a proxied request has the real proxy’s code', async () => {
  const { base, close } = await start({ platforms: 'pets,notion' });

  try {
    const id = await connect(base, 'pets');
    const url = `${base}/proxy/${id}/pets/pets`;
    const now = Math.floor(Date.now() / 1000);
    const expectError = async (response, status, code) =>
      assert.deepEqual(await errorOf(response), [status, code], code);

    await expectError(
      await fetch(url, { headers: { Authorization: 'Bearer old-code' } }),
      401,
      'unsupported_authorization',
    );
    await expectError(await fetch(url), 401, 'missing_signature');
    // v1 (no version header): never accepted.
    const v1 = owner.headers('GET', url);
    delete v1['x-atomic-signature-version'];
    await expectError(
      await fetch(url, { headers: v1 }),
      401,
      'unsupported_signature_version',
    );
    await expectError(
      await signed(owner, 'GET', url, { at: Date.now() - 400_000 }),
      401,
      'stale_timestamp',
    );
    // Signed for another origin (e.g. `localhost` instead of the configured
    // 127.0.0.1): the full URL is part of the message.
    await expectError(
      await fetch(url, {
        headers: owner.headers('GET', url.replace('127.0.0.1', 'localhost')),
      }),
      401,
      'bad_signature',
    );
    const mixed = {
      ...owner.headers('GET', url),
      'x-atomic-agent': stranger.agent,
    };
    await expectError(
      await fetch(url, { headers: mixed }),
      401,
      'agent_key_mismatch',
    );
    const once = owner.headers('GET', url);
    assert.equal((await fetch(url, { headers: once })).status, 200);
    await expectError(await fetch(url, { headers: once }), 401, 'replayed');

    const capabilityCases = [
      [{}, frame, 200],
      [{ exp: now - 1 }, frame, [401, 'capability_expired']],
      [{ exp: now + 901 + 5 }, frame, [401, 'capability_too_long']],
      [{ aud: 'http://localhost:1' }, frame, [401, 'wrong_audience']],
      [{ platform: 'notion' }, frame, [403, 'capability_scope']],
      [{ connection_id: 'x'.repeat(43) }, frame, [403, 'capability_scope']],
      [{ app: stranger.agent }, frame, [403, 'not_delegated']],
      [{}, stranger, [401, 'capability_key_mismatch']],
    ];

    for (const [claims, signer, expected] of capabilityCases) {
      const response = await frameClient(
        base,
        id,
        'pets',
        claims,
      )('GET', '/pets', { signer });
      if (expected === 200) assert.equal(response.status, 200);
      else await expectError(response, ...expected);
    }

    // Signed by someone other than the owner.
    const forged = `${mintCapability(stranger, {
      connection_id: id,
      platform: 'pets',
      aud: base,
      app: app.agent,
      cnf: frame.agent,
      exp: now + 600,
    })}`;
    await expectError(
      await fetch(url, {
        headers: {
          Authorization: `Capability ${forged}`,
          ...frame.headers('GET', url),
        },
      }),
      401,
      'invalid_capability',
    );
    // A capability for the right connection on the wrong route's platform.
    await expectError(
      await signed(owner, 'GET', `${base}/proxy/${id}/notion/v1/search`),
      403,
      'platform_mismatch',
    );
    // fetch() would normalise the dot segment away; send it raw.
    const traversal = await new Promise((resolve, reject) =>
      request(
        {
          host: '127.0.0.1',
          port: new URL(base).port,
          path: `/proxy/${id}/pets/%2e%2e/secret`,
        },
        resolve,
      )
        .on('error', reject)
        .end(),
    );
    assert.equal(traversal.statusCode, 400);
    // A management call must be signed too.
    await expectError(
      await fetch(`${base}/connections`),
      401,
      'missing_signature',
    );
  } finally {
    await close();
  }
});

test('CORS lets a null-origin frame send the signature headers and a capability', async () => {
  const { base, close } = await start({ platforms: 'pets' });

  try {
    const preflight = await fetch(`${base}/proxy/x/pets/pets`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers':
          'authorization,x-atomic-signature-version',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    const allowed = preflight.headers
      .get('access-control-allow-headers')
      .toLowerCase();
    for (const name of [
      'authorization',
      'content-type',
      'if-match',
      'x-atomic-agent',
      'x-atomic-public-key',
      'x-atomic-timestamp',
      'x-atomic-signature',
      'x-atomic-signature-version',
    ])
      assert.ok(allowed.includes(name), name);
    const exposed = preflight.headers
      .get('access-control-expose-headers')
      .toLowerCase();
    for (const name of ['link', 'retry-after', 'etag', 'content-type'])
      assert.ok(exposed.includes(name), name);
    assert.ok(!exposed.includes('x-connection-code'));
  } finally {
    await close();
  }
});

test('API-key platforms take the key on the consent page; cancel returns access_denied', async () => {
  const { base, close } = await start({ platforms: 'clockify' });

  try {
    const blank = await consent(base, 'clockify');
    assert.match(blank.html, /name="api_key"/);
    assert.match(blank.html, /Connect Clockify/);
    assert.equal((await blank.submit()).status, 400);

    const cancelled = await consent(base, 'clockify', { cancel: '1' });
    const back = new URL((await cancelled.submit()).headers.get('location'));
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('connection_code'), null);

    assert.equal(
      (await connect(base, 'clockify', { api_key: 'synthetic-key' })).length,
      43,
    );
  } finally {
    await close();
  }
});

test('test-side revoke drops a delegation or a whole connection', async () => {
  const { base, close } = await start({ platforms: 'pets' });

  try {
    const id = await connect(base, 'pets');
    const call = frameClient(base, id, 'pets');
    const revoke = body =>
      fetch(`${base}/__mock/revoke`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    assert.equal((await call('GET', '/pets')).status, 200);
    assert.equal(
      (await revoke({ connection_id: id, agent: app.agent })).status,
      200,
    );
    assert.deepEqual(await errorOf(await call('GET', '/pets')), [
      403,
      'not_delegated',
    ]);
    assert.equal((await revoke({ connection_id: id })).status, 200);
    assert.deepEqual(await errorOf(await call('GET', '/pets')), [
      404,
      'unknown_connection',
    ]);
    assert.equal((await revoke({ connection_id: id })).status, 404);
  } finally {
    await close();
  }
});

test('MOCK_PROXY_PLATFORMS restricts the catalog, consent and catalog documents', async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  const server = mockProxy({ platforms: 'pets,todoist,pets' });
  console.warn = warn;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.deepEqual(await (await fetch(`${base}/catalog`)).json(), ['pets']);
    assert.deepEqual(warnings, [
      'mock-proxy: no fixture for todoist; not served',
    ]);
    assert.equal((await fetch(`${base}/catalog/pets.yaml`)).status, 200);
    assert.equal((await fetch(`${base}/catalog/clockify.yaml`)).status, 404);
    assert.equal(
      (await fetch(`${base}/catalog/clockify.selection.json`)).status,
      404,
    );
    assert.equal((await fetch(connectUrl(base, 'clockify'))).status, 400);
    assert.equal(server.clockify, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('an empty platform list serves every fixture', async () => {
  const { base, server, close } = await start({ platforms: '' });

  try {
    for (const id of ['clockify', 'google-calendar', 'notion', 'pets'])
      assert.equal((await fetch(`${base}/catalog/${id}.yaml`)).status, 200);
    assert.ok(server.github.createIssue);
    assert.ok(server.calendar.events);
    assert.ok(server.clockify.state);
    assert.deepEqual(server.fixtures.notion.requests, []);
  } finally {
    await close();
  }
});

test('fixture driver: POST /__fixture/<platform> reaches control(), nothing else does', async () => {
  const { base, server, close } = await start({ platforms: 'clockify,notion' });
  const drive = (platform, command, method = 'POST') =>
    fetch(`${base}/__fixture/${platform}`, {
      method,
      ...(method === 'POST' ? { body: JSON.stringify(command) } : {}),
    });

  try {
    assert.equal((await drive('clockify', {}, 'GET')).status, 405);
    // No control() on the notion fixture, and no such fixture at all.
    assert.equal((await drive('notion', { action: 'requests' })).status, 404);
    assert.equal((await drive('pets', { action: 'requests' })).status, 404);

    const failed = await drive('clockify', { action: 'fail', status: 503 });
    assert.deepEqual(await failed.json(), {
      failures: { count: 1, status: 503 },
    });
    assert.deepEqual(server.clockify.state.failures, {
      count: 1,
      status: 503,
    });
  } finally {
    await close();
  }
});

test('notion: POST list bodies reach the fixture; the cursor travels in the body', async () => {
  const { base, server, close } = await start({ platforms: 'notion' });

  try {
    const document = await (await fetch(`${base}/catalog/notion.yaml`)).json();
    assert.ok(document.components.crudResources.page);
    const call = frameClient(base, await connect(base, 'notion'), 'notion');

    const post = async (path, body) => {
      const response = await call('POST', path, { body: JSON.stringify(body) });

      return { status: response.status, body: await response.json() };
    };

    const sources = await post('/v1/search', {
      filter: { property: 'object', value: 'data_source' },
    });
    assert.equal(sources.status, 200);
    const [source] = sources.body.results;
    assert.equal(source.object, 'data_source');
    const query = `/v1/data_sources/${source.id}/query`;
    const first = await post(query, { page_size: 100 });
    assert.equal(first.body.results.length, 2);
    assert.equal(first.body.has_more, true);
    const second = await post(query, {
      page_size: 100,
      start_cursor: first.body.next_cursor,
    });
    assert.equal(second.body.results.length, 1);
    assert.equal(second.body.next_cursor, null);
    assert.equal(
      (await post(query, { start_cursor: 'not-a-cursor' })).status,
      400,
    );
    assert.equal((await post('/v1/pages', { properties: {} })).status, 403);
    assert.deepEqual(
      server.fixtures.notion.requests.map(r => [r.method, r.path]).slice(0, 3),
      [
        ['POST', '/v1/search'],
        ['POST', query],
        ['POST', query],
      ],
    );
    assert.equal(
      server.fixtures.notion.requests[2].body.start_cursor,
      first.body.next_cursor,
    );
  } finally {
    await close();
  }
});

test('google-calendar: If-Match reaches the fixture, ETag comes back, CORS allows both', async () => {
  const { base, server, close } = await start({
    platforms: 'google-calendar',
  });

  try {
    const preflight = await fetch(`${base}/proxy/x/google-calendar/x`, {
      method: 'OPTIONS',
    });
    assert.match(
      preflight.headers.get('access-control-allow-headers'),
      /If-Match/,
    );
    assert.match(
      preflight.headers.get('access-control-expose-headers'),
      /ETag/,
    );

    const frameCall = frameClient(
      base,
      await connect(base, 'google-calendar'),
      'google-calendar',
    );

    const call = async (method, path, { body, ifMatch } = {}) => {
      const response = await frameCall(method, `/calendar/v3${path}`, {
        ...(body ? { body: JSON.stringify(body) } : {}),
        ifMatch,
      });

      return {
        status: response.status,
        etag: response.headers.get('etag'),
        body: await response.json(),
      };
    };

    const event = await call('GET', '/calendars/primary/events/timed');
    assert.equal(event.status, 200);
    assert.equal(event.etag, event.body.etag);
    const path = '/calendars/primary/events/timed?sendUpdates=none';
    const patch = { summary: 'Renamed' };
    assert.equal((await call('PATCH', path, { body: patch })).status, 428);
    assert.equal(
      (await call('PATCH', path, { body: patch, ifMatch: '"stale"' })).status,
      412,
    );
    const written = await call('PATCH', path, {
      body: patch,
      ifMatch: event.etag,
    });
    assert.equal(written.status, 200);
    assert.equal(written.body.summary, 'Renamed');
    assert.notEqual(written.etag, event.etag);
    assert.deepEqual(server.calendar.writes, [
      { id: 'timed', patch, ifMatch: event.etag },
    ]);

    // Drivers: only the listed ones, POST only, JSON array arguments.
    const drive = (name, args, method = 'POST') =>
      fetch(`${base}/fixture/google-calendar/${name}`, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify(args) } : {}),
      });
    const edited = await drive('editRemote', ['timed', { location: 'Room 9' }]);
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).location, 'Room 9');
    assert.equal((await drive('editRemote', ['nope', {}])).status, 409);
    assert.equal((await drive('request', [])).status, 404);
    assert.equal((await drive('state', [], 'GET')).status, 404);
    assert.equal((await drive('state', {})).status, 400);
    const state = await (await drive('state', [])).json();
    assert.equal(state.writes.length, 1);
    assert.equal(
      (await fetch(`${base}/fixture/pets/state`, { method: 'POST' })).status,
      404,
    );
  } finally {
    await close();
  }
});

test('clockify: JSON write bodies reach the fixture, PUT passes CORS, a dropped response never answers', async () => {
  const { base, server, close } = await start({ platforms: 'clockify' });
  const workspace = '/api/v1/workspaces/aaaaaaaaaaaaaaaaaaaaaaaa';

  try {
    const preflight = await fetch(`${base}/proxy/x/clockify${workspace}`, {
      method: 'OPTIONS',
    });
    assert.match(
      preflight.headers.get('access-control-allow-methods'),
      /\bPUT\b/,
    );
    assert.match(
      preflight.headers.get('access-control-expose-headers'),
      /\bLast-Page\b/,
    );
    const frameCall = frameClient(
      base,
      await connect(base, 'clockify', { api_key: 'synthetic-key' }),
      'clockify',
    );

    const call = async (method, path, body) => {
      const response = await frameCall(method, path, {
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();

      return {
        status: response.status,
        headers: response.headers,
        body: text ? JSON.parse(text) : null,
      };
    };

    const put = await call('PUT', `${workspace}/time-entries/entry-1`, {
      start: '2026-09-01T08:00:00Z',
      end: '2026-09-01T09:00:00Z',
      projectId: 'cccccccccccccccccccccccc',
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.timeInterval.end, '2026-09-01T09:00:00Z');
    assert.equal(put.body.description, '');
    assert.deepEqual(server.clockify.state.writes.at(-1), {
      method: 'PUT',
      path: `/proxy/clockify${workspace}/time-entries/entry-1`,
      body: {
        start: '2026-09-01T08:00:00Z',
        end: '2026-09-01T09:00:00Z',
        projectId: 'cccccccccccccccccccccccc',
      },
    });

    const list = await call(
      'GET',
      `${workspace}/user/bbbbbbbbbbbbbbbbbbbbbbbb/time-entries`,
    );
    assert.equal(list.headers.get('last-page'), 'true');
    assert.equal(
      (await call('DELETE', `${workspace}/time-entries/entry-2`)).status,
      204,
    );
    // As Clockify answers live: 400 "doesn't belong to Workspace".
    assert.equal(
      (await call('GET', `${workspace}/time-entries/entry-2`)).status,
      400,
    );

    // A write whose response is lost: applied, then no answer at all.
    server.clockify.control({ action: 'applyThenDrop', hang: true });
    const controller = new AbortController();
    const pending = frameCall('POST', `${workspace}/time-entries`, {
      body: JSON.stringify({ start: '2026-09-02T08:00:00Z' }),
      signal: controller.signal,
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(
      server.clockify.state.entries.some(
        e => e.timeInterval.start === '2026-09-02T08:00:00Z',
      ),
    );
    controller.abort();
    await assert.rejects(pending);
  } finally {
    await close();
  }
});

test('github-issues: the repository picker pages with Link; labels change one at a time', async () => {
  const { base, close } = await start({ platforms: 'github-issues' });

  try {
    const call = frameClient(
      base,
      await connect(base, 'github-issues'),
      'github-issues',
    );
    const read = async (method, path, body) => {
      const response = await call(method, path, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      return {
        status: response.status,
        link: response.headers.get('link'),
        body: await response.json(),
      };
    };

    // The seeded repository plus the one with issues turned off.
    const all = await read('GET', '/user/repos?per_page=100&sort=updated');
    assert.equal(all.status, 200);
    assert.equal(all.link, null);
    assert.deepEqual(
      all.body.map(r => [r.full_name, r.has_issues]),
      [
        ['atomic-fixture/tracker', true],
        ['atomic-fixture/no-issues', false],
      ],
    );
    assert.equal(all.body[0].open_issues_count, 2);
    const first = await read('GET', '/user/repos?per_page=1&sort=updated');
    assert.deepEqual(
      first.body.map(r => r.full_name),
      ['atomic-fixture/tracker'],
    );
    assert.equal(
      first.link,
      '<https://api.github.com/user/repos?per_page=1&sort=updated&page=2>; rel="next", ' +
        '<https://api.github.com/user/repos?per_page=1&sort=updated&page=2>; rel="last"',
    );
    const second = await read(
      'GET',
      '/user/repos?per_page=1&sort=updated&page=2',
    );
    assert.deepEqual(
      second.body.map(r => r.full_name),
      ['atomic-fixture/no-issues'],
    );
    assert.match(second.link, /page=1>; rel="first"/);
    assert.doesNotMatch(second.link, /rel="next"/);
    assert.equal((await read('POST', '/user/repos', {})).status, 404);

    // Issue 1 carries `bug`; Doing adds one label and keeps the others.
    const labels = '/repos/atomic-fixture/tracker/issues/1/labels';
    const added = await read('POST', labels, { labels: ['atomic:doing'] });
    assert.deepEqual(added, {
      status: 200,
      link: null,
      body: ['bug', 'atomic:doing'],
    });
    assert.equal((await read('POST', labels, { labels: [] })).status, 422);
    const removed = await read('DELETE', `${labels}/atomic%3Adoing`);
    assert.deepEqual([removed.status, removed.body], [200, ['bug']]);
    // As GitHub: removing a label the issue no longer has is a 404.
    assert.equal(
      (await read('DELETE', `${labels}/atomic%3Adoing`)).status,
      404,
    );
    assert.equal(
      (
        await read(
          'DELETE',
          '/repos/atomic-fixture/tracker/issues/99/labels/bug',
        )
      ).status,
      404,
    );
  } finally {
    await close();
  }
});
