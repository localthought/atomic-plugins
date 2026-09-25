// @wc-ignore-file
/**
 * Dates and account identifiers for display. Dates are ISO calendar dates
 * without a time zone (`../parser.ts`), so they are formatted in UTC to keep
 * the day from shifting. Account identifiers are not assumed to be IBANs
 * (DESIGN.md gap 8): only something shaped like one is grouped in fours.
 */
import { periodRange, type Period } from './ledger.js';

const utc = (iso: string) =>
  new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));

const fmt = (locale: string | undefined, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options });

/** "Tue 22 Sep" */
export const dayLabel = (iso: string, locale?: string) =>
  fmt(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(
    utc(iso),
  );

/** "22 Sep" */
export const shortDate = (iso: string, locale?: string) =>
  fmt(locale, { day: 'numeric', month: 'short' }).format(utc(iso));

/** "22 Sep 2026" */
export const fullDate = (iso: string, locale?: string) =>
  fmt(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(
    utc(iso),
  );

/** "Tue 22 Sep 2026" */
export const longDate = (iso: string, locale?: string) =>
  fmt(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(utc(iso));

/** "1 Sep – 22 Sep 2026" */
export function rangeLabel(from: string, to: string, locale?: string): string {
  if (from === to) return fullDate(from, locale);
  const f = fmt(locale, { day: 'numeric', month: 'short', year: 'numeric' });

  return f.formatRange(utc(from), utc(to));
}

/** "September 2026", "2026", "1 Sep – 22 Sep 2026", "all periods". */
export function periodLabel(
  period: Period,
  today: string,
  locale?: string,
): string {
  switch (period.kind) {
    case 'all':
      return 'all periods';
    case 'this-month':

    case 'last-month': {
      const { from } = periodRange(period, today);

      return fmt(locale, { month: 'long', year: 'numeric' }).format(utc(from!));
    }

    case 'this-year':
      return today.slice(0, 4);
    case 'custom':
      if (period.from && period.to)
        return rangeLabel(period.from, period.to, locale);
      if (period.from) return `from ${fullDate(period.from, locale)}`;
      if (period.to) return `until ${fullDate(period.to, locale)}`;

      return 'all periods';
  }
}

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/;

const BANKS: Record<string, string> = {
  BUNQ: 'bunq',
  RABO: 'Rabo',
  INGB: 'ING',
  ABNA: 'ABN AMRO',
  KNAB: 'Knab',
  TRIO: 'Triodos',
  ASNB: 'ASN',
  SNSB: 'SNS',
  RBRB: 'RegioBank',
};

const fours = (text: string) => text.replace(/(.{4})(?=.)/g, '$1 ');

/** "NL42BUNQ0123456789" → "NL42 BUNQ 0123 4567 89"; others unchanged. */
export function groupAccount(account: string): string {
  const compact = account.replace(/\s+/g, '');

  return IBAN.test(compact) ? fours(compact) : account;
}

/** "NL42BUNQ0123456789" → "bunq …4567 89": bank, then the last six. */
export function shortAccount(account: string): string {
  const compact = account.replace(/\s+/g, '');
  if (compact.length <= 10) return account;
  const tail = compact.slice(-6);
  const last = `…${tail.slice(0, 4)} ${tail.slice(4)}`;
  if (!IBAN.test(compact)) return last;
  const bank = compact.slice(4, 8);
  const name = BANKS[bank] ?? (/^[A-Z]{4}$/.test(bank) ? bank : '');

  return name ? `${name} ${last}` : last;
}

export const formatLabel = (format?: string) =>
  format === 'camt053' ? 'camt.053' : format === 'mt940' ? 'MT940' : '';

export const kilobytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const count = (n: number, locale?: string) =>
  new Intl.NumberFormat(locale).format(n);

export const plural = (n: number, one: string, many: string, locale?: string) =>
  `${count(n, locale)} ${n === 1 ? one : many}`;
