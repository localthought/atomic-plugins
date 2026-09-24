// @wc-ignore-file
import {
  importRecords,
  type ImportRecord,
} from '../../browser/lib/src/import-records.js';
import { CAMT053_MAX_BYTES } from './camt053.js';
import { statementError } from './errors.js';
import { entries, OVERLAP_MESSAGE } from './identity.js';
import { bankingSchema } from './schema.js';
import { parseBankStatement } from './statement.js';

export const manifest = {
  schemaVersion: 2,
  name: 'bank-statements',
  namespace: 'atomic-plugins',
  version: '0.2.0',
  description:
    'Import bank transactions from MT940 and camt.053 statement exports.',
  operations: [],
  secrets: [],
  // The host checks this before starting the sandbox, so an importer installed
  // without a destination pauses on the field to set.
  config: {
    key: 'money',
    properties: {
      table: {
        type: 'string',
        description: 'Table the transactions are written to',
      },
      rowClass: {
        type: 'string',
        description: 'Class each imported transaction gets',
      },
      properties: {
        type: 'object',
        description: 'Banking ontology properties, by shortname',
      },
    },
    required: ['table', 'rowClass', 'properties'],
  },
  // The host draws the file picker and hands the decoded text over as
  // `ctx.upload` (atomic-server#1653). 5 MB is the camt.053 limit; MT940 files
  // stop at 512 KB in parser.ts.
  accepts: [
    {
      extensions: ['.mt940', '.sta', '.940', '.txt', '.xml', '.camt', '.053'],
      mediaTypes: ['text/plain', 'application/xml', 'text/xml'],
      as: 'text',
      maxBytes: CAMT053_MAX_BYTES,
    },
  ],
  // Created by the host's Set up step, which stores the result as `config`.
  destination: {
    schema: bankingSchema(),
    table: {
      name: 'Bank transactions',
      rowClass: 'bank-transaction',
      columns: [
        'bank-booking-date',
        'bank-description',
        'bank-amount',
        'bank-currency',
        'bank-account',
        'bank-reference',
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
  /** What the host hands over for a declared `accepts` file. */
  upload?: { name?: string; mediaType?: string; size?: number; text?: string };
  text?: string;
  trigger?: { payload?: { text?: string; validate?: boolean } };
  config?: Config;
  query(property: string, value: string): string[];
  read(subject: string): Record<string, unknown>;
}

export function run(ctx: Host) {
  // `ctx.text` and `trigger.payload.text` are what the removed host dialog
  // (atomic-server 4bab16ee6^) passed; kept for one release.
  const text = ctx.upload?.text ?? ctx.text ?? ctx.trigger?.payload?.text;
  if (!text)
    throw new Error(
      "Choose an MT940 or camt.053 file under Import on this importer's page",
    );
  const { format, statements } = parseBankStatement(text);
  if (ctx.trigger?.payload?.validate) return { intents: [], problems: [] };
  // Absent config reads as a configuration problem, never a TypeError.
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
  const records: ImportRecord[] = [];
  let fallback = 0;
  const inTable = (subject: string) =>
    ctx.read(subject)['https://atomicdata.dev/properties/parent'] === table;

  for (const entry of entries(format, statements)) {
    const { statement, row, identity, fingerprint, reference } = entry;

    if (!reference) {
      fallback++;
      const earlier = ctx
        .query(p['bank-fingerprint'], fingerprint)
        .filter(inTable);

      if (
        earlier.length &&
        !ctx.query(p['bank-source-id'], identity).some(inTable)
      )
        throw statementError('OVERLAP_WITHOUT_REFERENCES', OVERLAP_MESSAGE, {
          statement: statement.number,
          account: statement.account,
          thisPeriod: { start: statement.start, end: statement.end },
          overlappingDate: String(
            ctx.read(earlier[0])[p['bank-value-date']] ?? '',
          ),
        });
    }

    const values: Record<string, string> = {
      'https://atomicdata.dev/properties/name':
        row.description || row.reference,
      [p['bank-account']]: statement.account,
      [p['bank-currency']]: statement.currency,
      [p['bank-amount']]: row.amount,
      [p['bank-value-date']]: row.date,
      [p['bank-booking-date']]: row.bookingDate,
      [p['bank-description']]: row.description,
      [p['bank-reference']]: row.bankReference || row.reference,
      [p['bank-transaction-code']]: row.code,
      [p['bank-statement']]: statement.number,
      [p['bank-source-id']]: identity,
      [p['bank-fingerprint']]: fingerprint,
    };
    records.push({
      sourceId: identity,
      mode: 'append',
      legacy: { property: p['bank-source-id'], value: identity },
      localId: `transaction-${records.length}`,
      parent: table,
      isA: [rowClass],
      values,
    });
  }

  const result = importRecords(ctx, records);

  return {
    intents: result.intents,
    problems: [
      ...result.problems,
      {
        severity: 'warning',
        message: `${statements.length} statements reconciled. ${result.summary.unchanged} previously imported transactions skipped. Amounts are exact decimal strings; negative amounts are money out.`,
      },
      ...(fallback
        ? [
            {
              severity: 'warning',
              message:
                'Some transactions lack unique bank references. Reimporting the same statement is safe; ambiguous overlapping exports are blocked.',
            },
          ]
        : []),
    ],
  };
}
