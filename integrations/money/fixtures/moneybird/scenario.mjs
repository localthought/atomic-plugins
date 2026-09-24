/**
 * Moneybird mock-proxy fixture. SYNTHETIC, not recorded: it replays the
 * hand-written bodies in synthetic.mjs (read that header for what they are
 * and are not). Registered as `moneybird` in
 * integrations/localthought/fixtures/index.mjs.
 *
 * Served, read-only like the real proxy's Moneybird catalog entry:
 *   GET /proxy/moneybird/administrations.json
 *   GET /proxy/moneybird/<administration_id>/contacts.json
 *       [?page=<n>][&per_page=<k>][&include_archived=true]
 * Any other method is 403; any other path, or an unknown administration, 404.
 *
 * Two behaviours are the fixture's own, for tests, and are NOT claims about
 * Moneybird:
 * - Pages hold at most PAGE_CAP (2) contacts whatever `per_page` asks (the
 *   real API honours per_page up to 100), so every read crosses a page
 *   boundary. The next page is announced with a `Link: <…>; rel="next"`
 *   header, as Moneybird documents for paginated collections.
 * - Every second read of an administration's contacts (counted by page-1
 *   requests) fails on page 2 with 503. That gives a host test a refresh that
 *   fails after a good one, without a control endpoint. `outage: false` on
 *   create() turns it off.
 *
 * Archived contacts are left out unless `include_archived=true`, which is
 * what overlays/moneybird.com/api/v2/all-records-selection.json asks for.
 *
 * Recording: replacing synthetic.mjs with a redacted recording needs a
 * Moneybird test administration and an API token (MONEYBIRD_TOKEN,
 * MONEYBIRD_ADMINISTRATION_ID), following the todoist recorder's layout
 * (integrations/issue-tracker/fixtures/todoist/record.mjs: api/ pages of
 * { status, headers, body } and an exported REDACTIONS list). Not done:
 * nobody here has an account (atomic-plugins#102).
 */
import { administrations, contacts } from './synthetic.mjs';

export const PAGE_CAP = 2;
const UPSTREAM = 'https://moneybird.com/api/v2';

export function moneybirdFixture({ outage = true } = {}) {
  const reads = new Map();

  return {
    reads,
    request(method, url) {
      const path = url.pathname.replace(/^\/proxy\/moneybird/, '');
      if (method !== 'GET') return { status: 403, body: {} };
      if (path === '/administrations.json')
        return { status: 200, body: structuredClone(administrations) };

      const match = path.match(/^\/(\d+)\/contacts\.json$/);
      if (!match || !contacts[match[1]])
        return { status: 404, body: { error: 'record not found' } };
      const administration = match[1];
      const page = Number(url.searchParams.get('page') ?? '1');
      const asked = Number(url.searchParams.get('per_page') ?? '50');
      if (!Number.isInteger(page) || page < 1 || !(asked >= 1 && asked <= 100))
        return { status: 400, body: { error: 'Invalid pagination' } };

      if (page === 1)
        reads.set(administration, (reads.get(administration) ?? 0) + 1);
      if (outage && page === 2 && reads.get(administration) % 2 === 0)
        return { status: 503, body: { error: 'Synthetic outage' } };

      const archived = url.searchParams.get('include_archived') === 'true';
      const rows = contacts[administration].filter(
        c => archived || !c.archived,
      );
      const size = Math.min(asked, PAGE_CAP);
      const body = rows.slice((page - 1) * size, page * size);
      const next = new URL(`${UPSTREAM}/${administration}/contacts.json`);
      for (const [key, value] of url.searchParams)
        next.searchParams.set(key, value);
      next.searchParams.set('page', String(page + 1));

      return {
        status: 200,
        body: structuredClone(body),
        headers:
          page * size < rows.length
            ? { Link: `<${next.href}>; rel="next"` }
            : {},
      };
    },
  };
}

export default {
  title: 'Moneybird',
  // A subset of the pinned read-only OpenAPI document: the two operations the
  // Money app reads. The app bundles its own paths; nothing reads this beyond
  // the /catalog listing.
  document: {
    openapi: '3.0.3',
    info: { title: 'Moneybird (synthetic subset)', version: 'v2' },
    servers: [{ url: UPSTREAM }],
    paths: {
      '/administrations.json': { get: { operationId: 'listAdministrations' } },
      '/{administration_id}/contacts.json': {
        get: { operationId: 'listContacts' },
      },
    },
  },
  create: () => moneybirdFixture(),
};
