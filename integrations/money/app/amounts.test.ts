// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addAmounts,
  amountLabel,
  currencyDigits,
  formatAmount,
  fromUnits,
  groupByDay,
  isOut,
  negate,
  sumByCurrency,
  totals,
} from './amounts.js';

const MINUS = '−';
const both = ['intl', 'split'] as const;

describe('formatAmount: exact decimal display', () => {
  for (const exact of both)
    describe(`${exact} path`, () => {
      const f = (
        amount: string,
        currency = 'EUR',
        options: Parameters<typeof formatAmount>[3] = {},
      ) => formatAmount(amount, currency, 'en-GB', { exact, ...options });

      it('signs money in with + and money out with a true minus', () => {
        expect(f('2420')).toBe('+€2,420.00');
        expect(f('-850')).toBe(`${MINUS}€850.00`);
        expect(f('-84.3')).toBe(`${MINUS}€84.30`);
        expect(f('0')).toBe('+€0.00');
        expect(f('7921.95', 'EUR', { sign: 'negative' })).toBe('€7,921.95');
        expect(f('-5', 'EUR', { sign: 'negative' })).toBe(`${MINUS}€5.00`);
      });

      it('never rounds through a float', () => {
        expect(f('12345678901234.56789')).toBe('+€12,345,678,901,234.56789');
        expect(f('9007199254740993')).toBe('+€9,007,199,254,740,993.00');
        expect(f('-0.00001')).toBe(`${MINUS}€0.00001`);
        expect(f('0.1')).toBe('+€0.10');
      });

      it('uses each currency’s own minor units', () => {
        expect(f('-1200', 'JPY')).toBe(`${MINUS}JP¥1,200`);
        expect(f('1.25', 'BHD')).toBe('+BHD 1.250');
        expect(f('1.2345', 'BHD')).toBe('+BHD 1.2345');
      });

      it('can leave the symbol out (the currency sits in a header)', () => {
        expect(f('-850', 'EUR', { symbol: false })).toBe(`${MINUS}850.00`);
        expect(f('2420', 'EUR', { symbol: false })).toBe('+2,420.00');
      });

      it('formats in the given locale', () => {
        expect(
          formatAmount('-1850.5', 'EUR', 'nl-NL', { exact, sign: 'negative' }),
        ).toBe(`${MINUS}€ 1.850,50`);
      });
    });

  it('falls back to plain text for a code Intl refuses', () => {
    expect(formatAmount('-12.5', 'XX1', 'en-GB')).toBe(`${MINUS}12.5 XX1`);
  });

  it('knows minor units per currency', () => {
    expect(currencyDigits('EUR')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('BHD')).toBe(3);
  });
});

describe('amountLabel: words for aria-label', () => {
  it('reads sign, whole units, currency and minor units', () => {
    expect(amountLabel('-84.30', 'EUR', 'en')).toBe('minus 84 euro 30');
    expect(amountLabel('1250', 'EUR', 'en')).toBe('plus 1,250 euro');
    expect(amountLabel('-850.00', 'EUR', 'en')).toBe('minus 850 euro');
    expect(amountLabel('84.05', 'EUR', 'en')).toBe('plus 84 euro 5');
    expect(amountLabel('-1200', 'JPY', 'en')).toBe('minus 1,200 japanese yen');
    expect(amountLabel('-0.00001', 'EUR', 'en')).toBe('minus 0.00001 euro');
  });
});

describe('arithmetic on exact strings', () => {
  it('adds, negates and converts without floats', () => {
    expect(addAmounts(['0.1', '0.2'])).toBe('0.3');
    expect(addAmounts(['-850', '-23.47'])).toBe('-873.47');
    expect(addAmounts([])).toBe('0');
    expect(negate('-12.5')).toBe('12.5');
    expect(negate('0')).toBe('0');
    expect(fromUnits(-100001n)).toBe('-1.00001');
    expect(isOut('-0.01')).toBe(true);
    expect(isOut('0')).toBe(false);
  });

  it('totals per account and currency, never across currencies', () => {
    const rows = [
      { account: 'A', currency: 'EUR', amount: '-850' },
      { account: 'A', currency: 'EUR', amount: '2420' },
      { account: 'A', currency: 'USD', amount: '-29' },
      { account: 'B', currency: 'EUR', amount: '-1312' },
    ];
    expect(totals(rows)).toEqual([
      {
        account: 'A',
        currency: 'EUR',
        in: '2420',
        out: '-850',
        net: '1570',
        count: 2,
      },
      {
        account: 'A',
        currency: 'USD',
        in: '0',
        out: '-29',
        net: '-29',
        count: 1,
      },
      {
        account: 'B',
        currency: 'EUR',
        in: '0',
        out: '-1312',
        net: '-1312',
        count: 1,
      },
    ]);
    expect(sumByCurrency(rows)).toEqual([
      { currency: 'EUR', amount: '258' },
      { currency: 'USD', amount: '-29' },
    ]);
  });

  it('groups by booking date, newest first, with a net per currency', () => {
    const rows = [
      { id: 1, bookingDate: '2026-09-16', currency: 'EUR', amount: '-1312' },
      { id: 2, bookingDate: '2026-09-22', currency: 'EUR', amount: '-850' },
      { id: 3, bookingDate: '2026-09-16', currency: 'EUR', amount: '318.20' },
      { id: 4, bookingDate: '2026-09-22', currency: 'EUR', amount: '-23.47' },
      { id: 5, bookingDate: '2026-09-16', currency: 'USD', amount: '-29' },
    ];
    const days = groupByDay(rows);
    expect(days.map(d => d.date)).toEqual(['2026-09-22', '2026-09-16']);
    expect(days[0].rows.map(r => r.id)).toEqual([2, 4]);
    expect(days[0].net).toEqual([{ currency: 'EUR', amount: '-873.47' }]);
    expect(days[1].net).toEqual([
      { currency: 'EUR', amount: '-993.8' },
      { currency: 'USD', amount: '-29' },
    ]);
  });
});

describe('no float round-trip', () => {
  it('amounts.ts never converts an amount to a Number', () => {
    const source = readFileSync(
      new URL('./amounts.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/\bNumber\(|parseFloat|parseInt|Math\./);
  });
});
