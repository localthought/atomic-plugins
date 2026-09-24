// @wc-ignore-file
/**
 * Synthetic MT940 files for the harness's import frames, and the rows the
 * importer would have stored for them. Invented data only.
 */
import { addAmounts } from '../amounts.js';
import { entries } from '../../identity.js';
import { parseMT940 } from '../../parser.js';
import type { SeedRow } from '../fakeStore.js';

export interface Line {
  date: string;
  amount: string;
  reference: string;
  narrative: string;
}

export interface Spec {
  account: string;
  number: string;
  opening: string;
  lines: Line[];
  /** Overrides the computed closing balance (for a mismatch). */
  closing?: string;
}

const yymmdd = (iso: string) => iso.slice(2).replaceAll('-', '');

const mt = (amount: string) => {
  const [whole, fraction = ''] = amount.replace('-', '').split('.');

  return `${whole},${fraction.padEnd(2, '0')}`;
};

const side = (amount: string) => (amount.startsWith('-') ? 'D' : 'C');

export function mt940(specs: Spec[]): string {
  return specs
    .map(spec => {
      const last = spec.lines.reduce(
        (max, l) => (l.date > max ? l.date : max),
        '2026-09-01',
      );
      const closing =
        spec.closing ??
        addAmounts([spec.opening, ...spec.lines.map(l => l.amount)]);

      return [
        ':20:SYNTHETIC',
        `:25:${spec.account}`,
        `:28C:${spec.number}`,
        `:60F:${side(spec.opening)}260901EUR${mt(spec.opening)}`,
        ...spec.lines.flatMap(l => [
          `:61:${yymmdd(l.date)}${yymmdd(l.date).slice(2)}${side(l.amount)}${mt(l.amount)}NTRFNONREF//${l.reference}`,
          `:86:${l.narrative}`,
        ]),
        `:62F:${side(closing)}${yymmdd(last)}EUR${mt(closing)}`,
      ].join('\n');
    })
    .join('\n');
}

/** The rows the importer stores for `text` (same identity function). */
export function importedRows(text: string): SeedRow[] {
  return entries('mt940', parseMT940(text)).map(e => ({
    'bank-account': e.statement.account,
    'bank-currency': e.statement.currency,
    'bank-amount': e.row.amount,
    'bank-value-date': e.row.date,
    'bank-booking-date': e.row.bookingDate,
    'bank-description': e.row.description,
    'bank-reference': e.row.bankReference || e.row.reference,
    'bank-transaction-code': e.row.code,
    'bank-statement': e.statement.number,
    'bank-source-id': e.identity,
    'bank-fingerprint': e.fingerprint,
  }));
}

export const BUNQ_SEPT: Spec = {
  account: 'NL42BUNQ0123456789',
  number: '31/1',
  opening: '8412.06',
  lines: [
    {
      date: '2026-09-02',
      amount: '-66.54',
      reference: '0826341159AB',
      narrative: 'Adobe Systems Software Ireland\nCC Plan',
    },
    {
      date: '2026-09-09',
      amount: '1500',
      reference: '0826341160AB',
      narrative: 'Studio Noord BV\n/REMI/Factuur 2026-028',
    },
    {
      date: '2026-09-11',
      amount: '-61.85',
      reference: '0826341161AB',
      narrative:
        'Vattenfall Klantenservice N.V.\n/REMI/Termijnbedrag september',
    },
    {
      date: '2026-09-19',
      amount: '2420',
      reference: '0826341177CD',
      narrative: 'Studio Noord BV\n/REMI/Factuur 2026-031/EREF/NOTPROVIDED',
    },
    {
      date: '2026-09-22',
      amount: '-23.47',
      reference: '0826341178CD',
      narrative:
        'Albert Heijn 1403 Amsterdam\nBEA, Betaalpas NR:4471 22.09.26/13:02',
    },
    {
      date: '2026-09-22',
      amount: '-850',
      reference: '0826341179CD',
      narrative:
        'Kantoorhuur De Werkplaats BV\n/TRTP/SEPA OVERBOEKING/REMI/Huur oktober 2026 unit 4',
    },
  ],
};

export const RABO_SEPT: Spec = {
  account: 'NL18RABO0301224456',
  number: '9/1',
  opening: '21050',
  lines: [
    {
      date: '2026-09-16',
      amount: '-1312',
      reference: 'RB2026091601',
      narrative:
        'Belastingdienst\n/REMI/Betalingskenmerk 1234 5678 9012 3456 BTW Q2',
    },
  ],
};
