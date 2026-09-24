// @wc-ignore-file
// Type-only: plugin.ts bundles this file into the sandbox plugin.js, so it
// must not pull the lib's runtime in. Datatypes are therefore the literal
// URLs of `Datatype.DATE` and `Datatype.STRING`.
import type { Datatype, SchemaSpec } from '../../browser/lib/src/index.js';

const DATE = 'https://atomicdata.dev/datatypes/date' as Datatype;
const STRING = 'https://atomicdata.dev/datatypes/string' as Datatype;

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

  return {
    properties: [...fields, ...notes].map(([shortname, name, description]) => ({
      shortname,
      name,
      description,
      datatype: shortname.endsWith('-date') ? DATE : STRING,
    })),
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
    ],
  };
}
