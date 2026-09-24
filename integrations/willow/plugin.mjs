import {
  encodeEntry,
  decodeEntry,
  validatePath,
  u64,
  hex,
  unhex,
  utf8,
} from './codec.mjs';
import { william3 } from '../willow-drop/william3.ts';

export const P = Object.freeze({
  parent: 'https://atomicdata.dev/properties/parent',
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  localId: 'https://atomicdata.dev/properties/localId',
  baseline: 'https://atomicdata.dev/properties/importBaseline',
});
const MAX_SUBJECTS = 32,
  MAX_PAYLOAD_BYTES = 65536;

export const manifest = {
  schemaVersion: 2,
  name: 'willow',
  namespace: 'atomic-plugins',
  version: '0.2.0',
  description:
    'Prepare exact unsigned Willow Entry signing bytes from explicitly selected Atomic properties.',
  operations: [],
  secrets: [],
  capabilities: [
    {
      name: 'storage',
      reason:
        'Read approved Atomic resources and propose reviewed unsigned export records.',
    },
  ],
  configSchema: {
    type: 'object',
    properties: {
      subjects: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit Atomic resource subjects to export',
      },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Explicit property subjects included in each JSON-AD payload',
      },
      outputParent: {
        type: 'string',
        description: 'Atomic parent for reviewed unsigned export candidates',
      },
      namespace: {
        type: 'string',
        description: 'Willow namespace public key, 64 hex characters',
      },
      subspace: {
        type: 'string',
        description: 'Willow subspace public key, 64 hex characters',
      },
      pathPrefix: {
        type: 'array',
        items: { type: 'string' },
        description: 'Willow binary path components as hexadecimal strings',
      },
      timestamp: {
        type: 'string',
        description:
          'Explicit logical Willow U64 timestamp as decimal text; increase after source changes',
      },
    },
    required: [
      'subjects',
      'properties',
      'outputParent',
      'namespace',
      'subspace',
      'pathPrefix',
      'timestamp',
    ],
  },
};
const subjectId = value =>
  typeof value === 'string' && /^(https?:\/\/|did:ad:)/.test(value);

function decimal(value) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 20
  )
    throw Error('Timestamp must be canonical U64 decimal text');

  return u64(BigInt(value));
}

/** Deterministic JSON serialization is an application payload choice, not Willow framing. */
export function canonicalJson(value, depth = 0) {
  if (depth > 32) throw Error('Payload nesting limit exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length > 1024) throw Error('Payload array limit exceeded');

    return (
      '[' + value.map(item => canonicalJson(item, depth + 1)).join(',') + ']'
    );
  }

  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    const keys = Object.keys(value).sort();
    if (keys.length > 128) throw Error('Payload object limit exceeded');

    return (
      '{' +
      keys
        .map(
          key =>
            JSON.stringify(key) + ':' + canonicalJson(value[key], depth + 1),
        )
        .join(',') +
      '}'
    );
  }

  throw Error('Payload contains a non-JSON value');
}

function config(raw) {
  if (!raw || !subjectId(raw.outputParent))
    throw Error('Configure an Atomic output parent');

  for (const field of ['subjects', 'properties']) {
    if (
      !Array.isArray(raw[field]) ||
      !raw[field].length ||
      raw[field].length > MAX_SUBJECTS ||
      !raw[field].every(subjectId) ||
      new Set(raw[field]).size !== raw[field].length
    )
      throw Error('Configure bounded unique ' + field);
  }

  if (raw.subjects.includes(raw.outputParent))
    throw Error('Output parent cannot be a source');
  if (
    !/^[a-fA-F0-9]{64}$/.test(raw.namespace) ||
    !/^[a-fA-F0-9]{64}$/.test(raw.subspace)
  )
    throw Error('Willow identifiers must be 32-byte public keys');
  if (!Array.isArray(raw.pathPrefix))
    throw Error('Configure binary path prefix');
  const prefix = validatePath(raw.pathPrefix.map(unhex));

  return {
    ...raw,
    prefix,
    namespaceBytes: unhex(raw.namespace),
    subspaceBytes: unhex(raw.subspace),
    time: decimal(raw.timestamp),
  };
}

/** Reads only an explicitly configured Atomic subject and selected properties.
 * Returns an unsigned Entry and payload, not a Meadowcap AuthorisedEntry.
 */
export function exportCandidate(ctx, raw, subject) {
  const c = config(raw);
  if (!c.subjects.includes(subject))
    throw Error('Subject is not approved for export');
  const resource = ctx.read(subject),
    selected = Object.create(null);
  selected['@id'] = subject;

  for (const property of c.properties) {
    if (Object.prototype.hasOwnProperty.call(resource, property))
      selected[property] = resource[property];
  }

  const payload = utf8(canonicalJson(selected));
  if (payload.length > MAX_PAYLOAD_BYTES) throw Error('Payload exceeds 64 KiB');
  const entry = {
    namespace: c.namespaceBytes,
    subspace: c.subspaceBytes,
    path: validatePath([...c.prefix, utf8(subject)]),
    timestamp: c.time,
    payloadLength: BigInt(payload.length),
    payloadDigest: william3(payload),
  };

  return { entry, entryBytes: encodeEntry(entry), payload };
}
/** Structural and payload-integrity validation only. No signature/capability check. */
export function checkCandidate(entryBytes, payload) {
  const entry = decodeEntry(entryBytes, { canonical: true });
  if (
    !(payload instanceof Uint8Array) ||
    payload.length > MAX_PAYLOAD_BYTES ||
    BigInt(payload.length) !== entry.payloadLength
  )
    throw Error('Payload length mismatch or limit exceeded');
  if (hex(william3(payload)) !== hex(entry.payloadDigest))
    throw Error('WILLIAM3 payload digest mismatch');

  return entry;
}
/** Existing Atomic sandbox job: proposes persisted candidate resources for review.
 * No remote peer receives these proposals and no signing key is ever handled.
 */
export function run(ctx) {
  try {
    const c = config(ctx.config),
      intents = [];

    for (const subject of c.subjects) {
      const { entry, entryBytes, payload } = exportCandidate(ctx, c, subject);
      const key =
        'willow-candidate:' +
        hex(
          william3(
            utf8(
              canonicalJson({
                namespace: hex(entry.namespace),
                subspace: hex(entry.subspace),
                path: entry.path.map(hex),
              }),
            ),
          ),
        );
      const matches = ctx
        .query(P.localId, key)
        .filter(id => ctx.read(id)[P.parent] === c.outputParent);
      if (matches.length > 1)
        throw Error('Duplicate export candidate identity');
      const envelope = {
        format: 'atomic-willow-signing-candidate-v1',
        status: 'unsigned',
        source: subject,
        mediaType: 'application/ad+json',
        entryHex: hex(entryBytes),
        payloadHex: hex(payload),
      };
      const serialized = canonicalJson(envelope);
      const set = {
        [P.name]: 'Unsigned Willow export: ' + subject,
        [P.description]: serialized,
        [P.localId]: key,
        [P.baseline]: envelope,
      };

      if (!matches.length)
        intents.push({
          op: 'create',
          localId: key,
          parent: c.outputParent,
          isA: [],
          set,
        });
      else {
        const existing = ctx.read(matches[0]),
          previous = existing[P.baseline];
        if (
          !previous ||
          previous.format !== envelope.format ||
          existing[P.description] !== canonicalJson(previous)
        )
          throw Error('Local candidate edits require manual reconciliation');
        const oldEntry = checkCandidate(
          unhex(previous.entryHex),
          unhex(previous.payloadHex),
        );
        if (
          previous.source !== subject ||
          hex(oldEntry.namespace) !== hex(entry.namespace) ||
          hex(oldEntry.subspace) !== hex(entry.subspace) ||
          canonicalJson(oldEntry.path.map(hex)) !==
            canonicalJson(entry.path.map(hex))
        )
          throw Error('Existing candidate identity does not match source');
        if (
          previous.entryHex === envelope.entryHex &&
          previous.payloadHex === envelope.payloadHex
        )
          continue;
        if (entry.timestamp <= oldEntry.timestamp)
          throw Error(
            'Increase logical timestamp before replacing an export candidate',
          );
        intents.push({ op: 'set', subject: matches[0], set });
      }
    }

    return { intents, problems: [] };
  } catch (error) {
    return {
      intents: [],
      problems: [{ severity: 'error', message: error.message }],
    };
  }
}
