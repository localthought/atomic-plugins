// @wc-ignore-file
/**
 * Import identities and content fingerprints for parsed statements: what
 * `plugin.ts` stores as `bank-source-id` and `bank-fingerprint`, and what the
 * Money app compares a file against before anything is imported. One
 * function for both, so the app's preview cannot drift from the importer.
 */
import { statementError } from './errors.js';
import type { Statement, Transaction } from './parser.js';
import type { StatementFormat } from './statement.js';

export interface Entry {
  statement: Statement;
  row: Transaction;
  /** Position within its statement. */
  index: number;
  /** Account-qualified importer identity (`bank-source-id`). */
  identity: string;
  /** Original imported content (`bank-fingerprint`). */
  fingerprint: string;
  /** The bank's reference, or `''` when it has none (identity by position). */
  reference: string;
}

/**
 * Identities are per export format: the same booking exported twice as MT940
 * and camt.053 carries different narratives, which would otherwise surface as
 * a conflict instead of a second row. Without a bank reference, statement
 * metadata and line position identify a row. A reference that appears twice
 * in one file is refused.
 */
export function entries(
  format: StatementFormat,
  statements: Statement[],
): Entry[] {
  const out: Entry[] = [];
  const seen = new Map<string, string>();

  for (const statement of statements) {
    const statementKey = JSON.stringify([
      statement.number,
      statement.start,
      statement.end,
      statement.opening,
      statement.closing,
    ]);

    for (const [index, row] of statement.transactions.entries()) {
      const fingerprint =
        `${format}-content:` +
        JSON.stringify([
          statement.account,
          statement.currency,
          row.date,
          row.bookingDate,
          row.amount,
          row.code,
          row.reference,
          row.description,
        ]);
      const reference =
        row.bankReference && row.bankReference !== 'NONREF'
          ? row.bankReference
          : '';
      const identity = JSON.stringify([
        format,
        statement.account,
        statement.currency,
        reference ? ['bank', reference] : ['statement', statementKey, index],
      ]);

      if (seen.has(identity)) {
        if (seen.get(identity) !== fingerprint)
          throw statementError(
            'CONFLICTING_REFERENCE',
            'Conflicting bank transaction references in this file',
            { reference },
          );
        throw statementError(
          'REPEATED_REFERENCE',
          'Repeated bank transaction reference in this file; export non-overlapping statements',
          { reference },
        );
      }

      seen.set(identity, fingerprint);
      out.push({ statement, row, index, identity, fingerprint, reference });
    }
  }

  return out;
}

export const OVERLAP_MESSAGE =
  'This statement overlaps an earlier import without unique bank references. Use the original statement or export a non-overlapping period.';
