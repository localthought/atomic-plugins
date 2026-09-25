// @wc-ignore-file
// Type-only: plugin.ts bundles this file into the sandbox plugin.js, so it
// must not pull the lib's runtime in. Datatypes are therefore the literal
// URLs of `Datatype.DATE` and `Datatype.STRING`.
import type { Datatype, SchemaSpec } from '../../browser/lib/src/index.js';

const DATE = 'https://atomicdata.dev/datatypes/date' as Datatype;
const STRING = 'https://atomicdata.dev/datatypes/string' as Datatype;

/**
 * Written by the importer on a Bank statement row, one per parsed statement:
 * what the Money app shows in its Imports tab and as closing balances.
 */
export const STATEMENT_FIELDS = [
  [
    'bank-period-start',
    'Period start',
    'Date of the statement opening balance.',
  ],
  ['bank-period-end', 'Period end', 'Date of the statement closing balance.'],
  [
    'bank-opening-balance',
    'Opening balance',
    'Exact signed decimal string: the booked balance the statement starts from.',
  ],
  [
    'bank-closing-balance',
    'Closing balance',
    'Exact signed decimal string: the booked balance the statement ends on, reconciled with its entries.',
  ],
  [
    'bank-entry-count',
    'Entries',
    'Number of booked entries in the statement, as a decimal string.',
  ],
  ['bank-format', 'Format', 'mt940 or camt053: the export format read.'],
  [
    'bank-imported-date',
    'Imported on',
    'The date this statement was first imported.',
  ],
] as const;

/**
 * The banking ontology, declared as the manifest's `destination.schema`: the
 * host creates it in the drive when the importer is set up.
 */
export function bankingSchema(): SchemaSpec {
  const fields = [
    [
      'bank-account',
      'Account',
      'Statement account identifier (MT940 field 25 or camt.053 Acct/Id); not necessarily an IBAN.',
    ],
    [
      'bank-currency',
      'Currency',
      'ISO 4217 currency code from the statement balance.',
    ],
    [
      'bank-amount',
      'Amount',
      'Exact signed decimal string in account currency. Negative is money out; positive is money in.',
    ],
    [
      'bank-value-date',
      'Value date',
      'Bank value date, without an inferred time zone.',
    ],
    [
      'bank-booking-date',
      'Booking date',
      'Booking date; value date when the statement omits it.',
    ],
    [
      'bank-description',
      'Description',
      'Original bank narrative: MT940 field 86 including its structured codes, or camt.053 counterparty and remittance information.',
    ],
    [
      'bank-reference',
      'Reference',
      'Bank reference, or customer reference if absent.',
    ],
    [
      'bank-transaction-code',
      'Transaction code',
      'Original transaction type code: the MT940 :61: code, or the camt.053 bank transaction code (domain/family/sub-family, or proprietary).',
    ],
    ['bank-statement', 'Statement', 'Source statement number and sequence.'],
    [
      'bank-source-id',
      'Source identity',
      'Account-qualified importer identity for repeat detection.',
    ],
    [
      'bank-fingerprint',
      'Import fingerprint',
      'Original imported transaction content used to detect conflicting reimports.',
    ],
  ];
  // The person's own annotations, edited in the Money app. The importer never
  // writes them, so a reimport leaves them alone.
  const notes = [
    [
      'money-category',
      'Category',
      'Your own category for this transaction, as free text. Never written by the importer.',
    ],
    [
      'money-note',
      'Note',
      'Your own note on this transaction. Never written by the importer.',
    ],
  ];

  const dated = new Set(['bank-period-start', 'bank-period-end']);

  return {
    properties: [...fields, ...notes, ...STATEMENT_FIELDS].map(
      ([shortname, name, description]) => ({
        shortname,
        name,
        description,
        datatype:
          shortname.endsWith('-date') || dated.has(shortname) ? DATE : STRING,
      }),
    ),
    classes: [
      {
        shortname: 'bank-transaction',
        name: 'Bank transaction',
        description:
          'A booked bank statement entry imported from an MT940 or camt.053 statement.',
        requires: [
          'bank-account',
          'bank-currency',
          'bank-amount',
          'bank-value-date',
          'bank-source-id',
        ],
        recommends: [...fields.slice(0, 9), ...notes].map(f => f[0]),
      },
      {
        shortname: 'bank-statement-record',
        name: 'Bank statement',
        description:
          'One imported MT940 or camt.053 statement: account, period and its reconciled opening and closing balances.',
        requires: [
          'bank-account',
          'bank-currency',
          'bank-period-start',
          'bank-period-end',
          'bank-opening-balance',
          'bank-closing-balance',
          'bank-source-id',
        ],
        recommends: [
          'bank-account',
          'bank-currency',
          'bank-statement',
          'bank-period-start',
          'bank-period-end',
          'bank-opening-balance',
          'bank-closing-balance',
          'bank-entry-count',
          'bank-format',
          'bank-imported-date',
        ],
      },
    ],
  };
}
