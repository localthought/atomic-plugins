// @wc-ignore-file
/**
 * Statement errors with a stable code and the data a UI needs to explain
 * them (DESIGN.md 6.4–6.5, gap 4). The message text is unchanged from the
 * plain `Error`s these replace: the host shows `message`, and the Money app
 * reads `code` and `data`. Bundled into the sandbox `plugin.js`, so no
 * runtime imports.
 */

export interface Period {
  start: string;
  end: string;
}

export interface StatementErrorData {
  /** Opening + Σ entries ≠ closing. Amounts are exact decimal strings. */
  BALANCE_MISMATCH: {
    statement: string;
    account: string;
    currency: string;
    opening: string;
    entries: number;
    entriesSum: string;
    expectedClosing: string;
    closing: string;
    start: string;
    end: string;
  };
  /** A reference-free row whose content matches an earlier import. */
  OVERLAP_WITHOUT_REFERENCES: {
    statement: string;
    account: string;
    thisPeriod: Period;
    /** Value date of the earlier row with the same content. */
    overlappingDate: string;
  };
  /** The same bank reference twice in one file, same content. */
  REPEATED_REFERENCE: { reference: string };
  /** The same bank reference twice in one file, different content. */
  CONFLICTING_REFERENCE: { reference: string };
  /** Narratives that legacy storage would reinterpret as JSON. */
  JSON_NARRATIVE: { count: number };
  /** A field or element the reader cannot use. `line` is 1-based (MT940). */
  INVALID_FIELD: { tag: string; line?: number };
  /** Over the reader's size limit, in characters. */
  FILE_TOO_LARGE: { limit: number; format: 'mt940' | 'camt053' };
  /** More booked entries than one import takes. */
  TOO_MANY_ENTRIES: { limit: number };
  /** Opening or closing balance missing, or the file ends mid-statement. */
  MISSING_BALANCE: { statement?: string };
  /** Not something either reader recognises. */
  NOT_A_STATEMENT: Record<string, never>;
}

export type StatementErrorCode = keyof StatementErrorData;

export class StatementError<
  C extends StatementErrorCode = StatementErrorCode,
> extends Error {
  readonly code: C;
  readonly data: StatementErrorData[C];

  constructor(code: C, message: string, data: StatementErrorData[C]) {
    super(message);
    this.name = 'StatementError';
    this.code = code;
    this.data = data;
  }
}

export const statementError = <C extends StatementErrorCode>(
  code: C,
  message: string,
  data: StatementErrorData[C],
) => new StatementError(code, message, data);

export function isStatementError(error: unknown): error is StatementError {
  return error instanceof StatementError;
}
