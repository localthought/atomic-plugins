import type { OpenApiDocument } from 'syncables';

/** OAuth token set persisted for a connected account. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which `accessToken` expires. */
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

/** The connected account's identity, as read from the userinfo endpoint. */
export interface AccountInfo {
  email?: string;
  sub?: string;
}

/** OAuth *client* credentials — the deployment-specific half of the flow. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Everything needed to run the OAuth flow and talk to the API, derived
 * entirely from the OpenAPI document (its `servers` and OAuth security
 * scheme). No provider is baked in — point Reflector at a different document with
 * a different `oauth` scheme and the flow follows it.
 */
export interface AuthProfile {
  /** Root of the real API, from `servers[0].url` (e.g. the Calendar v3 base). */
  apiBase: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** Endpoint used to refresh an access token; defaults to `tokenUrl`. */
  refreshUrl: string;
  /** Scopes requested, i.e. the keys of the flow's `scopes` map. */
  scopes: string[];
  /** Extra query parameters added to the authorization request (`x-authorization-params`). */
  authorizationParams: Record<string, string>;
  /** Optional OpenID Connect userinfo endpoint (`x-userinfo-url`). */
  userInfoUrl?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstServerUrl(document: OpenApiDocument): string {
  const servers = document['servers'];
  if (Array.isArray(servers) && isRecord(servers[0])) {
    const url = servers[0]['url'];
    if (typeof url === 'string' && url) {
      return url.replace(/\/+$/, '');
    }
  }
  throw new Error(
    'OpenAPI document declares no server URL; cannot derive the API base.',
  );
}

/**
 * The API base (`servers[0].url`) of a document, independent of the auth
 * scheme — used by token-based auth (e.g. a GitHub PAT) where there is no
 * OAuth flow to derive a full {@link AuthProfile} from.
 */
export function deriveApiBase(document: OpenApiDocument): string {
  return firstServerUrl(document);
}

/**
 * Picks the OAuth `authorizationCode` security scheme out of the document and
 * turns it, plus the server URL, into an {@link AuthProfile}. This is the one
 * place the flow's shape is read from the document; the rest of the app just
 * consumes the profile.
 */
export function deriveAuthProfile(document: OpenApiDocument): AuthProfile {
  const schemes = document.components?.['securitySchemes'];
  if (!isRecord(schemes)) {
    throw new Error('OpenAPI document declares no securitySchemes.');
  }
  for (const scheme of Object.values(schemes)) {
    if (!isRecord(scheme) || scheme['type'] !== 'oauth2') {
      continue;
    }
    const flows = scheme['flows'];
    const flow = isRecord(flows) ? flows['authorizationCode'] : undefined;
    if (!isRecord(flow)) {
      continue;
    }
    const authorizationUrl = flow['authorizationUrl'];
    const tokenUrl = flow['tokenUrl'];
    if (typeof authorizationUrl !== 'string' || typeof tokenUrl !== 'string') {
      continue;
    }
    const refreshUrl =
      typeof flow['refreshUrl'] === 'string' ? flow['refreshUrl'] : tokenUrl;
    const scopes = isRecord(flow['scopes']) ? Object.keys(flow['scopes']) : [];
    const authorizationParams: Record<string, string> = {};
    const extraParams = scheme['x-authorization-params'];
    if (isRecord(extraParams)) {
      for (const [key, value] of Object.entries(extraParams)) {
        authorizationParams[key] = String(value);
      }
    }
    const userInfoUrl =
      typeof scheme['x-userinfo-url'] === 'string'
        ? scheme['x-userinfo-url']
        : undefined;
    return {
      apiBase: firstServerUrl(document),
      authorizationUrl,
      tokenUrl,
      refreshUrl,
      scopes,
      authorizationParams,
      ...(userInfoUrl ? { userInfoUrl } : {}),
    };
  }
  throw new Error(
    'OpenAPI document declares no oauth2 security scheme with an authorizationCode flow.',
  );
}

/** Builds the consent-screen URL the user is redirected to when connecting. */
export function buildAuthUrl(
  profile: AuthProfile,
  client: OAuthClient,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: profile.scopes.join(' '),
    state,
    ...profile.authorizationParams,
  });
  return `${profile.authorizationUrl}?${params.toString()}`;
}

function toTokens(body: TokenResponse, previous?: OAuthTokens): OAuthTokens {
  // A refresh only returns a new refresh_token occasionally; keep the old one.
  const refreshToken = body.refresh_token ?? previous?.refreshToken;
  const scope = body.scope ?? previous?.scope;
  const tokenType = body.token_type ?? previous?.tokenType;
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    ...(refreshToken ? { refreshToken } : {}),
    ...(scope ? { scope } : {}),
    ...(tokenType ? { tokenType } : {}),
  };
}

/** Exchanges the OAuth `code` from the callback for an access/refresh token set. */
export async function exchangeCode(
  profile: AuthProfile,
  client: OAuthClient,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const response = await fetchImpl(profile.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: 'authorization_code',
      code,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed with status ${response.status}: ${await response.text()}`,
    );
  }
  return toTokens((await response.json()) as TokenResponse);
}

/** Refreshes an expired access token using the stored refresh token. */
export async function refreshTokens(
  profile: AuthProfile,
  client: OAuthClient,
  tokens: OAuthTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new Error('Cannot refresh access token: no refresh token stored.');
  }
  const response = await fetchImpl(profile.refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `OAuth token refresh failed with status ${response.status}: ${await response.text()}`,
    );
  }
  return toTokens((await response.json()) as TokenResponse, tokens);
}

/** Fetches the connected account's email/subject for display, if the profile exposes a userinfo URL. */
export async function fetchAccount(
  profile: AuthProfile,
  tokens: OAuthTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountInfo> {
  if (!profile.userInfoUrl) {
    return {};
  }
  const response = await fetchImpl(profile.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!response.ok) {
    return {};
  }
  const body = (await response.json()) as { email?: string; sub?: string };
  return {
    ...(body.email ? { email: body.email } : {}),
    ...(body.sub ? { sub: body.sub } : {}),
  };
}
