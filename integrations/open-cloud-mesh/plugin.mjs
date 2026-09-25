/* eslint-disable no-control-regex -- Protocol validation must reject control characters. */
/** QuickJS ES module. No network, credential access, or process-local persistence. */
export const P = Object.freeze({
  isA: 'https://atomicdata.dev/properties/isA',
  parent: 'https://atomicdata.dev/properties/parent',
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  about: 'https://atomicdata.dev/properties/about',
  localId: 'https://atomicdata.dev/properties/localId',
  baseline: 'https://atomicdata.dev/properties/importBaseline',
});
const DOCUMENTS = [
  'https://atomicdata.dev/classes/Document',
  'https://atomicdata.dev/classes/DocumentV2',
];
const MESSAGE = 'https://atomicdata.dev/classes/Message';
const MAX_BODY = 16384;

function text(value, field, max = 1024) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`Invalid ${field}`);

  return value;
}

// Deliberately restrictive HTTPS DNS origins. URL is not a QuickJS global.
export function origin(value) {
  text(value, 'origin', 255);
  const match = /^https:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match)
    throw new Error(
      'Expected an HTTPS DNS origin without credentials, path or query',
    );
  const host = match[1].toLowerCase();
  const labels = host.split('.');
  if (
    host.length > 253 ||
    labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error('Invalid DNS origin');
  // Numeric IPv4 spellings and IDNA conversion are deliberately unsupported;
  // accepting them would require a complete URL host parser in QuickJS.
  if (/^(?:[0-9]+|0x[0-9a-f]+)$/.test(labels[labels.length - 1]))
    throw new Error('Expected a DNS origin');
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('Invalid origin port');

  return 'https://' + host + (port === 443 ? '' : ':' + port);
}

function approvedPeer(policy, peer) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    throw new Error('Peer is not allowed');
  const decisions = new Map();

  for (const [raw, decision] of Object.entries(policy)) {
    const canonical = origin(raw);
    if (
      typeof decision !== 'boolean' ||
      (decisions.has(canonical) && decisions.get(canonical) !== decision)
    )
      throw new Error('Conflicting peer policy aliases');
    decisions.set(canonical, decision);
  }

  if (decisions.get(peer) !== true) throw new Error('Peer is not allowed');
}

function receiptMatches(ctx, identity, peer, providerId, recipient) {
  // Earlier unpublished code accepted explicit :443 as a separate identity.
  // Refuse that legacy record rather than silently duplicate or migrate it.
  if (!/:\d+$/.test(peer)) {
    const legacy = ctx.query(
      P.localId,
      JSON.stringify(['ocm-receipt-v1', peer + ':443', providerId, recipient]),
    );
    if (!Array.isArray(legacy) || legacy.length)
      throw new Error(
        'Legacy origin alias receipt needs manual reconciliation',
      );
  }

  return ctx.query(P.localId, identity);
}

function subject(value, field) {
  text(value, field, 2048);
  if (
    !/^(https?:\/\/|did:ad:)/.test(value) &&
    !/^atomic:(?!\/\/)[^\s?#]+$/.test(value)
  )
    throw new Error(`Invalid ${field} subject`);

  return value;
}

function response(status, body, head = false) {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: head ? '' : JSON.stringify(body),
  };
}

/** Public discovery is deliberately disabled until authenticated route writes exist. */
export function handle(ctx, request) {
  const method = request.method;
  const discovery =
    request.path === '/ocm-provider' || request.wellKnown === 'ocm';

  if (discovery) {
    if (method !== 'GET' && method !== 'HEAD')
      return response(405, { message: 'Method not allowed' });

    try {
      const base = origin(ctx.config?.publicOrigin);

      return response(
        200,
        {
          enabled: false,
          apiVersion: '1.3.0',
          endPoint: `${base}/ocm`,
          resourceTypes: [],
        },
        method === 'HEAD',
      );
    } catch {
      return response(
        503,
        { message: 'Configure publicOrigin before serving discovery' },
        method === 'HEAD',
      );
    }
  }

  if (request.path === '/ocm/shares' || request.path === '/ocm/notifications') {
    if (method !== 'POST')
      return response(405, { message: 'Method not allowed' });

    // Never claim a share was accepted, never trust body-provided identities.
    return response(501, {
      message:
        'Authenticated OCM receipt requires host route authentication, writes and delivery support',
    });
  }

  return response(404, { message: 'Not found' });
}
/** Validate the supported 1.3 file-share subset, returning no access credentials. */
export function parseShare(body) {
  if (typeof body !== 'string' || body.length > MAX_BODY)
    throw new Error('Share must be a JSON string of at most 16384 characters');
  let value;

  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('Invalid share JSON');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid share object');
  if (value.shareType !== 'user' || value.resourceType !== 'file')
    throw new Error('Only user file shares are supported');
  if (!value.protocol || !['webdav', 'multi'].includes(value.protocol.name))
    throw new Error('Only WebDAV share metadata is supported');
  const dav = value.protocol.webdav ?? value.protocol.options;
  if (!dav || typeof dav !== 'object')
    throw new Error('Missing WebDAV options');
  text(dav.uri, 'WebDAV uri', 2048);
  if (dav.uri.includes('://') && !/^https:\/\/[^/@?#\\]+\//.test(dav.uri))
    throw new Error('Absolute WebDAV URI must use HTTPS without credentials');
  if (
    dav.requirements !== undefined &&
    (!Array.isArray(dav.requirements) || dav.requirements.length)
  )
    throw new Error('WebDAV requirements are not supported');
  if (
    !Array.isArray(dav.permissions) ||
    !dav.permissions.length ||
    dav.permissions.some(p => !['read', 'write', 'share'].includes(p))
  )
    throw new Error('Unsupported WebDAV permissions');
  if (
    value.expiration !== undefined &&
    (!Number.isSafeInteger(value.expiration) || value.expiration < 0)
  )
    throw new Error('Invalid expiration');

  return {
    protocol: 'webdav',
    permissions: [...new Set(dav.permissions)].sort(),
    ...(value.expiration === undefined
      ? {}
      : { expiration: String(value.expiration) }),
    name: text(value.name, 'name', 255),
    providerId: text(value.providerId, 'providerId'),
    owner: text(value.owner, 'owner'),
    sender: text(value.sender, 'sender'),
    shareWith: text(value.shareWith, 'shareWith'),
    shareType: 'user',
    resourceType: 'file',
  };
}

const NOTIFICATIONS = Object.freeze({
  SHARE_ACCEPTED: 'accepted',
  SHARE_DECLINED: 'declined',
  SHARE_UNSHARED: 'unshared',
});

export function parseNotification(body) {
  if (typeof body !== 'string' || body.length > MAX_BODY)
    throw new Error('Notification must be bounded JSON text');
  let value;

  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('Invalid notification JSON');
  }

  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.resourceType !== 'file' ||
    typeof value.notificationType !== 'string' ||
    !Object.prototype.hasOwnProperty.call(NOTIFICATIONS, value.notificationType)
  )
    throw new Error('Unsupported OCM notification');
  if (
    value.notification !== undefined &&
    (!value.notification ||
      typeof value.notification !== 'object' ||
      Array.isArray(value.notification))
  )
    throw new Error('Invalid notification parameters');

  // Optional notification parameters may contain a sharedSecret: deliberately
  // never copy any of them into public receipt metadata or error messages.
  return {
    notificationType: value.notificationType,
    resourceType: 'file',
    providerId: text(value.providerId, 'providerId'),
  };
}

function receiptDescription(state) {
  return state.state === 'recorded'
    ? state.summary
    : state.summary + '\n\nReviewed receipt state: ' + state.state + '.';
}

function reviewedNotification(ctx, c, peer, document) {
  const notification = parseNotification(c.notificationJson);
  const recipient = text(c.recipient, 'recipient');
  const identity = JSON.stringify([
    'ocm-receipt-v1',
    peer,
    notification.providerId,
    recipient,
  ]);
  const matches = receiptMatches(
    ctx,
    identity,
    peer,
    notification.providerId,
    recipient,
  );
  if (!Array.isArray(matches) || matches.length !== 1)
    throw new Error('Notification needs one existing receipt');
  const existing = ctx.read(matches[0]);
  const state = existing?.[P.baseline];
  if (
    !existing ||
    existing[P.parent] !== document ||
    existing[P.about] !== document ||
    existing[P.localId] !== identity ||
    !Array.isArray(existing[P.isA]) ||
    !existing[P.isA].includes(MESSAGE) ||
    !state ||
    state.protocol !== 'ocm-reviewed-receipt/1' ||
    state.peer !== peer ||
    state.providerId !== notification.providerId ||
    state.recipient !== recipient ||
    state.document !== document ||
    typeof state.summary !== 'string' ||
    !['recorded', 'accepted', 'declined', 'unshared'].includes(state.state) ||
    existing[P.description] !== receiptDescription(state) ||
    state.values?.[P.description] !== existing[P.description]
  )
    throw new Error(
      'Receipt binding or locally edited state conflicts; review required',
    );
  const next = NOTIFICATIONS[notification.notificationType];
  if (
    state.state === next &&
    state.lastNotification === notification.notificationType
  )
    return { intents: [], problems: [] };
  if (c.expectedState !== state.state)
    throw new Error('Receipt state changed; review current state');
  // Local conservative receipt policy, not an assertion that OCM defines a state machine.
  if (
    !(
      (state.state === 'recorded' &&
        ['accepted', 'declined', 'unshared'].includes(next)) ||
      (state.state === 'accepted' && next === 'unshared')
    )
  )
    throw new Error(
      'Receipt transition refused; terminal decisions cannot be reopened',
    );
  const updated = {
    ...state,
    state: next,
    lastNotification: notification.notificationType,
    previous: state.values,
  };
  updated.values = { [P.description]: receiptDescription(updated) };

  return {
    intents: [
      {
        op: 'set',
        subject: matches[0],
        set: {
          [P.baseline]: updated,
          [P.description]: receiptDescription(updated),
        },
      },
    ],
    problems: [],
  };
}

/** A manually reviewed metadata import, not an authenticated network receiver.
 * Config is installation-owned. Share text is supplied by the operator, never
 * copied automatically from an incoming HTTP request. The host plans/applies
 * these ordinary intents under existing scoped job permissions and review.
 */
export function run(ctx) {
  try {
    const c = ctx.config ?? {};
    if (
      !['import-reviewed-share', 'apply-reviewed-notification'].includes(c.mode)
    )
      throw new Error(
        'Set mode to import-reviewed-share for an operator-reviewed metadata import',
      );
    const peer = origin(c.peerOrigin);
    approvedPeer(c.allowedPeers, peer);
    const document = subject(c.document, 'document');
    const target = ctx.read(document);
    if (
      !target ||
      !Array.isArray(target[P.isA]) ||
      !target[P.isA].some(t => DOCUMENTS.includes(t))
    )
      throw new Error(
        'Target must be an accessible Atomic Document or DocumentV2',
      );
    if (c.mode === 'apply-reviewed-notification')
      return reviewedNotification(ctx, c, peer, document);
    const share = parseShare(c.shareJson);
    if (share.shareWith !== text(c.recipient, 'recipient'))
      throw new Error('Share recipient does not match configured recipient');
    // Message belongs beneath the chosen document; it cannot silently change
    // document content or ACLs, and the host checks write access to this parent.
    const identity = JSON.stringify([
      'ocm-receipt-v1',
      peer,
      share.providerId,
      share.shareWith,
    ]);
    const matches = receiptMatches(
      ctx,
      identity,
      peer,
      share.providerId,
      share.shareWith,
    );
    if (!Array.isArray(matches) || matches.length > 1)
      throw new Error('Ambiguous existing share receipt');
    const escape = value =>
      String(value).replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&');
    const summary =
      'Operator-reviewed OCM share metadata. File content has not been imported.\n\n' +
      Object.entries({
        Peer: peer,
        Name: share.name,
        'Provider ID': share.providerId,
        Owner: share.owner,
        Sender: share.sender,
        Recipient: share.shareWith,
        Permissions: share.permissions.join(', '),
        Expiration: share.expiration ?? 'none',
      })
        .map(([key, value]) => `- ${key}: ${escape(value)}`)
        .join('\n');

    const initialState = {
      protocol: 'ocm-reviewed-receipt/1',
      peer,
      providerId: share.providerId,
      recipient: share.shareWith,
      document,
      summary,
      state: 'recorded',
      lastNotification: null,
      values: { [P.description]: summary },
      previous: {},
    };

    if (matches.length) {
      const existing = ctx.read(matches[0]);
      if (
        !existing ||
        existing[P.parent] !== document ||
        existing[P.about] !== document ||
        existing[P.localId] !== identity ||
        !Array.isArray(existing[P.isA]) ||
        !existing[P.isA].includes(MESSAGE) ||
        (existing[P.baseline]
          ? existing[P.baseline].protocol !== initialState.protocol ||
            existing[P.baseline].summary !== summary ||
            existing[P.baseline].peer !== peer ||
            existing[P.baseline].providerId !== share.providerId ||
            existing[P.baseline].recipient !== share.shareWith ||
            existing[P.baseline].document !== document ||
            !['recorded', 'accepted', 'declined', 'unshared'].includes(
              existing[P.baseline].state,
            ) ||
            existing[P.description] !==
              receiptDescription(existing[P.baseline]) ||
            existing[P.baseline].values?.[P.description] !==
              existing[P.description]
          : existing[P.description] !== summary)
      )
        throw new Error(
          'Share identity conflicts with an existing receipt; review required',
        );

      if (!existing[P.baseline])
        return {
          intents: [
            {
              op: 'set',
              subject: matches[0],
              set: { [P.baseline]: initialState },
            },
          ],
          problems: [],
        };

      return { intents: [], problems: [] };
    }

    return {
      intents: [
        {
          op: 'create',
          localId: 'ocm-share-receipt',
          parent: document,
          isA: [MESSAGE],
          set: {
            [P.name]: `OCM share: ${share.name}`,
            [P.description]: summary,
            [P.about]: document,
            [P.localId]: identity,
            [P.baseline]: initialState,
          },
        },
      ],
      problems: [],
    };
  } catch (error) {
    return {
      intents: [],
      problems: [{ severity: 'error', message: error.message }],
    };
  }
}
