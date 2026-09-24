// @wc-ignore-file
/**
 * Invented sample transactions for the screenshot harness, after the ones in
 * `design/mockups.html`. The account numbers are example IBANs, the amounts
 * and references are made up; none of this is anyone's bank data.
 */
import type { SeedRow } from '../fakeStore.js';

const BUNQ = 'NL42BUNQ0123456789';
const RABO = 'NL18RABO0301224456';

type Row = [
  date: string,
  amount: string,
  description: string,
  category: string,
  account?: string,
  currency?: string,
  note?: string,
];

const ROWS: Row[] = [
  [
    '2026-09-22',
    '-850',
    'Kantoorhuur De Werkplaats BV\n/TRTP/SEPA OVERBOEKING/REMI/Huur oktober 2026 unit 4',
    'Rent',
  ],
  [
    '2026-09-22',
    '-23.47',
    'Albert Heijn 1403 Amsterdam\nBEA, Betaalpas NR:4471 22.09.26/13:02',
    '',
  ],
  [
    '2026-09-19',
    '2420',
    'Studio Noord BV\n/REMI/Factuur 2026-031/EREF/NOTPROVIDED',
    'Revenue',
    BUNQ,
    'EUR',
    'Invoice 2026-031, website redesign phase 2. Paid 4 days early.',
  ],
  [
    '2026-09-18',
    '-45',
    'KPN B.V.\n/REMI/Klantnummer 3018844 factuur sep 2026',
    'Phone & internet',
  ],
  [
    '2026-09-18',
    '-84.30',
    'NS Groep IZ NS Reizigers\nBEA, Apple Pay NS Utrecht Centraal',
    'Travel',
  ],
  [
    '2026-09-16',
    '-1312',
    'Belastingdienst\n/REMI/Betalingskenmerk 1234 5678 9012 3456 BTW Q2',
    'Taxes',
    RABO,
  ],
  [
    '2026-09-16',
    '318.20',
    'Stichting Mollie Payments\n/REMI/Uitbetaling st.2026091600412',
    '',
  ],
  [
    '2026-09-15',
    '-129.00',
    'Figma Inc\n/REMI/Subscription professional 2026-09',
    'Software',
  ],
  [
    '2026-09-12',
    '-29',
    'GitHub Inc\nCard payment 12.09.26',
    'Software',
    BUNQ,
    'USD',
  ],
  [
    '2026-09-11',
    '-61.85',
    'Vattenfall Klantenservice N.V.\n/REMI/Termijnbedrag september',
    'Utilities',
  ],
  ['2026-09-09', '1500', 'Studio Noord BV\n/REMI/Factuur 2026-028', 'Revenue'],
  [
    '2026-09-05',
    '-12.50',
    'Parkeren Amsterdam\nBEA, Betaalpas 05.09.26/09:14',
    '',
  ],
  [
    '2026-09-03',
    '-66.54',
    'Adobe Systems Software Ireland\nCC Plan',
    'Software',
  ],
  ['2026-09-02', '-5.95', 'bunq B.V.\nMonthly fee', 'Bank fees'],
  [
    '2026-08-29',
    '-850',
    'Kantoorhuur De Werkplaats BV\n/REMI/Huur september 2026 unit 4',
    'Rent',
  ],
  ['2026-08-27', '3100', 'Atelier Zuid VOF\n/REMI/Factuur 2026-024', 'Revenue'],
  [
    '2026-08-21',
    '-45',
    'KPN B.V.\n/REMI/Klantnummer 3018844 factuur aug 2026',
    'Phone & internet',
  ],
  [
    '2026-08-14',
    '-61.85',
    'Vattenfall Klantenservice N.V.\n/REMI/Termijnbedrag augustus',
    'Utilities',
  ],
  ['2026-08-02', '-5.95', 'bunq B.V.\nMonthly fee', 'Bank fees'],
];

export function sampleRows(): SeedRow[] {
  return ROWS.map(
    (
      [
        date,
        amount,
        description,
        category,
        account = BUNQ,
        currency = 'EUR',
        note,
      ],
      i,
    ) => {
      const reference = `08263411${String(70 + i).padStart(2, '0')}CD`;
      const format = i % 3 === 0 ? 'mt940' : 'camt053';

      return {
        'bank-account': account,
        'bank-currency': currency,
        'bank-amount': amount,
        'bank-value-date': date,
        'bank-booking-date': date,
        'bank-description': description,
        'bank-reference': reference,
        'bank-transaction-code': format === 'mt940' ? 'NTRF' : 'PMNT/RCDT/ESCT',
        'bank-statement': date.startsWith('2026-09')
          ? account === RABO
            ? '9/1'
            : '31/1'
          : '30/1',
        'bank-source-id': JSON.stringify([
          format,
          account,
          currency,
          ['bank', reference],
        ]),
        'bank-fingerprint': `${format}-content:${reference}`,
        ...(category ? { 'money-category': category } : {}),
        ...(note ? { 'money-note': note } : {}),
      };
    },
  );
}
