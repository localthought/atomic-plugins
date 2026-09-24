/** QuickJS module; the host owns HTTPS, drive-host routing and exclusive claims. */
export const manifest = {
  schemaVersion: 3,
  name: 'atproto',
  namespace: 'atomic-plugins',
  capabilities: [
    {
      name: 'storage',
      reason:
        'Reads the installation configuration; creates no records or blobs.',
    },
  ],
  http: {
    mount: 'drive-host',
    reason:
      'Publish the configured public AT Protocol DID on the approved drive hostname.',
    routes: [
      {
        id: 'atproto-did',
        path: '/atproto-did',
        methods: ['GET', 'HEAD'],
        principal: 'anonymous',
        auth: 'none',
        cors: 'any-origin-no-credentials',
      },
    ],
    wellKnown: [
      { name: 'atproto-did', kind: 'exclusive', route: 'atproto-did' },
    ],
  },
};
const RESERVED = new Set([
  'alt',
  'arpa',
  'example',
  'internal',
  'invalid',
  'local',
  'localhost',
  'onion',
  'test',
]);

/** Production handle rules: ASCII DNS labels, 253 bytes maximum, no reserved TLD. */
export function normalizeHandle(handleName) {
  if (
    typeof handleName !== 'string' ||
    handleName.length > 253 ||
    !/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
      handleName,
    )
  ) {
    throw new Error('Invalid AT Protocol handle');
  }

  const value = handleName.toLowerCase();
  if (RESERVED.has(value.split('.').pop()))
    throw new Error('Reserved handle suffix');

  return value;
}
/** Only the two AT Protocol supported DID methods, with production syntax. */
export function validateDid(did) {
  if (typeof did !== 'string' || did.length > 2048)
    throw new Error('Invalid DID');
  if (/^did:plc:[a-z2-7]{24}$/.test(did)) return did;

  if (did.startsWith('did:web:')) {
    const domain = did.slice(8);
    if (normalizeHandle(domain) === domain) return did;
  }

  throw new Error('Unsupported or malformed AT Protocol DID');
}
export function configuration(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Missing configuration');

  return {
    handle: normalizeHandle(config.handle),
    did: validateDid(config.did),
  };
}

function response(status, body = '') {
  return {
    status,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
    body,
  };
}

export function handle(ctx, request) {
  // Validate the trusted dispatch fields, not untrusted Host/Origin/forwarded headers.
  if (ctx.trigger?.route !== 'atproto-did') return response(404);
  const wellKnown = request.wellKnown;
  if (wellKnown !== null && wellKnown !== undefined) {
    if (
      wellKnown !== 'atproto-did' ||
      request.path !== '/.well-known/atproto-did'
    )
      return response(404);
  } else if (request.path !== '/atproto-did') return response(404);
  // The manifest restricts methods before execution; this is defense in depth.
  if (!['GET', 'HEAD'].includes(request.method)) return response(405);
  let config;

  try {
    config = configuration(ctx.config);
  } catch {
    return response(
      503,
      request.method === 'HEAD' ? '' : 'AT Protocol identity is not configured',
    );
  }

  return response(200, request.method === 'HEAD' ? '' : config.did);
}
export function run(ctx) {
  configuration(ctx.config);

  return { intents: [], problems: [] };
}
