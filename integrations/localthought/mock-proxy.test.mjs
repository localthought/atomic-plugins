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

test('fixture driver: POST /__fixture/<platform> reaches control(), nothing else does', async () => {
  const server = mockProxy({ platforms: 'clockify,notion' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
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
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

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

test('google-calendar: If-Match reaches the fixture, ETag comes back, CORS allows both', async () => {
  const server = mockProxy({ platforms: 'google-calendar' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const preflight = await fetch(`${base}/proxy/google-calendar/x`, {
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

    let code = await connect(base, 'google-calendar');

    const call = async (method, path, { body, ifMatch } = {}) => {
      const response = await fetch(
        `${base}/proxy/google-calendar/calendar/v3${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${code}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(ifMatch ? { 'If-Match': ifMatch } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      code = response.headers.get('x-connection-code');

      return {
        status: response.status,
        etag: response.headers.get('etag'),
        body: await response.json(),
      };
    };

    const event = await call('GET', '/calendars/primary/events/timed');
    assert.equal(event.status, 200);
    assert.equal(event.etag, event.body.etag);
    const path = '/calendars/primary/events/timed?sendUpdates=all';
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
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('clockify: JSON write bodies reach the fixture, PUT passes CORS, a dropped response never answers', async () => {
  const server = mockProxy({ platforms: 'clockify' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const workspace = '/api/v1/workspaces/aaaaaaaaaaaaaaaaaaaaaaaa';

  try {
    const preflight = await fetch(`${base}/proxy/clockify${workspace}`, {
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
    let code = await connect(base, 'clockify');

    const call = async (method, path, body) => {
      const response = await fetch(`${base}/proxy/clockify${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${code}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      code = response.headers.get('x-connection-code');
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
    const pending = fetch(`${base}/proxy/clockify${workspace}/time-entries`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${code}`,
        'Content-Type': 'application/json',
      },
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
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
