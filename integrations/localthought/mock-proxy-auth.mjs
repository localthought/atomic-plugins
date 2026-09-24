/**
 * The integration proxy's 0.2 authentication (ontola/atomic-plugins#54), for
 * the local-only mock (`mock-proxy.mjs`) and its tests. Never deploy this.
 *
 * It re-implements, in plain Node, exactly what `integration-proxy/src/`
 * checks on the surface a client sees:
 *
 * - agent ids (`agent_id.rs`): `atomic:agent:<key>` or `did:ad:agent:<key>`,
 *   the key base64 in either alphabet, padded or not, 32 bytes (Ed25519);
 *   canonical form `atomic:agent:<base64url, no padding>`;
 * - version 2 request signatures (`signature.rs`): five `\n`-joined lines
 *   `atomic-request-v2`, METHOD, full URL, timestamp (Unix ms), lowercase
 *   hex SHA-256 of the body; ±5 min skew; the version header must be `2`;
 * - frame capabilities (`capability.rs`): `Capability <payload>.<sig>`,
 *   payload base64url of the JSON claims, `sig` by the connection owner over
 *   `integration-proxy-capability-v2\n` + those JSON bytes, exact claim set,
 *   `exp` in Unix seconds at most 15 min ahead;
 * - error codes and messages (`api_error.rs`).
 *
 * The shared golden vectors (`integration-proxy/tests/fixtures/
 * atomic-request-v2-vectors.json`, a copy of atomic-server's
 * `lib/src/authentication_v2_vectors.json`) are checked against this file in
 * `mock-proxy.test.mjs`, so the mock and both real implementations agree.
 *
 * `testSigner` and `mintCapability` are the client side, for tests only; in
 * the e2e the data browser page and the plugin frame sign for real.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';

export const AGENT_HEADER = 'x-atomic-agent';
export const PUBLIC_KEY_HEADER = 'x-atomic-public-key';
export const TIMESTAMP_HEADER = 'x-atomic-timestamp';
export const SIGNATURE_HEADER = 'x-atomic-signature';
export const VERSION_HEADER = 'x-atomic-signature-version';
export const REQUEST_DOMAIN = 'atomic-request-v2';
export const CAPABILITY_DOMAIN = 'integration-proxy-capability-v2';
/** `signature::MAX_SKEW_MS`. */
export const MAX_SKEW_MS = 5 * 60 * 1000;
/** `capability::MAX_LIFETIME_SECS`. */
export const MAX_CAPABILITY_SECS = 15 * 60;

/** `api_error.rs`: code -> [status, message]. */
export const ERRORS = {
  missing_signature: [
    401,
    'this endpoint requires an Atomic v2 request signature (x-atomic-agent, x-atomic-public-key, x-atomic-timestamp, x-atomic-signature)',
  ],
  unsupported_signature_version: [401, 'x-atomic-signature-version must be 2'],
  invalid_agent: [
    401,
    'x-atomic-agent or x-atomic-public-key is not a valid atomic:agent id',
  ],
  agent_key_mismatch: [
    401,
    'x-atomic-agent is not the agent of x-atomic-public-key',
  ],
  stale_timestamp: [
    401,
    "x-atomic-timestamp is missing, malformed, or more than 5 minutes from the proxy's clock",
  ],
  bad_signature: [
    401,
    'x-atomic-signature does not verify over the atomic-request-v2 message',
  ],
  replayed: [401, 'this signed request was already used'],
  invalid_capability: [
    401,
    "the capability is malformed or not signed by the connection's owner",
  ],
  capability_expired: [401, 'the capability has expired; request a new one'],
  capability_too_long: [
    401,
    'the capability is valid for more than 15 minutes',
  ],
  wrong_audience: [401, 'the capability is for a different proxy'],
  capability_key_mismatch: [
    401,
    "the request is not signed by the capability's cnf key",
  ],
  unsupported_authorization: [
    401,
    'the only Authorization scheme accepted is Capability; connection codes (Bearer) were retired',
  ],
  not_owner: [403, "only the connection's owner may do this"],
  not_delegated: [
    403,
    'the signing agent has no delegation for this connection',
  ],
  capability_scope: [
    403,
    'the capability is for a different connection or platform',
  ],
  platform_mismatch: [403, 'the connection is for a different platform'],
  unknown_connection: [
    404,
    'no such connection; it was deleted, expired after 90 idle days, or never existed',
  ],
  invalid_handoff: [400, 'invalid or expired connection code'],
};

/** A refusal with one of the codes above; `message` overrides for `bad_request`. */
export class ProxyRefusal extends Error {
  constructor(code, message) {
    const [status, text] = ERRORS[code] ?? [400, message ?? code];
    super(message ?? text);
    this.code = code;
    this.status = status;
  }
}

const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Base64 in either alphabet, padded or not; `undefined` when malformed. */
export function decodeB64(value) {
  if (typeof value !== 'string' || !B64.test(value)) return undefined;
  const bytes = Buffer.from(
    value.replaceAll('-', '+').replaceAll('_', '/'),
    'base64',
  );
  // Node skips what it cannot decode; a round trip catches a bad length.
  const again = bytes.toString('base64').replace(/=+$/, '');
  if (
    again !== value.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '')
  )
    return undefined;

  return bytes;
}

export const b64url = bytes => Buffer.from(bytes).toString('base64url');

/** `agent_id::parse`: the canonical `atomic:agent:` id, or `undefined`. */
export function parseAgent(id) {
  if (typeof id !== 'string') return undefined;
  const match = /^(?:atomic:agent:|did:ad:agent:)(.+)$/.exec(id);
  if (!match) return undefined;

  return agentFromPublicKey(match[1]);
}

/** `agent_id::from_public_key`. */
export function agentFromPublicKey(key) {
  const bytes = decodeB64(key);
  if (!bytes || bytes.length !== 32) return undefined;

  return `atomic:agent:${b64url(bytes)}`;
}

const publicKeyOf = canonical =>
  createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: canonical.slice('atomic:agent:'.length),
    },
    format: 'jwk',
  });

/** Ed25519 over `message` (bytes) by the canonical agent `agent`. */
export function verifyBy(agent, message, signature) {
  const sig = decodeB64(signature);
  if (!sig || sig.length !== 64) return false;

  try {
    return edVerify(null, Buffer.from(message), publicKeyOf(agent), sig);
  } catch {
    return false;
  }
}

export const sha256Hex = bytes =>
  createHash('sha256').update(bytes).digest('hex');

/** `signature::message`. */
export function requestMessage(method, url, timestamp, body = '') {
  return [
    REQUEST_DOMAIN,
    method.toUpperCase(),
    url,
    String(timestamp),
    sha256Hex(Buffer.from(body)),
  ].join('\n');
}

/**
 * `signature::verify`: returns `{ agent, replayKey }` or throws a
 * `ProxyRefusal`. The caller spends `replayKey` (single use).
 */
export function verifyRequest(headers, method, url, body, nowMs = Date.now()) {
  const header = name => {
    const value = headers[name];

    return Array.isArray(value) ? value[0] : value;
  };

  const agentHeader = header(AGENT_HEADER);
  const key = header(PUBLIC_KEY_HEADER);
  const timestamp = header(TIMESTAMP_HEADER);
  const signature = header(SIGNATURE_HEADER);
  if (!agentHeader || !key || !timestamp || !signature)
    throw new ProxyRefusal('missing_signature');
  if (header(VERSION_HEADER) !== '2')
    throw new ProxyRefusal('unsupported_signature_version');
  const agent = parseAgent(agentHeader);
  const keyAgent = agentFromPublicKey(key);
  if (!agent || !keyAgent) throw new ProxyRefusal('invalid_agent');
  if (agent !== keyAgent) throw new ProxyRefusal('agent_key_mismatch');
  if (!/^\d{1,16}$/.test(timestamp)) throw new ProxyRefusal('stale_timestamp');
  if (Math.abs(Number(timestamp) - nowMs) > MAX_SKEW_MS)
    throw new ProxyRefusal('stale_timestamp');
  const message = requestMessage(method, url, timestamp, body);
  if (!verifyBy(agent, message, signature))
    throw new ProxyRefusal('bad_signature');

  return {
    agent,
    replayKey: `${REQUEST_DOMAIN}:${sha256Hex(Buffer.from(message))}`,
  };
}

const CLAIMS = ['v', 'connection_id', 'platform', 'aud', 'app', 'cnf', 'exp'];

/** `capability::parse`: structure and agent ids, not yet the signature. */
export function parseCapability(token) {
  if (typeof token !== 'string' || token.length > 4096)
    throw new ProxyRefusal('invalid_capability');
  const dot = token.indexOf('.');
  if (dot === -1) throw new ProxyRefusal('invalid_capability');
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload))
    throw new ProxyRefusal('invalid_capability');
  const json = Buffer.from(payload, 'base64url');
  let claims;

  try {
    claims = JSON.parse(json.toString('utf8'));
  } catch {
    throw new ProxyRefusal('invalid_capability');
  }

  const keys = claims && typeof claims === 'object' ? Object.keys(claims) : [];
  if (
    keys.length !== CLAIMS.length ||
    !CLAIMS.every(k => keys.includes(k)) ||
    claims.v !== 2 ||
    typeof claims.connection_id !== 'string' ||
    typeof claims.platform !== 'string' ||
    typeof claims.aud !== 'string' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp < 0
  )
    throw new ProxyRefusal('invalid_capability');
  const app = parseAgent(claims.app);
  const cnf = parseAgent(claims.cnf);
  if (!app || !cnf) throw new ProxyRefusal('invalid_capability');

  return { claims, app, cnf, json, signature };
}

/** `Parsed::verify`: owner signature, audience, lifetime, in that order. */
export function verifyCapability(parsed, owner, audience, nowSecs) {
  const message = Buffer.concat([
    Buffer.from(`${CAPABILITY_DOMAIN}\n`),
    parsed.json,
  ]);
  if (!verifyBy(owner, message, parsed.signature))
    throw new ProxyRefusal('invalid_capability');
  if (parsed.claims.aud !== audience) throw new ProxyRefusal('wrong_audience');
  if (parsed.claims.exp <= nowSecs)
    throw new ProxyRefusal('capability_expired');
  if (parsed.claims.exp - nowSecs > MAX_CAPABILITY_SECS)
    throw new ProxyRefusal('capability_too_long');
}

// ---- The client side, for tests ----

/** PKCS#8 DER prefix of a raw 32-byte Ed25519 seed. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An agent that signs like @tomic/lib does, from a 32-byte seed. */
export function testSigner(seed) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  const agent = `atomic:agent:${publicKey}`;
  const sign = bytes => b64url(edSign(null, Buffer.from(bytes), privateKey));

  return {
    agent,
    publicKey,
    sign,
    /** v2 headers for one request; `timestamp` defaults to now. */
    headers(method, url, body = '', timestamp = Date.now()) {
      return {
        [AGENT_HEADER]: agent,
        [PUBLIC_KEY_HEADER]: publicKey,
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: sign(requestMessage(method, url, timestamp, body)),
        [VERSION_HEADER]: '2',
      };
    },
  };
}

/** What the page does: `payload.sig`, signed by `owner` (a `testSigner`). */
export function mintCapability(owner, claims) {
  const json = Buffer.from(JSON.stringify({ v: 2, ...claims }));

  return `${b64url(json)}.${owner.sign(Buffer.concat([Buffer.from(`${CAPABILITY_DOMAIN}\n`), json]))}`;
}
