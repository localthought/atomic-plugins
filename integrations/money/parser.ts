// @wc-ignore-file
import { StatementError, statementError } from './errors.js';

export interface Transaction {
  date: string;
  bookingDate: string;
  amount: string;
  code: string;
  reference: string;
  bankReference: string;
  description: string;
}
export interface Statement {
  account: string;
  number: string;
  currency: string;
  opening: string;
  closing: string;
  start: string;
  end: string;
  transactions: Transaction[];
}
// Fixed-point decimal strings keep bank amounts exact, including non-EUR scales.
export function decimal(raw: string, negative = false): string {
  if (!/^\d{1,15},\d{0,5}$/.test(raw)) throw new Error('Invalid MT940 amount');
  const [whole, fraction = ''] = raw.split(',');
  const value = `${whole.replace(/^0+(?=\d)/, '')}${fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : ''}`;

  return negative && value !== '0' ? '-' + value : value;
}
export function units(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');

  return BigInt(whole + fraction.padEnd(5, '0')) * (negative ? -1n : 1n);
}

function date(raw: string): string {
  const year = Number(raw.slice(0, 2));
  const full = year >= 70 ? 1900 + year : 2000 + year;
  const result = `${full}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
  const parsed = new Date(result + 'T00:00:00Z');
  if (
    !/^\d{6}$/.test(raw) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  )
    throw new Error('Invalid MT940 date');

  return result;
}

function balance(value: string) {
  const match = value.match(/^([CD])(\d{6})([A-Z]{3})(\d+,\d*)$/);
  if (!match) throw new Error('Invalid MT940 balance');

  return {
    date: date(match[2]),
    currency: match[3],
    amount: decimal(match[4], match[1] === 'D'),
  };
}

function transaction(value: string): Transaction {
  const [line, ...extra] = value.split('\n');
  const match = line.match(
    /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([NSF][A-Z0-9]{3})(.*)$/,
  );
  if (!match) throw new Error('Unsupported MT940 transaction line');
  const valueDate = date(match[1]);
  let bookingDate = valueDate;

  if (match[2]) {
    const valueYear = Number(valueDate.slice(0, 4));
    const month = Number(match[2].slice(0, 2));
    const valueMonth = Number(valueDate.slice(5, 7));
    const year =
      valueYear +
      (month - valueMonth > 6 ? -1 : valueMonth - month > 6 ? 1 : 0);
    bookingDate = date(String(year % 100).padStart(2, '0') + match[2]);
  }

  const [reference, bankReference = '', ...unexpected] = match[7].split('//');
  if (!reference || unexpected.length)
    throw new Error('Invalid MT940 transaction reference');

  return {
    date: valueDate,
    bookingDate,
    amount: decimal(match[5], match[3] === 'D' || match[3] === 'RC'),
    code: match[6],
    reference,
    bankReference,
    description: extra.join('\n'),
  };
}

export function parseMT940(text: string): Statement[] {
  if (typeof text !== 'string' || text.length > 512_000)
    throw statementError(
      'FILE_TOO_LARGE',
      'Choose an MT940 file smaller than 512 KB',
      { limit: 512_000, format: 'mt940' },
    );
  const normalized = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const fields: Array<{ tag: string; value: string; line: number }> = [];

  for (const [index, line] of normalized.split('\n').entries()) {
    if (/^(?:\{1:.*\{4:|\{4:| -\}|-\}|\{5:.*\})$/.test(line)) continue;
    const match = line.match(/^:(\d{2}[A-Z]?):(.*)$/);

    if (match) fields.push({ tag: match[1], value: match[2], line: index + 1 });
    else if (line.trim()) {
      const previous = fields[fields.length - 1];
      if (!previous || !['61', '86'].includes(previous.tag))
        throw statementError(
          'INVALID_FIELD',
          'Unsupported MT940 header or field continuation',
          { tag: previous?.tag ?? 'header', line: index + 1 },
        );
      previous.value += '\n' + line;
    }
  }

  const statements: Statement[] = [];
  let account = '',
    number = '',
    current: Statement | undefined;
  let closed = true,
    count = 0;

  for (const { tag, value, line } of fields) {
    try {
      field(tag, value);
    } catch (error) {
      // Field-level problems name the field and its line.
      if (error instanceof StatementError || !(error instanceof Error))
        throw error;
      throw statementError('INVALID_FIELD', error.message, { tag, line });
    }
  }

  function field(tag: string, value: string) {
    switch (tag) {
      case '20':
        if (!closed)
          throw statementError(
            'MISSING_BALANCE',
            'Statement is missing its closing balance',
            { statement: number },
          );
        account = '';
        number = '';
        current = undefined;
        break;
      case '21':
        break;
      case '25':
        if (!closed) throw new Error('Unexpected account inside a statement');
        account = value.trim();
        if (!account) throw new Error('Missing bank account');
        break;
      case '28':
      case '28C':
        if (!closed) throw new Error('Unexpected statement number');
        number = value.trim();
        break;
      case '60F':

      case '60M': {
        if (!closed || !account || !number)
          throw new Error('Missing or out-of-order MT940 statement fields');
        const opening = balance(value);
        current = {
          account,
          number,
          currency: opening.currency,
          opening: opening.amount,
          closing: '',
          start: opening.date,
          end: '',
          transactions: [],
        };
        statements.push(current);
        closed = false;
        break;
      }

      case '61':
        if (!current || closed)
          throw new Error('Transaction outside an open statement');
        if (++count > 500)
          throw statementError(
            'TOO_MANY_ENTRIES',
            'Import at most 500 transactions at a time; export a shorter period',
            { limit: 500 },
          );
        current.transactions.push(transaction(value));
        break;

      case '86': {
        if (!current || closed)
          throw new Error('Unsupported statement-level narrative');
        const row = current.transactions[current.transactions.length - 1];
        if (!row) throw new Error('Narrative without a transaction');
        row.description = [row.description, value].filter(Boolean).join('\n');
        break;
      }

      case '62F':

      case '62M': {
        if (!current || closed)
          throw new Error('Closing balance without an open statement');
        const closing = balance(value);
        if (
          closing.currency !== current.currency ||
          closing.date < current.start
        )
          throw new Error('Statement currency or date range is inconsistent');
        reconcile(current, closing.amount, closing.date);
        current.closing = closing.amount;
        current.end = closing.date;
        closed = true;
        break;
      }

      case '64':
      case '65':
        balance(value);
        break;
      default:
        throw new Error(`Unsupported MT940 field :${tag}:`);
    }
  }

  if (!statements.length || !closed)
    throw statementError(
      'MISSING_BALANCE',
      'Incomplete MT940 statement: opening and closing balances are required',
      { statement: number || undefined },
    );
  rejectJsonNarratives(statements);

  return statements;
}

/** `units()` back to a decimal string, for error data. */
function decimalOf(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(6, '0');
  const fraction = digits.slice(-5).replace(/0+$/, '');
  const text = digits.slice(0, -5) + (fraction ? `.${fraction}` : '');

  return negative ? `-${text}` : text;
}

/** Opening + Σ entries must equal the closing balance, exactly. */
export function reconcile(
  statement: Statement,
  closing: string,
  end: string,
): void {
  const sum = statement.transactions.reduce(
    (total, row) => total + units(row.amount),
    0n,
  );
  const expected = units(statement.opening) + sum;
  if (expected === units(closing)) return;
  throw statementError(
    'BALANCE_MISMATCH',
    'Statement balance does not reconcile; no transactions will be imported',
    {
      statement: statement.number,
      account: statement.account,
      currency: statement.currency,
      opening: statement.opening,
      entries: statement.transactions.length,
      entriesSum: decimalOf(sum),
      expectedClosing: decimalOf(expected),
      closing,
      start: statement.start,
      end,
    },
  );
}
// Current Atomic legacy materialization interprets JSON-shaped strings as
// resources. Refuse these rare narratives instead of corrupting bank text.
export function rejectJsonNarratives(statements: Statement[]): void {
  let count = 0;

  for (const statement of statements)
    for (const row of statement.transactions) {
      const narrative = row.description.trim();

      if (narrative.startsWith('[') || narrative.startsWith('{')) {
        let parsed: unknown;

        try {
          parsed = JSON.parse(narrative);
        } catch {
          continue;
        }

        if (parsed && typeof parsed === 'object') count++;
      }
    }

  if (count)
    throw statementError(
      'JSON_NARRATIVE',
      'JSON-shaped bank narratives are not supported yet; the statement was not imported',
      { count },
    );
}
