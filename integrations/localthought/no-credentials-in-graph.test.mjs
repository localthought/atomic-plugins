/**
 * Guard for ontola/atomic-plugins#21 and #54: nothing that grants access to a
 * provider through the integration proxy may become Atomic graph data, and
 * plugin code must not do the host's signing.
 *
 * Since #54 phase 2 there are no rotating connection codes any more. The
 * proxy account is the user's Atomic agent; a connection lives at the proxy;
 * the data browser page signs its own calls with the user key; a plugin
 * frame gets a short-lived capability from the page and signs each request
 * with a key only it holds (atomic-server's `view-client.js`). None of that
 * belongs in a plugin's source or in the drive. The rules:
 *
 * 1. **No credential-shaped graph property.** A property URL that names a
 *    connection code, a capability or a PKCE code verifier. (An unmerged
 *    Clockify drive plugin once saved the rotated code as
 *    `.../properties/connection-code`, into a commit that syncs.) A
 *    connection *id* is a reference, not a credential, and is allowed.
 * 2. **No retired rotation header.** `x-connection-code` carried the next
 *    rotating code; nothing may read or send it any more.
 * 3. **No request signing or capability minting in plugin code.** The
 *    `x-atomic-signature` header and the capability's signed prefix
 *    (`integration-proxy-capability-v2`) belong to the host (atomic-server's
 *    page and `view-client.js`) and to the proxy. The mock proxy's own
 *    verifier (`mock-proxy-auth.mjs`) is a `mock-*` file and skipped.
 *
 * Scope and limits, stated exactly: this is a line-by-line text scan of
 * `.ts`/`.tsx`/`.js`/`.mjs` files, not a data-flow analysis. It does not
 * catch a credential saved under an unrelated property name after being
 * obtained some other way. Tests (`*.test.*`, `*.spec.*`), `e2e/`
 * directories, `mock-*` servers, `node_modules` and `dist` are skipped,
 * since they legitimately emit or inspect these values.
 *
 * Plain `node --test`, no dependencies, so it runs in this repo's own CI
 * ("Tooling unit tests" in .github/workflows/ci.yml) without an
 * atomic-server checkout:
 *
 *   node --test integrations/localthought/no-credentials-in-graph.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const integrationsRoot = fileURLToPath(new URL('..', import.meta.url));

const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'e2e',
  'playwright-report',
]);
const SOURCE = /\.(ts|tsx|js|mjs)$/;
const NOT_SHIPPED = /(\.test\.|\.spec\.|(^|\/)mock-[^/]*$)/;

const RULES = [
  {
    rule: 'credential-shaped property',
    /** A graph property whose name says it holds a code, capability or verifier. */
    pattern:
      /\/properties\/[^\s'"`]*(connection[-_]?code|capabilit|code[-_]?verifier)/i,
  },
  {
    rule: 'retired rotation header',
    pattern: /x-connection-code/i,
  },
  {
    rule: 'host signing in plugin code',
    pattern: /x-atomic-signature|integration-proxy-capability-v2/i,
  },
];

export function findCredentialLeaks(file, source) {
  const leaks = [];
  source.split('\n').forEach((text, index) => {
    for (const { rule, pattern } of RULES)
      if (pattern.test(text))
        leaks.push({ file, line: index + 1, rule, text: text.trim() });
  });

  return leaks;
}

function shippedSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return SKIPPED_DIRS.has(entry.name) ? [] : shippedSources(path);
    const file = relative(integrationsRoot, path).split(sep).join('/');

    return SOURCE.test(file) && !NOT_SHIPPED.test(file) ? [file] : [];
  });
}

test('flags the old Clockify App.tsx/proxyClient.ts pattern', () => {
  const phase2 = [
    "  connectionCode: 'https://atomicdata.dev/integrations/clockify/properties/connection-code',",
    "  const nextCode = response.headers.get('x-connection-code');",
  ].join('\n');

  assert.deepEqual(
    findCredentialLeaks('clockify/app/src/App.tsx', phase2).map(l => [
      l.line,
      l.rule,
    ]),
    [
      [1, 'credential-shaped property'],
      [2, 'retired rotation header'],
    ],
  );
});

test('flags the underscore spelling, a capability and a verifier property', () => {
  for (const line of [
    "set('https://example.com/properties/proxy_connection_code', c)",
    "set('https://example.com/properties/proxy-capability', token)",
    "set('https://example.com/properties/code_verifier', v)",
  ])
    assert.equal(findCredentialLeaks('x/app.ts', line).length, 1, line);
});

test('flags a plugin that signs requests or mints capabilities itself', () => {
  for (const line of [
    "headers['x-atomic-signature'] = await sign(message);",
    "const prefix = 'integration-proxy-capability-v2\\n';",
  ])
    assert.deepEqual(
      findCredentialLeaks('pets/app/transport.ts', line).map(l => l.rule),
      ['host signing in plugin code'],
      line,
    );
});

test('allows a non-secret connection reference', () => {
  assert.deepEqual(
    findCredentialLeaks(
      'x/app.ts',
      "set('https://example.com/properties/connection-id', connectionId)",
    ),
    [],
  );
});

test('the walk reaches plugin sources, so it is not silently empty', () => {
  const sources = shippedSources(integrationsRoot);
  for (const file of [
    'pets/app/transport.ts',
    'issue-tracker/devonian/github-issues/proxy.mjs',
  ])
    assert.ok(sources.includes(file), file);
  assert.ok(!sources.includes('localthought/mock-proxy-auth.mjs'));
});

test('no shipped source persists a credential, uses the rotation header or signs for the host', () => {
  const leaks = shippedSources(integrationsRoot).flatMap(file =>
    findCredentialLeaks(
      file,
      readFileSync(join(integrationsRoot, file), 'utf8'),
    ),
  );

  assert.deepEqual(leaks, []);
});
