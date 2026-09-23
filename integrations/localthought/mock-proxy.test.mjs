import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mockProxy } from './mock-proxy.mjs';

const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

test('catalog, selected-platform PKCE consent, redemption and single-use rotation', async () => {
  const server = mockProxy({ platforms: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.deepEqual(await (await fetch(`${base}/catalog`)).json(), [
      'clockify',
      'github-issues',
      'google-calendar',
      'notion',
      'pets',
    ]);
    const callback =
      'http://localhost:6747/app/integrations?integration_state=abc&platform=pets';
    const url = new URL(`${base}/connect`);
    url.search = new URLSearchParams({
      redirect_uri: callback,
      platform: 'pets',
      user_id: 'synthetic-agent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      credentials: 'connection',
    });
    const login = await fetch(url);
    assert.equal(login.status, 200);
    const loginHtml = await login.text();
    assert.match(
      loginHtml,
      /Use LocalThought to sync Pets with your Atomic Data Hub/,
    );
    assert.doesNotMatch(loginHtml, /tenant secret/i);
    assert.doesNotMatch(loginHtml, /GitHub|Google Calendar/);

    const badPlatform = new URL(url);
    badPlatform.searchParams.set('platform', 'github-issues');
    assert.equal((await fetch(badPlatform)).status, 400);

    const consent = await fetch(url, { method: 'POST', redirect: 'manual' });
    assert.equal(consent.status, 303);
    const location = new URL(consent.headers.get('location'));
    const handoff = location.searchParams.get('connection_code');
    assert.equal(location.searchParams.get('platform'), 'pets');
    assert.ok(handoff);

    const redeem = codeVerifier =>
      fetch(`${base}/connect/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: handoff, code_verifier: codeVerifier }),
      });
    assert.equal((await redeem('wrong-verifier')).status, 400);
    const redeemed = await redeem(verifier);
    assert.equal(redeemed.status, 200);
    const result = await redeemed.json();
    assert.equal(result.platform, 'pets');
    assert.equal(typeof result.connection_code, 'string');
    assert.ok(result.connection_code);
    assert.equal((await redeem(verifier)).status, 400);

    const read = (token, query = '') =>
      fetch(`${base}/proxy/pets/pets${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    const first = await read(result.connection_code);
    assert.equal((await first.json()).length, 2);
    assert.match(first.headers.get('link'), /page=2/);
    assert.equal((await read(result.connection_code)).status, 401);
    const second = await read(
      first.headers.get('x-connection-code'),
      '?page=2',
    );
    assert.equal((await second.json()).length, 3);
    assert.equal(
      (
        await fetch(`${base}/proxy/google-calendar/events`, {
          headers: {
            Authorization: `Bearer ${second.headers.get('x-connection-code')}`,
          },
        })
      ).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
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
    const url = new URL(`${base}/connect`);
    url.search = new URLSearchParams({
      redirect_uri:
        'http://localhost:6747/app/integrations?integration_state=abc&platform=clockify',
      platform: 'clockify',
      user_id: 'synthetic-agent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      credentials: 'connection',
    });
    assert.equal((await fetch(url)).status, 400);
    assert.equal(server.clockify, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('an empty platform list serves every fixture', async () => {
  const server = mockProxy({ platforms: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.deepEqual(await (await fetch(`${base}/catalog`)).json(), [
      'clockify',
      'github-issues',
      'google-calendar',
      'notion',
      'pets',
    ]);
    for (const id of ['clockify', 'google-calendar', 'notion', 'pets'])
      assert.equal((await fetch(`${base}/catalog/${id}.yaml`)).status, 200);
    assert.ok(server.github.createIssue);
    assert.ok(server.calendar.events);
    assert.ok(server.clockify.state);
    assert.deepEqual(server.fixtures.notion.requests, []);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

/** Connects through /connect and /connect/redeem; returns the first code. */
async function connect(base, platform) {
  const url = new URL(`${base}/connect`);
  url.search = new URLSearchParams({
    redirect_uri: `http://localhost:6747/app/integrations?integration_state=abc&platform=${platform}`,
    platform,
    user_id: 'synthetic-agent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    credentials: 'connection',
  });
  const consent = await fetch(url, { method: 'POST', redirect: 'manual' });
  const handoff = new URL(consent.headers.get('location')).searchParams.get(
    'connection_code',
  );
  const redeemed = await fetch(`${base}/connect/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: handoff, code_verifier: verifier }),
  });

  return (await redeemed.json()).connection_code;
}

test('notion: POST list bodies reach the fixture; the cursor travels in the body', async () => {
  const server = mockProxy({ platforms: 'notion' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const document = await (await fetch(`${base}/catalog/notion.yaml`)).json();
    assert.ok(document.components.crudResources.page);
    let code = await connect(base, 'notion');

    const post = async (path, body) => {
      const response = await fetch(`${base}/proxy/notion${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${code}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      code = response.headers.get('x-connection-code');

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
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
