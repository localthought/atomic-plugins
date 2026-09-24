// @wc-ignore-file
// Type-only import: plugin.ts bundles this file into the sandbox plugin.js, so
// it must not pull the lib's runtime in (as in money/schema.ts).
import type { Datatype, SchemaSpec } from '../../browser/lib/src/index.js';

const STRING = 'https://atomicdata.dev/datatypes/string' as Datatype;

export const FIELDS = [
  [
    'willow-namespace',
    'Namespace',
    'Willow namespace id: a 32-byte ed25519 public key, as 64 lower-case hex digits. Communal when the last byte is even, owned otherwise.',
  ],
  [
    'willow-subspace',
    'Subspace',
    'Willow subspace id: a 32-byte ed25519 public key, as 64 lower-case hex digits.',
  ],
  [
    'willow-path',
    'Path',
    'Willow path: components joined by "/", each byte outside A-Z a-z 0-9 - . _ ~ percent-encoded (%2f for a slash inside a component).',
  ],
  [
    'willow-timestamp',
    'Timestamp',
    'Exact Willow timestamp as a decimal string of microseconds. The data model recommends, but does not require, TAI since the J2000 epoch (2000-01-01 12:00 TT).',
  ],
  [
    'willow-time',
    'Time (UTC)',
    'The timestamp read as recommended, converted to UTC with the IERS leap seconds up to 2017-01-01, as an ISO 8601 string with microseconds. A leap second announced later would make it one second off. Empty for times after 2099.',
  ],
  [
    'willow-payload-length',
    'Payload length',
    'Exact payload length in bytes, as a decimal string.',
  ],
  [
    'willow-payload-digest',
    'Payload digest',
    'WILLIAM3 digest of the payload, as 64 lower-case hex digits.',
  ],
  [
    'willow-payload',
    'Payload',
    'The payload as text, when its status is stored and it is valid UTF-8; empty otherwise.',
  ],
  [
    'willow-payload-base64',
    'Payload (base64)',
    'The payload as standard base64, when its status is stored and it is not valid UTF-8; empty otherwise.',
  ],
  [
    'willow-payload-status',
    'Payload status',
    'stored: the drop carried the whole payload, it matched the digest and it is on this row; too-large: verified but longer than 65536 bytes, so not stored; not-in-drop: the drop carried no payload for this entry. Payload fields are empty unless stored.',
  ],
  [
    'willow-capability',
    'Capability',
    'Kind of Meadowcap write capability that authorised the entry: communal or owned. Delegated capabilities are not imported yet.',
  ],
  [
    'willow-source-id',
    'Source identity',
    'Namespace, subspace and path: the key under which a Willow store keeps only the newest entry.',
  ],
] as const;

export type Shortname = (typeof FIELDS)[number][0];

/**
 * The Willow entry ontology, declared as the manifest's `destination.schema`:
 * the host creates it in the drive when the importer is set up.
 */
export function willowSchema(): SchemaSpec {
  return {
    properties: FIELDS.map(([shortname, name, description]) => ({
      shortname,
      name,
      description,
      datatype: STRING,
    })),
    classes: [
      {
        shortname: 'willow-entry',
        name: 'Willow entry',
        description:
          'An entry imported from a Willow drop, after its Meadowcap authorisation was verified.',
        requires: [
          'willow-namespace',
          'willow-subspace',
          'willow-path',
          'willow-timestamp',
          'willow-payload-length',
          'willow-payload-digest',
          'willow-source-id',
        ],
        recommends: [
          'willow-time',
          'willow-payload-status',
          'willow-payload',
          'willow-payload-base64',
          'willow-capability',
        ],
      },
    ],
  };
}
