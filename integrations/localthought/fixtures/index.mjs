/**
 * Fixture registry for mock-proxy.mjs. This file is the only shared part:
 * each platform's fixture lives in its own plugin's folder, at
 * integrations/<plugin>/fixtures/<platform>/scenario.mjs, so a plugin's mock
 * changes with the plugin and triggers only its lane. The proxy
 * owns the protocol (PKCE, /connect, redemption, code rotation); a fixture
 * owns only its platform's catalog document and API behaviour:
 *
 *   title         display name on the /connect consent page
 *   document      catalog document served as JSON at /catalog/<id>.yaml
 *   documentFile  or: a file served verbatim as application/yaml there
 *   jsonBody      true to read and JSON-parse request bodies (max 1 MiB)
 *   create()      returns { request(method, url, body) -> { status, body, headers? } }
 *
 * See integrations/PARALLEL_LANES.md §4 for what is still missing (recorded
 * api/ bodies, record.mjs, fixture.test.mjs, the drift guard).
 */
import googleCalendar from '../../calendar/fixtures/google-calendar/scenario.mjs';
import githubIssues from '../../issue-tracker/fixtures/github-issues/scenario.mjs';
// Synthetic, not recorded: see money/fixtures/moneybird/synthetic.mjs.
import moneybird from '../../money/fixtures/moneybird/scenario.mjs';
import notion from '../../notion/fixtures/notion/scenario.mjs';
import pets from '../../pets/fixtures/pets/scenario.mjs';
import clockify from '../../timesheets/fixtures/clockify/scenario.mjs';

export const fixtures = {
  clockify,
  'github-issues': githubIssues,
  'google-calendar': googleCalendar,
  moneybird,
  notion,
  pets,
};

/**
 * Parse a MOCK_PROXY_PLATFORMS value. Empty or unset means every fixture, so
 * callers that predate the variable (atomic-server's e2e-server.sh, dagger)
 * keep the full set. Requested platforms without a fixture are returned in
 * `missing` rather than thrown: a lane may name a platform (todoist)
 * whose fixture has not been recorded yet.
 */
export function selectPlatforms(value) {
  const requested = [
    ...new Set(
      (value ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!requested.length)
    return { platforms: Object.keys(fixtures), missing: [] };

  return {
    platforms: requested.filter(p => Object.hasOwn(fixtures, p)).sort(),
    missing: requested.filter(p => !Object.hasOwn(fixtures, p)),
  };
}
