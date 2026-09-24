// @wc-ignore-file
/**
 * Exact-decimal display and arithmetic for bank amounts (DESIGN.md §5).
 * Amounts stay signed decimal strings end to end; sums go through the BigInt
 * `units()` helper the statement readers use (`../parser.ts`, five fractional
 * digits), and nothing here turns an amount into a `Number`
 * (`amounts.test.ts` checks the source).
 */
import { units } from '../parser.js';

const MINUS = '−';
const SCALE = 5;

/** Inverse of `units()`: 1e-5 units back to a trimmed decimal string. */
export function fromUnits(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(SCALE + 1, '0');
  const whole = digits.slice(0, -SCALE);
  const fraction = digits.slice(-SCALE).replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : whole;

  return negative && text !== '0' ? `-${text}` : text;
}

export const isOut = (amount: string) => units(amount) < 0n;

export const negate = (amount: string) => fromUnits(-units(amount));

export const addAmounts = (amounts: string[]) =>
  fromUnits(amounts.reduce((sum, a) => sum + units(a), 0n));

/** Minor units the currency uses (EUR 2, JPY 0, BHD 3); 2 when unknown. */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

let exactStrings: boolean | undefined;

/**
 * Whether this engine formats a numeric string as an exact decimal
 * (Intl.NumberFormat v3, ES2023) instead of coercing it to a float.
 */
export function formatsStringsExactly(): boolean {
  if (exactStrings === undefined)
    try {
      exactStrings =
        new Intl.NumberFormat('en-US', {
          maximumFractionDigits: 0,
          useGrouping: false,
        }).format('9007199254740993' as Intl.StringNumericLiteral) ===
        '9007199254740993';
    } catch {
      exactStrings = false;
    }

  return exactStrings;
}

interface Parts {
  negative: boolean;
  whole: string;
  fraction: string;
}

function split(amount: string): Parts {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match) throw new RangeError(`Not a decimal amount: ${amount}`);
  const whole = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');

  return {
    negative: match[1] === '-' && (/[1-9]/.test(whole) || fraction !== ''),
    whole,
    fraction,
  };
}

export interface FormatOptions {
  /** `always` (default): `+` for zero and up, `−` below; `negative`: only `−`. */
  sign?: 'always' | 'negative';
  /** `false` formats the number alone, for a column headed by the currency. */
  symbol?: boolean;
  /** Test hook: force the Intl string path or the BigInt fallback. */
  exact?: 'auto' | 'intl' | 'split';
}

/**
 * `"-850"`, `"EUR"` → `"−€850.00"`. At least the currency's minor units are
 * shown, and more when the amount has them: an amount is never rounded.
 */
export function formatAmount(
  amount: string,
  currency: string,
  locale?: string,
  { sign = 'always', symbol = true, exact = 'auto' }: FormatOptions = {},
): string {
  const parts = split(amount);
  const prefix = parts.negative ? MINUS : sign === 'always' ? '+' : '';
  const digits = currencyDigits(currency);
  const options: Intl.NumberFormatOptions = {
    ...(symbol ? { style: 'currency', currency } : {}),
    minimumFractionDigits: digits,
    maximumFractionDigits: larger(digits, parts.fraction.length),
  };
  const absolute = parts.fraction
    ? `${parts.whole}.${parts.fraction}`
    : parts.whole;

  try {
    const useIntl =
      exact === 'intl' || (exact === 'auto' && formatsStringsExactly());

    return (
      prefix +
      (useIntl
        ? new Intl.NumberFormat(locale, options).format(
            absolute as Intl.StringNumericLiteral,
          )
        : formatSplit(parts, options, locale))
    );
  } catch {
    // An unknown currency code: say it in plain text rather than guess.
    return `${prefix}${absolute} ${currency}`;
  }
}

/** Integer part through BigInt (always exact), fraction spliced in as text. */
function formatSplit(
  { whole, fraction }: Parts,
  options: Intl.NumberFormatOptions,
  locale?: string,
): string {
  const min = options.minimumFractionDigits ?? 0;
  const digits = fraction.padEnd(min, '0');
  const parts = new Intl.NumberFormat(locale, {
    ...options,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).formatToParts(BigInt(whole));
  const decimal =
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(BigInt(0))
      .find(p => p.type === 'decimal')?.value ?? '.';
  let lastInteger = -1;
  parts.forEach((p, i) => {
    if (p.type === 'integer' || p.type === 'group') lastInteger = i;
  });
  const out = parts.map(p => p.value);
  if (digits) out.splice(lastInteger + 1, 0, decimal + digits);

  return out.join('');
}

/** The larger of two digit counts. */
function larger(a: number, b: number): number {
  return a > b ? a : b;
}

/** Words for an `aria-label`: `"-84.30"`, `"EUR"` → `"minus 84 euro 30"`. */
export function amountLabel(
  amount: string,
  currency: string,
  locale = 'en',
): string {
  const { negative, whole, fraction } = split(amount);
  const signWord = negative ? 'minus' : 'plus';
  let name = currency;

  try {
    name =
      new Intl.DisplayNames(locale, { type: 'currency' }).of(currency) ??
      currency;
  } catch {
    // Keep the code.
  }

  name = name.toLowerCase();
  const grouped = new Intl.NumberFormat(locale).format(BigInt(whole));
  const digits = currencyDigits(currency);
  if (!fraction) return `${signWord} ${grouped} ${name}`;
  if (fraction.length > digits)
    return `${signWord} ${grouped}.${fraction} ${name}`;

  return `${signWord} ${grouped} ${name} ${BigInt(fraction.padEnd(digits, '0')).toString()}`;
}

export interface Money {
  currency: string;
  amount: string;
}

export interface Totals {
  account: string;
  currency: string;
  /** Sum of money in (zero or more). */
  in: string;
  /** Sum of money out (zero or less). */
  out: string;
  net: string;
  count: number;
}

/** In, out and net per account + currency, in first-seen order. */
export function totals(
  rows: { account: string; currency: string; amount: string }[],
): Totals[] {
  const map = new Map<
    string,
    {
      account: string;
      currency: string;
      in: bigint;
      out: bigint;
      count: number;
    }
  >();

  for (const row of rows) {
    const key = `${row.account}\u0000${row.currency}`;
    let entry = map.get(key);

    if (!entry) {
      entry = {
        account: row.account,
        currency: row.currency,
        in: 0n,
        out: 0n,
        count: 0,
      };
      map.set(key, entry);
    }

    const value = units(row.amount);
    if (value < 0n) entry.out += value;
    else entry.in += value;
    entry.count++;
  }

  return [...map.values()].map(e => ({
    account: e.account,
    currency: e.currency,
    in: fromUnits(e.in),
    out: fromUnits(e.out),
    net: fromUnits(e.in + e.out),
    count: e.count,
  }));
}

/** Net per currency, currencies sorted by code. Never summed across them. */
export function sumByCurrency(
  rows: { currency: string; amount: string }[],
): Money[] {
  const map = new Map<string, bigint>();
  for (const row of rows)
    map.set(row.currency, (map.get(row.currency) ?? 0n) + units(row.amount));

  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, sum]) => ({ currency, amount: fromUnits(sum) }));
}

export interface Day<T> {
  /** ISO date. */
  date: string;
  rows: T[];
  net: Money[];
}

/** Rows by booking date, newest day first; rows keep their order within a day. */
export function groupByDay<
  T extends { bookingDate: string; currency: string; amount: string },
>(rows: T[]): Day<T>[] {
  const map = new Map<string, T[]>();

  for (const row of rows) {
    const list = map.get(row.bookingDate);
    if (list) list.push(row);
    else map.set(row.bookingDate, [row]);
  }

  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => ({ date, rows: list, net: sumByCurrency(list) }));
}
