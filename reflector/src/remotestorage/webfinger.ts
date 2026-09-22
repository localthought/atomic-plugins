/**
 * WebFinger discovery for remoteStorage accounts
 * (https://datatracker.ietf.org/doc/html/draft-dejong-remotestorage#section-10).
 *
 * Given a user address `user@host`, this looks up the host's WebFinger
 * document and pulls out the remoteStorage link: the storage root the client
 * reads and writes documents under, plus the OAuth authorization endpoint the
 * user is redirected to when granting access.
 */

/** The remoteStorage endpoints discovered for an account. */
export interface RemoteStorageInfo {
  /** The account's user address, e.g. `me@storage.example`. */
  userAddress: string;
  /** Storage root URL; documents live at `<href>/<module>/…`. Never ends in `/`. */
  href: string;
  /** OAuth authorization endpoint (RFC 6749 §4.2 implicit grant). */
  authUrl: string;
  /** Remaining declared storage properties (API version, content-negotiation flags, …). */
  properties: Record<string, unknown>;
}

interface WebFingerLink {
  rel?: string;
  href?: string;
  properties?: Record<string, unknown>;
}

interface WebFingerDocument {
  links?: WebFingerLink[];
}

/** The property key carrying the OAuth authorize endpoint on a remoteStorage link. */
const OAUTH_PROPERTY = 'http://tools.ietf.org/html/rfc6749#section-4.2';

/** Splits `user@host` into its parts, rejecting anything that is not an address. */
export function parseUserAddress(userAddress: string): {
  user: string;
  host: string;
} {
  const trimmed = userAddress.trim().replace(/^acct:/, '');
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    throw new Error(
      `Invalid remoteStorage user address: "${userAddress}" (expected user@host).`,
    );
  }
  return { user: trimmed.slice(0, at), host: trimmed.slice(at + 1) };
}

/** True for the several rels remoteStorage has used across protocol drafts. */
function isRemoteStorageLink(link: WebFingerLink): boolean {
  const rel = link.rel ?? '';
  return rel === 'remotestorage' || rel.includes('remotestorage');
}

/**
 * Discovers the remoteStorage endpoints for `userAddress` via WebFinger.
 * Throws if the host has no WebFinger document or it declares no remoteStorage
 * link with an OAuth endpoint.
 */
export async function discover(
  userAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteStorageInfo> {
  const { host } = parseUserAddress(userAddress);
  const resource = `acct:${userAddress.trim().replace(/^acct:/, '')}`;
  const url = `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

  const response = await fetchImpl(url, {
    headers: { Accept: 'application/jrd+json, application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `WebFinger lookup for ${userAddress} failed with status ${response.status}.`,
    );
  }
  const document = (await response.json()) as WebFingerDocument;
  const link = (document.links ?? []).find(isRemoteStorageLink);
  if (!link?.href) {
    throw new Error(`No remoteStorage endpoint advertised for ${userAddress}.`);
  }
  const properties = link.properties ?? {};
  const authUrl = properties[OAUTH_PROPERTY];
  if (typeof authUrl !== 'string' || !authUrl) {
    throw new Error(
      `remoteStorage account ${userAddress} does not advertise an OAuth endpoint.`,
    );
  }
  return {
    userAddress: userAddress.trim().replace(/^acct:/, ''),
    href: link.href.replace(/\/+$/, ''),
    authUrl,
    properties,
  };
}
