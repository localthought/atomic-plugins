// @wc-ignore-file
/**
 * A decoder and verifier for the Willow Drop Format
 * (https://willowprotocol.org/specs/drop-format/, status "Proposal") with the
 * Willow'25 parameters (https://willowprotocol.org/specs/willow25/), ported
 * from willow25 0.7.9 (`drop_format/decode.rs`, `authorisation/`).
 *
 * Supported: every entry field, communal and owned write capabilities
 * **without delegations**, and payloads that are either absent (slice mode
 * `00`) or included in full (mode `01`, checked against the entry's WILLIAM3
 * digest). Refused with a DropError, never guessed at: capabilities with
 * delegations, and partial payload slices (modes `10` and `11`). An entry whose
 * capability or signature does not verify refuses the whole drop, because the
 * following entries are encoded relative to it.
 */
import {
  hashes,
  verify,
} from '../../browser/lib/node_modules/@noble/ed25519/index.js';
import { sha512 } from '../../browser/lib/node_modules/@noble/hashes/sha2.js';
import {
  DropError,
  Reader,
  decodeRelativePath,
  encodeCu64Standalone,
  encodePath,
  type Path,
} from './encoding.js';
import { CHUNK_SIZE, william3 } from './william3.js';

hashes.sha512 = sha512;

/** At most this many entries per drop; the sandbox verifies each one. */
export const MAX_ENTRIES = 1000;

export type Capability =
  | { kind: 'communal' }
  | { kind: 'owned'; userKey: Uint8Array; initialAuthorisation: Uint8Array };

export interface DropEntry {
  namespace: Uint8Array;
  subspace: Uint8Array;
  path: Path;
  /** Microseconds; the data model recommends TAI since J2000 (12:00 TT). */
  timestamp: bigint;
  payloadLength: bigint;
  payloadDigest: Uint8Array;
  capability: Capability;
  /** Whether the entry is in a communal namespace (last byte even). */
  communal: boolean;
  /** The payload, when the drop includes all of it; checked against the digest. */
  payload?: Uint8Array;
}

/** Willow'25 defaults: the state the first entry is encoded against. */
const hexBytes = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map(pair => parseInt(pair, 16)));
const DEFAULT_ID = hexBytes(
  '934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817318',
);
const DEFAULT_ENTRY: DropEntry = {
  namespace: DEFAULT_ID,
  subspace: DEFAULT_ID,
  path: [],
  timestamp: 0n,
  payloadLength: 0n,
  payloadDigest: william3(new Uint8Array()),
  capability: { kind: 'communal' },
  communal: true,
};

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const isCommunal = (namespace: Uint8Array) => namespace[31] % 2 === 0;

/** Ed25519 verification, RFC 8032 rules (willow25 uses dalek's verify_strict). */
function signed(key: Uint8Array, message: Uint8Array, signature: Uint8Array) {
  try {
    return verify(signature, message, key, { zip215: false });
  } catch {
    return false;
  }
}

/** encode_entry: the bytes an authorisation token's signature covers. */
function encodeEntry(entry: Omit<DropEntry, 'capability' | 'communal'>) {
  return new Uint8Array([
    ...entry.namespace,
    ...entry.subspace,
    ...encodePath(entry.path),
    ...encodeCu64Standalone(entry.timestamp),
    ...encodeCu64Standalone(entry.payloadLength),
    ...entry.payloadDigest,
  ]);
}

/**
 * EncodeCommunalCapabilityRelative / EncodeOwnedCapabilityRelative, for
 * capabilities without delegations, followed by the token's signature. The
 * capability is decoded relative to the previous entry's.
 */
function decodeToken(
  reader: Reader,
  previous: Capability,
): { capability: Capability; signature: Uint8Array } {
  const header = reader.byte();
  const shared = reader.cu64(header, 3, 1);
  const delegations = reader.cu64(header, 4, 4);
  if (delegations > 0n)
    throw new DropError(
      'its write capability carries delegations, which this importer does not decode yet',
    );
  if (shared > 1n)
    throw new DropError('its capability reuses delegations that do not exist');
  let capability: Capability = { kind: 'communal' };

  if (header & 0x80) {
    if (shared === 0n)
      capability = {
        kind: 'owned',
        userKey: reader.take(32),
        initialAuthorisation: reader.take(64),
      };
    else if (previous.kind === 'owned') capability = previous;
    else
      throw new DropError(
        'its owned capability claims to repeat a communal one',
      );
  }

  return { capability, signature: reader.take(64) };
}

/** Decodes and verifies a whole drop. Throws a DropError on the first problem. */
export function decodeDrop(bytes: Uint8Array): DropEntry[] {
  const reader = new Reader(bytes);
  const entries: DropEntry[] = [];
  let previous = DEFAULT_ENTRY;

  for (;;) {
    const index = entries.length;
    const header = reader.byte();
    if (header === 0) break;

    try {
      if (index >= MAX_ENTRIES)
        throw new DropError(`a drop may hold at most ${MAX_ENTRIES} entries`);
      previous = decodeEntry(reader, header, previous);
    } catch (error) {
      // Every problem below is about this entry; name it.
      if (error instanceof DropError && error.entry === undefined)
        throw new DropError(error.message, index);
      throw error;
    }

    entries.push(previous);
  }

  if (reader.remaining > 0)
    throw new DropError('there are bytes after the end of the drop');

  return entries;
}

function decodeEntry(
  reader: Reader,
  header: number,
  previous: DropEntry,
): DropEntry {
  if ((header & 0xc0) !== 0x40)
    throw new DropError(
      'it does not start with an entry header; continuation slices are not supported',
    );
  const namespace = header & 0x20 ? reader.take(32) : previous.namespace;
  const subspace = header & 0x10 ? reader.take(32) : previous.subspace;
  const path = decodeRelativePath(reader, previous.path);
  const timestamp = reader.cu64(header, 2, 4);
  const payloadLength = reader.cu64Standalone();
  const payloadDigest = reader.take(32);
  const { capability, signature } = decodeToken(reader, previous.capability);
  const fields = {
    namespace,
    subspace,
    path,
    timestamp,
    payloadLength,
    payloadDigest,
  };

  // Meadowcap: the capability must be valid and include the entry, and the
  // signature must be the capability receiver's over encode_entry.
  const communal = isCommunal(namespace);
  let receiver: Uint8Array;

  if (capability.kind === 'communal') {
    if (!communal)
      throw new DropError(
        'it uses a communal capability in an owned namespace',
      );
    receiver = subspace;
  } else {
    if (communal)
      throw new DropError(
        'it uses an owned capability in a communal namespace',
      );
    // owned_genesis_data_to_sign: access mode Write (3), then the user key.
    const genesis = new Uint8Array([3, ...capability.userKey]);
    if (!signed(namespace, genesis, capability.initialAuthorisation))
      throw new DropError(
        "its owned capability is not signed by the namespace's key",
      );
    receiver = capability.userKey;
  }

  if (!signed(receiver, encodeEntry(fields), signature))
    throw new DropError('its authorisation signature does not verify');

  const entry: DropEntry = { ...fields, capability, communal };
  const mode = header & 0x03;

  if (mode === 0x01) {
    if (payloadLength > BigInt(reader.remaining))
      throw new DropError('the drop ends in the middle of a payload');
    const payload = reader.take(Number(payloadLength));
    if (!equal(william3(payload), payloadDigest))
      throw new DropError('its payload does not match its digest');
    entry.payload = payload;
  } else if (mode === 0x03) {
    // Multi-slice mode with no slices is allowed; any slice is not supported.
    if (reader.remaining > 0 && reader.peek() & 0x80)
      throw new DropError(
        'it carries partial payload slices, which this importer does not verify yet',
      );
  } else if (mode === 0x02) {
    throw new DropError(
      `it carries a partial payload prefix (${CHUNK_SIZE}-byte chunks), which this importer does not verify yet`,
    );
  }

  return entry;
}
