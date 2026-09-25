/**
 * The `http` block of a version-three plugin manifest, for this repo's
 * tooling: which plugin-routes gate a package needs, the `requires` list
 * derived from its manifest (what `catalog.json` entries and certification
 * reports carry), and the refusal a node gives when its gates don't allow it.
 *
 * A port of atomic-server's `browser/lib/src/plugin-manifest-http.ts`
 * (ontola/atomic-server#1732), which mirrors
 * `server/src/plugins/manifest_http.rs`. Ported rather than imported because
 * the tooling runs as plain node against whatever atomic-server commit is
 * pinned, and pins older than #1732 have no such module. It is checked
 * against the same shared fixtures as both host implementations, copied into
 * `fixtures/plugin-manifest/` (see `source.json` there for the commit). If the
 * host's rules change, re-copy the fixtures and update this file until
 * `manifest-http.test.mjs` passes again.
 *
 * Only the `http` block and the fields `derivedRequires` reads are handled
 * here: the rest of a manifest is validated by the host when the release is
 * published, not by this repo.
 *
 * Design: docs/design/server-plugin-routes.md, sections 0.1, 0.4, 0.5 and 2.2.
 */

export const LEVELS = ['off', 'read-only', 'read-write'];
export const MAX_ROUTES = 32;
export const MAX_INLINE_BODY_BYTES = 1_048_576;
export const MAX_TIMEOUT_MS = 30_000;
export const HOST_FEATURE_UNAVAILABLE = 'host-feature-unavailable';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SHARED_WELL_KNOWN = ['webfinger'];
const EXCLUSIVE_WELL_KNOWN = [
  'nodeinfo',
  'ocm',
  'atproto-did',
  'solid',
  'oauth-authorization-server',
  'oauth-protected-resource',
  'openid-configuration',
  'did.json',
];

/** 0 for `off` and for anything unknown, like the host. */
export const rank = level => Math.max(0, LEVELS.indexOf(level));

const object = (value, what) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${what}: invalid type, expected a map`);

  return value;
};

const known = (entry, keys) => {
  for (const key of Object.keys(entry))
    if (!keys.includes(key)) throw new Error(`unknown field \`${key}\``);
};

const list = (value, what) => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`${what}: invalid type, expected a sequence`);

  return value;
};

const text = (value, what) => {
  if (typeof value !== 'string')
    throw new Error(`${what}: invalid type, expected a string`);

  return value;
};

const optionalText = (value, what) =>
  value === undefined ? undefined : text(value, what);

const variant = (value, allowed, fallback) => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value))
    throw new Error(`unknown variant \`${String(value)}\``);

  return value;
};

const texts = (value, what) => list(value, what).map(v => text(v, what));

const validName = name =>
  name.length > 0 && name.length <= 64 && /^[a-z0-9-]+$/.test(name);

const uniqueNames = (names, what) => {
  const seen = new Set();

  for (const name of names) {
    if (!validName(name) || seen.has(name))
      throw new Error(
        `${what} must be names (lowercase letters, digits and -) and unique`,
      );
    seen.add(name);
  }

  return seen;
};

/** Segments: `{ literal }`, `'param'` or `'rest'`. */
function pattern(path) {
  const invalid = () =>
    new Error(
      `route path \`${path}\` must be \`/\`-separated literal segments, \`{param}\` and a trailing \`{*rest}\`, without regex`,
    );
  if (!path.startsWith('/') || path.length > 256) throw invalid();
  const tail = path.slice(1);
  if (tail === '') return [];
  const identifier = s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  const literal = s =>
    s !== '.' && s !== '..' && /^[A-Za-z0-9\-._~:@!,;=]+$/.test(s);
  const raw = tail.split('/');
  const params = new Set();

  return raw.map((segment, i) => {
    const restMatch = /^\{\*(.*)\}$/.exec(segment);
    const paramMatch = /^\{(.*)\}$/.exec(segment);

    if (restMatch) {
      const name = restMatch[1];
      if (i + 1 !== raw.length || !identifier(name) || params.has(name))
        throw invalid();
      params.add(name);

      return 'rest';
    }

    if (paramMatch) {
      const name = paramMatch[1];
      if (!identifier(name) || params.has(name)) throw invalid();
      params.add(name);

      return 'param';
    }

    if (!literal(segment)) throw invalid();

    return { literal: segment };
  });
}

/** Whether some request path matches both. `{*rest}` matches one or more segments. */
function overlaps(a, b) {
  if (a.length === 0 && b.length === 0) return true;
  if (a[0] === 'rest') return b.length > 0;
  if (b[0] === 'rest') return a.length > 0;
  if (a.length === 0 || b.length === 0) return false;
  if (
    typeof a[0] === 'object' &&
    typeof b[0] === 'object' &&
    a[0].literal !== b[0].literal
  )
    return false;

  return overlaps(a.slice(1), b.slice(1));
}

/** An operation whose destination comes from data: `https://*\/inbox`. */
export function isWildcardHost(url) {
  try {
    return new URL(url).hostname === '*';
  } catch {
    return false;
  }
}

const isUrl = (value, schemes, needsHost) => {
  try {
    const url = new URL(value);

    return schemes.includes(url.protocol) && (!needsHost || !!url.hostname);
  } catch {
    return false;
  }
};

const withReason = item => {
  const { reason, ...rest } = item;

  return reason === undefined ? rest : { ...rest, reason };
};

/**
 * Validates an `http` block and returns its canonical form: defaults left
 * out, and `undefined` when it holds nothing. `context` is
 * `{ serverExtension, operations: [{ id, effect, url }] }`.
 */
export function validateHttp(raw, context) {
  const entry = object(raw, 'http');
  known(entry, [
    'mount',
    'routes',
    'wellKnown',
    'writeTargets',
    'keys',
    'tokens',
    'listeners',
    'sidecars',
    'reason',
  ]);
  const mount = variant(
    entry.mount,
    ['installation-origin', 'drive-host', 'drive-prefix'],
    'installation-origin',
  );

  const routes = list(entry.routes, 'http.routes').map(value => {
    const route = object(value, 'route');
    known(route, [
      'id',
      'path',
      'methods',
      'principal',
      'auth',
      'accept',
      'cors',
      'maxBodyBytes',
      'body',
      'writes',
      'enqueues',
      'timeoutMs',
    ]);

    const number = key => {
      const v = route[key];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
        throw new Error(`${key}: invalid type, expected an unsigned integer`);

      return v;
    };

    return {
      id: text(route.id, 'route id'),
      path: text(route.path, 'route path'),
      methods: texts(route.methods, 'route methods'),
      principal: variant(
        route.principal,
        ['anonymous', 'installation', 'caller'],
        'anonymous',
      ),
      auth: variant(
        route.auth,
        ['none', 'atomic', 'http-signature', 'bearer', 'dpop'],
        'none',
      ),
      accept: texts(route.accept, 'route accept'),
      cors: variant(route.cors, ['none', 'any-origin-no-credentials'], 'none'),
      maxBodyBytes: number('maxBodyBytes'),
      body:
        route.body === undefined
          ? undefined
          : variant(route.body, ['json', 'text', 'blob']),
      writes: texts(route.writes, 'route writes'),
      enqueues: texts(route.enqueues, 'route enqueues'),
      timeoutMs: number('timeoutMs'),
    };
  });

  const wellKnown = list(entry.wellKnown, 'http.wellKnown').map(value => {
    const claim = object(value, 'well-known claim');
    known(claim, ['name', 'kind', 'match', 'route']);
    let match;

    if (claim.match !== undefined) {
      const m = object(claim.match, 'match');
      known(m, ['resourcePrefix']);
      match = { resourcePrefix: text(m.resourcePrefix, 'resourcePrefix') };
    }

    return {
      name: text(claim.name, 'well-known name'),
      kind: variant(claim.kind, ['shared', 'exclusive']),
      match,
      route: text(claim.route, 'well-known route'),
    };
  });

  const writeTargets = list(entry.writeTargets, 'http.writeTargets').map(
    value => {
      const target = object(value, 'write target');
      known(target, ['id', 'parent', 'classes']);

      return {
        id: text(target.id, 'write target id'),
        parent: text(target.parent, 'write target parent'),
        classes: texts(target.classes, 'write target classes'),
      };
    },
  );

  const named = (value, what) => {
    const item = object(value, what);
    known(item, ['name', 'reason']);

    return {
      name: text(item.name, `${what} name`),
      reason: optionalText(item.reason, `${what} reason`),
    };
  };

  const keys = list(entry.keys, 'http.keys').map(value => {
    const key = object(value, 'key');
    known(key, ['name', 'alg', 'reason']);

    return {
      name: text(key.name, 'key name'),
      alg: variant(key.alg, ['rsa-sha256', 'ed25519']),
      reason: optionalText(key.reason, 'key reason'),
    };
  });
  const tokens = list(entry.tokens, 'http.tokens').map(v => named(v, 'token'));
  const listeners = list(entry.listeners, 'http.listeners').map(v =>
    named(v, 'listener'),
  );
  const sidecars = list(entry.sidecars, 'http.sidecars').map(v =>
    named(v, 'sidecar'),
  );
  const reason = optionalText(entry.reason, 'http.reason');

  // The same checks, in the same order, as the host.
  if (routes.length > MAX_ROUTES)
    throw new Error(
      `at most ${MAX_ROUTES} routes per installation, got ${routes.length}`,
    );
  uniqueNames(
    routes.map(r => r.id),
    'route IDs',
  );
  const targets = uniqueNames(
    writeTargets.map(t => t.id),
    'write target IDs',
  );
  uniqueNames(
    keys.map(k => k.name),
    'key names',
  );
  uniqueNames(
    tokens.map(t => t.name),
    'token names',
  );
  uniqueNames(
    listeners.map(l => l.name),
    'listener names',
  );
  uniqueNames(
    sidecars.map(s => s.name),
    'sidecar names',
  );

  const patterns = [];

  for (const route of routes) {
    const segments = pattern(route.path);
    if (
      route.methods.length === 0 ||
      route.methods.some(
        (m, i) => !METHODS.includes(m) || route.methods.indexOf(m) !== i,
      )
    )
      throw new Error(
        `route methods must be unique and from ${METHODS.join(', ')}`,
      );
    if (route.principal === 'caller' && route.auth !== 'atomic')
      throw new Error('principal caller requires auth atomic');
    if (
      mount === 'drive-prefix' &&
      route.principal !== 'anonymous' &&
      route.auth !== 'atomic'
    )
      throw new Error(
        'routes on the drive-prefix mount must use principal anonymous unless auth is atomic',
      );
    if (route.auth === 'bearer' && tokens.length === 0)
      throw new Error('auth bearer requires http.tokens');
    if (route.accept.some(a => !a.includes('/')))
      throw new Error('route accept entries must be media types');

    if (route.maxBodyBytes !== undefined) {
      const cap = route.body === 'blob' ? Infinity : MAX_INLINE_BODY_BYTES;
      if (route.maxBodyBytes === 0 || route.maxBodyBytes > cap)
        throw new Error(
          `maxBodyBytes must be between 1 and ${MAX_INLINE_BODY_BYTES}`,
        );
    }

    if (
      route.timeoutMs !== undefined &&
      (route.timeoutMs === 0 || route.timeoutMs > MAX_TIMEOUT_MS)
    )
      throw new Error(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
    if (route.writes.some(w => !targets.has(w)))
      throw new Error('writes must name declared writeTargets');
    if (
      route.enqueues.some(
        id =>
          !context.operations.some(o => o.id === id && o.effect === 'write'),
      )
    )
      throw new Error('enqueues must name declared write operations');

    for (const other of patterns) {
      const shared = route.methods.some(m => other.methods.includes(m));
      if (shared && overlaps(other.segments, segments))
        throw new Error(`routes \`${other.id}\` and \`${route.id}\` overlap`);
    }

    patterns.push({ id: route.id, methods: route.methods, segments });
  }

  const claimed = new Set();

  for (const claim of wellKnown) {
    const allowed = (
      claim.kind === 'shared' ? SHARED_WELL_KNOWN : EXCLUSIVE_WELL_KNOWN
    ).includes(claim.name);
    if (!allowed || claimed.has(claim.name))
      throw new Error(
        `well-known name \`${claim.name}\` is not claimable as ${claim.kind} (or claimed twice)`,
      );
    claimed.add(claim.name);
    const hasMatch = !!claim.match && claim.match.resourcePrefix.length > 0;
    if (hasMatch !== (claim.kind === 'shared'))
      throw new Error(
        'shared well-known claims need match.resourcePrefix; exclusive ones take none',
      );
    if (!routes.some(r => r.id === claim.route))
      throw new Error('well-known claims must name a declared route');
  }

  for (const target of writeTargets) {
    const parentOk = target.parent.startsWith('config:')
      ? /^[A-Za-z0-9_.-]{1,128}$/.test(target.parent.slice('config:'.length))
      : isUrl(target.parent, ['https:', 'http:', 'did:'], false);
    const classesOk =
      target.classes.length > 0 &&
      new Set(target.classes).size === target.classes.length &&
      target.classes.every(c => isUrl(c, ['https:', 'http:'], true));
    if (!parentOk || !classesOk)
      throw new Error(
        `write target \`${target.id}\` needs a parent (\`config:<key>\` or a URL) and unique class URLs`,
      );
  }

  if (listeners.length > 0 && !context.serverExtension)
    throw new Error('http.listeners requires world server-extension');

  for (const operation of context.operations) {
    if (
      isWildcardHost(operation.url) &&
      !routes.some(r => r.enqueues.includes(operation.id))
    )
      throw new Error(
        "wildcard-host operations must be listed in a route's enqueues",
      );
  }

  const canonical = {
    ...(mount !== 'installation-origin' ? { mount } : {}),
    ...(routes.length
      ? {
          routes: routes.map(r => ({
            id: r.id,
            path: r.path,
            methods: r.methods,
            ...(r.principal !== 'anonymous' ? { principal: r.principal } : {}),
            ...(r.auth !== 'none' ? { auth: r.auth } : {}),
            ...(r.accept.length ? { accept: r.accept } : {}),
            ...(r.cors !== 'none' ? { cors: r.cors } : {}),
            ...(r.maxBodyBytes !== undefined
              ? { maxBodyBytes: r.maxBodyBytes }
              : {}),
            ...(r.body !== undefined ? { body: r.body } : {}),
            ...(r.writes.length ? { writes: r.writes } : {}),
            ...(r.enqueues.length ? { enqueues: r.enqueues } : {}),
            ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
          })),
        }
      : {}),
    ...(wellKnown.length
      ? {
          wellKnown: wellKnown.map(({ match, ...claim }) =>
            match ? { ...claim, match } : claim,
          ),
        }
      : {}),
    ...(writeTargets.length ? { writeTargets } : {}),
    ...(keys.length ? { keys: keys.map(withReason) } : {}),
    ...(tokens.length ? { tokens: tokens.map(withReason) } : {}),
    ...(listeners.length ? { listeners: listeners.map(withReason) } : {}),
    ...(sidecars.length ? { sidecars: sidecars.map(withReason) } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };

  return Object.keys(canonical).length ? canonical : undefined;
}

const isReadOnlyRoute = route =>
  route.methods.every(m => m === 'GET' || m === 'HEAD') &&
  (route.principal ?? 'anonymous') === 'anonymous' &&
  (route.auth ?? 'none') === 'none' &&
  !route.writes?.length &&
  !route.enqueues?.length &&
  route.body === undefined;

/**
 * What a release needs from the node's plugin-routes gates (design 0.1):
 * `{ needed: 'none' | 'read-only' | 'read-write', listeners, sidecars,
 * surfaces: [{ surface, needs }] }`. Expects a canonical `http` block.
 */
export function httpGate(http) {
  const surfaces = [];
  const add = (surface, needs) => surfaces.push({ surface, needs });

  for (const route of http?.routes ?? [])
    add(
      `route \`${route.methods.join(',')} ${route.path}\``,
      isReadOnlyRoute(route) ? 'read-only' : 'read-write',
    );
  for (const claim of http?.wellKnown ?? [])
    add(`well-known \`${claim.name}\``, 'read-only');
  for (const target of http?.writeTargets ?? [])
    add(`write target \`${target.id}\``, 'read-write');
  for (const key of http?.keys ?? []) add(`key \`${key.name}\``, 'read-write');
  for (const token of http?.tokens ?? [])
    add(`token store \`${token.name}\``, 'read-write');
  const deliveries = [
    ...new Set((http?.routes ?? []).flatMap(r => r.enqueues ?? [])),
  ];
  for (const id of deliveries) add(`delivery \`${id}\``, 'read-write');
  for (const listener of http?.listeners ?? [])
    add(`listener \`${listener.name}\``, 'read-write');
  for (const sidecar of http?.sidecars ?? [])
    add(`sidecar \`${sidecar.name}\``, 'read-write');

  const top = Math.max(0, ...surfaces.map(s => rank(s.needs)));

  return {
    needed: top === 0 ? 'none' : LEVELS[top],
    listeners: (http?.listeners ?? []).map(l => l.name),
    sidecars: (http?.sidecars ?? []).map(s => s.name),
    surfaces,
  };
}

/**
 * The `requires` list derived from a manifest's declarations (design section
 * 1), sorted. Authors never write it, so it can't disagree with the manifest.
 * Expects a manifest whose `http` block is canonical (`checkManifest`).
 */
export function derivedRequires(manifest) {
  const { http } = manifest;
  const gate = httpGate(http);
  const requires = new Set();
  // Absent `entrypoints` means `run`, as in version one.
  const runs =
    manifest.runtime === 'wasip2/1' ||
    (manifest.entrypoints === undefined ? true : !!manifest.entrypoints.run);
  const publicSurface = !!(
    http?.routes?.length ||
    http?.wellKnown?.length ||
    http?.writeTargets?.length ||
    http?.keys?.length ||
    http?.tokens?.length
  );

  if (manifest.secrets?.length) requires.add('host-credentials');
  if (runs || publicSurface) requires.add('wasm-sandbox');

  if (publicSurface) {
    requires.add('persistent-host');
    requires.add('public-origin');
  }

  if (gate.needed !== 'none') requires.add(`plugin-routes:${gate.needed}`);
  for (const name of gate.listeners) requires.add(`operator-listener:${name}`);
  for (const name of gate.sidecars) requires.add(`operator-sidecar:${name}`);

  return [...requires].sort();
}

/**
 * Checks the parts of a manifest this module owns and returns the manifest
 * with its `http` block canonical (dropped when empty). Throws with the
 * host's message when the block is invalid, or present below version 3.
 */
export function checkManifest(raw) {
  const manifest = object(raw, 'manifest');
  const version = manifest.schemaVersion;
  if (version !== 1 && version !== 2 && version !== 3)
    throw new Error('unsupported manifest schemaVersion');
  const { http: rawHttp, ...rest } = manifest;
  if (rawHttp === undefined) return rest;
  if (version !== 3) throw new Error('the http block needs schemaVersion 3');
  const http = validateHttp(rawHttp, {
    serverExtension: manifest.world === 'server-extension',
    operations: list(manifest.operations, 'operations').map(o => ({
      id: o?.id,
      effect: o?.effect,
      url: o?.url,
    })),
  });

  return http ? { ...rest, http } : rest;
}

/**
 * Everything the tooling needs about a manifest's gating in one call:
 * `{ schemaVersion, gate, requires, gated }`, where `gated` means some
 * surface needs the `plugin-routes` feature.
 */
export function describeGating(raw) {
  const manifest = checkManifest(raw);
  const gate = httpGate(manifest.http);

  return {
    schemaVersion: manifest.schemaVersion,
    gate,
    requires: derivedRequires(manifest),
    gated: gate.needed !== 'none',
  };
}

/**
 * Compares a release's needs with a node's gates (`hostFeatures.pluginRoutes`
 * from `/plugin-catalog`), as the host does at install, upgrade and release
 * pin. `undefined` when the node allows it.
 */
export function checkHostFeatures(http, node) {
  const gate = httpGate(http);
  if (gate.needed === 'none') return undefined;
  const level = node.compiled ? node.level : 'off';
  const listeners = gate.listeners.filter(n => !node.listeners.includes(n));
  const sidecars = gate.sidecars.filter(n => !node.sidecars.includes(n));
  let surfaces;

  if (rank(gate.needed) > rank(level)) {
    surfaces = gate.surfaces
      .filter(s => rank(s.needs) > rank(level))
      .map(s => s.surface);
  } else if (listeners.length || sidecars.length) {
    surfaces = [
      ...listeners.map(n => `listener \`${n}\``),
      ...sidecars.map(n => `sidecar \`${n}\``),
    ];
  } else {
    return undefined;
  }

  return {
    type: HOST_FEATURE_UNAVAILABLE,
    feature: 'plugin-routes',
    needed: gate.needed,
    compiled: node.compiled,
    level,
    surfaces,
    listeners,
    sidecars,
  };
}

/** The refusal text of design 0.4; the host sends the same words. */
export function hostFeatureMessage(problem) {
  const opens = `This plugin opens public endpoints on the server (${problem.surfaces.join(', ')}).`;

  if (!problem.compiled)
    return `${opens} This AtomicServer was built without plugin routes, so the plugin can't be installed here.`;

  if (rank(problem.level) < rank(problem.needed))
    return `${opens} The server operator hasn't enabled them. To allow it, start AtomicServer with \`--plugin-routes ${problem.needed}\` (or \`ATOMIC_PLUGIN_ROUTES=${problem.needed}\`).`;

  const additions = [];
  if (problem.listeners.length)
    additions.push(
      `${problem.listeners.map(n => `\`${n}:<port>\``).join(', ')} to \`ATOMIC_PLUGIN_LISTENERS\``,
    );
  if (problem.sidecars.length)
    additions.push(
      `${problem.sidecars.map(n => `\`${n}=http://127.0.0.1:<port>\``).join(', ')} to \`ATOMIC_PLUGIN_SIDECARS\``,
    );

  return `${opens} The server operator hasn't configured them. To allow it, add ${additions.join(' and ')}.`;
}
