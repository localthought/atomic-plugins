// @wc-ignore-file
/**
 * Read-only access to the two Moneybird operations the Money app uses:
 * `GET /administrations.json` and `GET /{administration_id}/contacts.json`.
 * Nothing here writes to Moneybird, and nothing here holds a credential: a
 * `MoneybirdGet` is the host's proxy relay (see transport in sync.ts).
 *
 * Pagination follows the provider's `Link: <…>; rel="next"` header, as
 * Moneybird documents for paginated collections, and only to URLs under
 * this administration's contacts collection. That behaviour is verified
 * against the synthetic fixture (fixtures/moneybird/), not a recording.
 */

export const UPSTREAM = 'https://moneybird.com/api/v2';
/** Moneybird's maximum `per_page`. */
export const PAGE_SIZE = 100;
/** 200 pages of 100: past this, a Link loop is more likely than a real administration. */
export const MAX_PAGES = 200;

export interface MoneybirdResponse {
  status: number;
  /** Lower-cased names. */
  headers?: Record<string, string>;
  body: unknown;
}

/** One GET of a provider path under UPSTREAM, e.g. `/administrations.json`. */
export type MoneybirdGet = (path: string) => Promise<MoneybirdResponse>;

export interface Administration {
  id: string;
  name: string;
  currency?: string;
}

export type Contact = Record<string, unknown> & { id: string };

export class MoneybirdError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const IDENTIFIER = /^\d{1,20}$/;

/** Moneybird identifiers are digit strings; the API also sends them as numbers. */
function identifier(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;

  return typeof text === 'string' && IDENTIFIER.test(text) ? text : undefined;
}

function ok(response: MoneybirdResponse, what: string): unknown[] {
  if (response.status === 401 || response.status === 403)
    throw new MoneybirdError(
      `Moneybird refused ${what} (${response.status}); reconnect Moneybird.`,
      response.status,
    );
  if (response.status !== 200)
    throw new MoneybirdError(
      `Moneybird answered ${response.status} for ${what}.`,
      response.status,
    );
  if (!Array.isArray(response.body))
    throw new MoneybirdError(`Moneybird sent no list for ${what}.`);

  return response.body;
}

export async function readAdministrations(
  get: MoneybirdGet,
): Promise<Administration[]> {
  const body = ok(await get('/administrations.json'), 'administrations');

  return body.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const id = identifier(record.id);
    if (!id) return [];

    return [
      {
        id,
        name: typeof record.name === 'string' && record.name ? record.name : id,
        ...(typeof record.currency === 'string'
          ? { currency: record.currency }
          : {}),
      },
    ];
  });
}

/** The URL of `rel="next"` in a Link header, if any. */
export function nextLink(header: string | undefined): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(',')) {
    const match = part.match(/^\s*<([^>]*)>\s*;(.*)$/);
    if (match && /(^|;)\s*rel="?next"?\s*(;|$)/i.test(match[2]))
      return match[1];
  }

  return undefined;
}

/**
 * Every contact of one administration, archived ones included (as
 * overlays/moneybird.com/api/v2/all-records-selection.json asks). Reads all
 * pages before returning, so a failure part-way returns nothing and the
 * caller writes nothing. A contact seen twice (it moved between pages while
 * reading) is kept once, with its last-read value.
 */
export async function readContacts(
  get: MoneybirdGet,
  administrationId: string,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {},
): Promise<Contact[]> {
  if (!identifier(administrationId))
    throw new MoneybirdError('Choose a Moneybird administration first.');
  const collection = `/${administrationId}/contacts.json`;
  const byId = new Map<string, Contact>();
  let path: string | undefined =
    `${collection}?per_page=${pageSize}&include_archived=true`;

  for (let page = 1; path; page++) {
    if (page > maxPages)
      throw new MoneybirdError(
        `Stopped after ${maxPages} pages of contacts; the provider kept sending a next page.`,
      );
    const response = await get(path);
    const body = ok(response, `contacts page ${page}`);

    for (const raw of body) {
      if (!raw || typeof raw !== 'object') continue;
      const id = identifier((raw as Record<string, unknown>).id);
      if (id) byId.set(id, { ...(raw as Record<string, unknown>), id });
    }

    const next = nextLink(response.headers?.link);
    path = next === undefined ? undefined : within(next, collection);
  }

  return [...byId.values()];
}

/** The provider path of `href`, refused unless it is this collection. */
function within(href: string, collection: string): string {
  let url: URL;

  try {
    url = new URL(href, `${UPSTREAM}/`);
  } catch {
    throw new MoneybirdError('Moneybird sent an unreadable next-page link.');
  }

  const base = new URL(UPSTREAM);
  if (
    url.origin !== base.origin ||
    url.pathname !== `${base.pathname}${collection}`
  )
    throw new MoneybirdError(
      `Refusing a next-page link outside ${collection}: ${url.href}`,
    );

  return `${collection}${url.search}`;
}
