// @wc-ignore-file
import {
  IMPORT_LOCAL_ID,
  importRecords,
  type ImportRecord,
} from '../../browser/lib/src/import-records.js';
import { decodeDrop } from './drop.js';
import {
  MAX_STORED_PAYLOAD,
  newer,
  prune,
  rowValues,
  sourceId,
} from './mapping.js';
import { FIELDS, willowSchema } from './schema.js';
import { readUpload } from './upload.js';

/** The largest drop file the host hands over: 5,000,000 bytes. */
export const MAX_DROP_BYTES = 5_000_000;
const PARENT = 'https://atomicdata.dev/properties/parent';
const NAME = 'https://atomicdata.dev/properties/name';

export const manifest = {
  schemaVersion: 2,
  name: 'willow-drop',
  namespace: 'atomic-plugins',
  version: '0.1.0',
  description:
    'Import entries from a Willow drop file (Willow Drop Format, Willow’25 parameters) after verifying their Meadowcap authorisation.',
  operations: [],
  secrets: [],
  config: {
    key: 'willowDrop',
    properties: {
      table: {
        type: 'string',
        description: 'Table the entries are written to',
      },
      rowClass: {
        type: 'string',
        description: 'Class each imported entry gets',
      },
      properties: {
        type: 'object',
        description: 'Willow entry properties, by shortname',
      },
    },
    required: ['table', 'rowClass', 'properties'],
  },
  // The host draws the file picker and hands the file over as text
  // (atomic-server#1653); upload.ts recovers the bytes. `.b64` is a drop
  // uploaded base64-encoded.
  accepts: [
    {
      extensions: ['.drop', '.willow', '.b64'],
      mediaTypes: ['application/octet-stream', 'text/plain'],
      as: 'text',
      maxBytes: MAX_DROP_BYTES,
    },
  ],
  destination: {
    schema: willowSchema(),
    table: {
      name: 'Willow entries',
      rowClass: 'willow-entry',
      columns: [
        'willow-path',
        'willow-time',
        'willow-payload',
        'willow-payload-length',
        'willow-subspace',
        'willow-namespace',
      ],
    },
  },
};

export interface Config {
  table: string;
  rowClass: string;
  properties: Record<string, string>;
}
interface Host {
  upload?: { name?: string; mediaType?: string; size?: number; text?: string };
  trigger?: { payload?: { validate?: boolean } };
  config?: Config;
  query(property: string, value: string): string[];
  read(subject: string): Record<string, unknown>;
}

const warning = (message: string) => ({
  severity: 'warning' as const,
  message,
});

export function run(ctx: Host) {
  const text = ctx.upload?.text;
  if (text === undefined)
    throw new Error(
      "Choose a Willow drop file under Import on this importer's page",
    );
  const { encoding, result: decoded } = readUpload(text, decodeDrop);
  if (ctx.trigger?.payload?.validate) return { intents: [], problems: [] };
  const { table, rowClass, properties: p } = ctx.config ?? ({} as Config);
  const missing = [
    ['table', table],
    ['rowClass', rowClass],
    ['properties', p],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length)
    throw new Error(
      `Configure this importer before running it: missing ${missing.join(', ')}`,
    );
  const absent = FIELDS.map(([shortname]) => shortname).filter(s => !p[s]);
  if (absent.length)
    throw new Error(
      `Set up this importer again: its config lacks the properties ${absent.join(', ')}`,
    );

  const { kept, pruned } = prune(decoded);
  const records: ImportRecord[] = [];
  let older = 0,
    unstored = 0;

  for (const entry of kept) {
    const identity = sourceId(entry);
    // A newer entry for the same key that is already in the table wins, as
    // it would in a Willow store.
    const stored = ctx
      .query(IMPORT_LOCAL_ID, identity)
      .map(subject => ctx.read(subject))
      .find(row => row[PARENT] === table);
    const storedTimestamp = stored?.[p['willow-timestamp']];
    const storedDigest = stored?.[p['willow-payload-digest']];
    const storedLength = stored?.[p['willow-payload-length']];

    if (
      typeof storedTimestamp === 'string' &&
      typeof storedDigest === 'string' &&
      typeof storedLength === 'string' &&
      /^\d+$/.test(storedTimestamp) &&
      /^\d+$/.test(storedLength) &&
      /^[0-9a-f]{64}$/.test(storedDigest) &&
      newer(
        {
          timestamp: BigInt(storedTimestamp),
          payloadDigest: Uint8Array.from(
            storedDigest.match(/../g)!.map(pair => parseInt(pair, 16)),
          ),
          payloadLength: BigInt(storedLength),
        },
        entry,
      )
    ) {
      older++;
      continue;
    }

    const values = rowValues(entry);
    if (values['willow-payload-status'] === 'too-large') unstored++;
    records.push({
      sourceId: identity,
      mode: 'merge',
      localId: `entry-${records.length}`,
      parent: table,
      isA: [rowClass],
      values: {
        [NAME]: values['willow-path'],
        ...Object.fromEntries(
          Object.entries(values).map(([shortname, value]) => [
            p[shortname],
            value,
          ]),
        ),
      },
    });
  }

  const result = importRecords(ctx, records);
  const notes = [
    `${decoded.length} entries decoded and verified (file read as ${encoding}). ${result.summary.unchanged} previously imported entries unchanged.`,
  ];
  if (pruned)
    notes.push(
      `${pruned} entries were left out because a newer entry in the same drop overwrites them (same path or a path prefix).`,
    );
  if (older)
    notes.push(
      `${older} entries were left out because the table already holds a newer entry at the same path.`,
    );
  if (unstored)
    notes.push(
      `${unstored} payloads are larger than ${MAX_STORED_PAYLOAD} bytes and were verified but not stored.`,
    );

  return {
    intents: result.intents,
    problems: [...result.problems, ...notes.map(warning)],
  };
}
