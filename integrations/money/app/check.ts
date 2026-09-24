// @wc-ignore-file
/**
 * Checks a statement file in the browser before anything is imported
 * (DESIGN.md 6.2–6.5): the same readers and identity rules as the sandbox
 * importer (`../statement.ts`, `../identity.ts`), compared against the rows
 * already in the table. Pure and DOM-free.
 */
import { CAMT053_MAX_BYTES } from '../camt053.js';
import {
  isStatementError,
  type StatementErrorCode,
  type StatementErrorData,
} from '../errors.js';
import { entries, OVERLAP_MESSAGE, type Entry } from '../identity.js';
import type { Statement } from '../parser.js';
import {
  detectStatementFormat,
  parseBankStatement,
  type StatementFormat,
} from '../statement.js';
import type { Txn } from './rows.js';

export interface FileInfo {
  name: string;
  size: number;
  format?: StatementFormat;
}

/** A row of the file as the preview lists it. */
export interface FileRow {
  date: string;
  account: string;
  currency: string;
  amount: string;
  description: string;
  reference: string;
}

export interface Changed {
  mine: Txn;
  file: FileRow;
  /** Which of date, amount, description, account differ. */
  fields: ('date' | 'amount' | 'description' | 'account')[];
}

export type ProblemCode =
  | StatementErrorCode
  | 'CHANGED_TRANSACTION'
  | 'UNKNOWN';

export interface Problem {
  code: ProblemCode;
  /** The reader's own message, for Technical details. */
  message: string;
  data?: StatementErrorData[StatementErrorCode];
  /** For CHANGED_TRANSACTION: the first changed row, and how many there are. */
  changed?: Changed;
  count?: number;
}

/** Cases the design shows as "Blocked" (6.5) rather than "Import failed" (6.4). */
export const BLOCKING: ProblemCode[] = [
  'CHANGED_TRANSACTION',
  'OVERLAP_WITHOUT_REFERENCES',
  'REPEATED_REFERENCE',
  'CONFLICTING_REFERENCE',
  'FILE_TOO_LARGE',
  'TOO_MANY_ENTRIES',
  'JSON_NARRATIVE',
];

export const isBlocked = (problem: Problem) => BLOCKING.includes(problem.code);

export interface Preview {
  format: StatementFormat;
  statements: Statement[];
  fresh: FileRow[];
  already: FileRow[];
  /** Transactions without a bank reference: identified by position. */
  withoutReference: number;
}

export type Check =
  | { ok: true; preview: Preview }
  | { ok: false; problem: Problem };

/** UTF-8 when it decodes as such, else Windows-1252, as the host does. */
export function decodeStatement(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Refused before reading: larger than any reader takes. */
export function tooLarge(size: number): Problem | undefined {
  if (size <= CAMT053_MAX_BYTES) return undefined;

  return {
    code: 'FILE_TOO_LARGE',
    message: 'Choose a camt.053 file smaller than 5 MB',
    data: { limit: CAMT053_MAX_BYTES, format: 'camt053' },
  };
}

export const formatOfText = (text: string) => detectStatementFormat(text);

export function problemOf(error: unknown): Problem {
  if (isStatementError(error))
    return { code: error.code, message: error.message, data: error.data };

  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  };
}

const fileRow = ({ statement, row }: Entry): FileRow => ({
  date: row.bookingDate,
  account: statement.account,
  currency: statement.currency,
  amount: row.amount,
  description: row.description,
  reference: row.bankReference || row.reference,
});

/** Step 1 and 2: read the file; the readers reconcile every statement. */
export function read(
  text: string,
):
  | { ok: true; format: StatementFormat; statements: Statement[] }
  | { ok: false; problem: Problem } {
  try {
    return { ok: true, ...parseBankStatement(text) };
  } catch (error) {
    return { ok: false, problem: problemOf(error) };
  }
}

/**
 * Step 3: compare with the table, the way the importer will. Same identity
 * and same content: already imported. Same identity, other content: the
 * importer blocks the whole file. No reference and content an earlier
 * import already has: the importer refuses the overlap.
 */
export function compare(
  format: StatementFormat,
  statements: Statement[],
  existing: Txn[],
): Check {
  let list: Entry[];

  try {
    list = entries(format, statements);
  } catch (error) {
    return { ok: false, problem: problemOf(error) };
  }

  const bySource = new Map(existing.map(row => [row.sourceId, row]));
  const byFingerprint = new Map(existing.map(row => [row.fingerprint, row]));
  const fresh: FileRow[] = [];
  const already: FileRow[] = [];
  const changed: Changed[] = [];
  let withoutReference = 0;

  for (const entry of list) {
    if (!entry.reference) withoutReference++;
    const mine = bySource.get(entry.identity);
    const row = fileRow(entry);

    if (mine) {
      if (!mine.fingerprint || mine.fingerprint === entry.fingerprint)
        already.push(row);
      else changed.push({ mine, file: row, fields: differences(mine, row) });
      continue;
    }

    const earlier = entry.reference
      ? undefined
      : byFingerprint.get(entry.fingerprint);

    if (earlier)
      return {
        ok: false,
        problem: {
          code: 'OVERLAP_WITHOUT_REFERENCES',
          message: OVERLAP_MESSAGE,
          data: {
            statement: entry.statement.number,
            account: entry.statement.account,
            thisPeriod: {
              start: entry.statement.start,
              end: entry.statement.end,
            },
            overlappingDate: earlier.valueDate,
          },
        },
      };

    fresh.push(row);
  }

  if (changed.length)
    return {
      ok: false,
      problem: {
        code: 'CHANGED_TRANSACTION',
        message: `${changed.length} imported transaction(s) differ from this file`,
        changed: changed[0],
        count: changed.length,
      },
    };

  const newestFirst = (a: FileRow, b: FileRow) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0;

  return {
    ok: true,
    preview: {
      format,
      statements,
      fresh: fresh.sort(newestFirst),
      already: already.sort(newestFirst),
      withoutReference,
    },
  };
}

function differences(mine: Txn, file: FileRow): Changed['fields'] {
  const fields: Changed['fields'] = [];
  if (mine.bookingDate !== file.date) fields.push('date');
  if (mine.amount !== file.amount) fields.push('amount');
  if (mine.description !== file.description) fields.push('description');
  if (mine.account !== file.account) fields.push('account');

  return fields;
}
