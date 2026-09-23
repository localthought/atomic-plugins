/**
 * Guard for ontola/atomic-plugins#21: a LocalThought rotating connection code
 * is a live bearer credential and must never become Atomic graph data.
 *
 * `browser.ts` is the one sanctioned owner of the code: it keeps it in the
 * browser's `Storage` (localStorage), outside the synced graph, and never
 * returns it to callers. An unmerged Phase 2 of the Clockify drive plugin
 * (branch `claude/hopeful-hawking-kqlrdy`, `integrations/clockify/app/src/
 * App.tsx:14,47-50`) instead read the rotated `x-connection-code` header
 * (`proxyClient.ts:51`) and saved it as a `.../properties/connection-code`
 * property on the plugin's App resource, i.e. into a commit that syncs and
 * can later be shared with the drive. This test fails if either half of that
 * pattern appears in shipped source under `integrations/`.
 *
 * Scope and limits, stated exactly: this is a line-by-line text scan of
 * `.ts`/`.tsx`/`.js`/`.mjs` files, not a data-flow analysis. It catches a
 * property URL naming a connection code and any mention of the rotation
 * header outside `browser.ts`; it does not catch a code saved under an
 * unrelated property name after being obtained some other way. Tests
 * (`*.test.*`, `*.spec.*`), `e2e/` directories, `mock-*` servers,
 * `node_modules` and `dist` are skipped, since they legitimately emit or
 * inspect the header.
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

/** The only file allowed to handle the rotated code (posix path relative to `integrations/`). */
const CODE_OWNER = 'localthought/browser.ts';

const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'e2e',
  'playwright-report',
]);
const SOURCE = /\.(ts|tsx|js|mjs)$/;
const NOT_SHIPPED = /(\.test\.|\.spec\.|(^|\/)mock-[^/]*$)/;

/** A graph property whose name says it holds a connection code. */
const CODE_PROPERTY = /\/properties\/[^\s'"`]*connection[-_]?code/i;
/** The proxy's rotation header, whose value is the next live code. */
const ROTATION_HEADER = /x-connection-code/i;

export function findCredentialLeaks(file, source) {
  const leaks = [];
  source.split('\n').forEach((text, index) => {
    if (CODE_PROPERTY.test(text))
      leaks.push({
        file,
        line: index + 1,
        rule: 'connection-code property',
        text: text.trim(),
      });
    if (file !== CODE_OWNER && ROTATION_HEADER.test(text))
      leaks.push({
        file,
        line: index + 1,
        rule: 'rotation header outside browser.ts',
        text: text.trim(),
      });
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

test('flags the Phase 2 Clockify App.tsx/proxyClient.ts pattern', () => {
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
      [1, 'connection-code property'],
      [2, 'rotation header outside browser.ts'],
    ],
  );
});

test('flags the underscore spelling of the property', () => {
  assert.equal(
    findCredentialLeaks(
      'x/app.ts',
      "set('https://example.com/properties/proxy_connection_code', c)",
    ).length,
    1,
  );
});

test('lets browser.ts read the rotation header', () => {
  assert.deepEqual(
    findCredentialLeaks(
      CODE_OWNER,
      "const next = response.headers.get('x-connection-code');",
    ),
    [],
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

test('the walk reaches the code owner, so it is not silently empty', () => {
  assert.ok(shippedSources(integrationsRoot).includes(CODE_OWNER));
});

test('no shipped source persists or handles a rotating connection code outside browser.ts', () => {
  const leaks = shippedSources(integrationsRoot).flatMap(file =>
    findCredentialLeaks(
      file,
      readFileSync(join(integrationsRoot, file), 'utf8'),
    ),
  );

  assert.deepEqual(leaks, []);
});
