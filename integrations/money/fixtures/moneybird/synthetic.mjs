/**
 * SYNTHETIC Moneybird data. NOT RECORDED.
 *
 * Nobody working on this repository had a Moneybird account when this was
 * written (atomic-plugins#102), so these bodies are hand-written. Their shape
 * follows the public, read-only Moneybird OpenAPI document the proxy catalog
 * pins (localthought/openapi-directory@85a61052,
 * APIs/moneybird.com/v2-readonly/openapi.yaml: `administration_response` and
 * `contact`, including that document's own examples) and the overlays in
 * overlays/moneybird.com/api/v2/ (page/per_page pagination on contacts.json;
 * `include_archived` in all-records-selection.json). Every name, address,
 * e-mail address, IBAN and identifier is invented; none belongs to a real
 * administration.
 *
 * What this cannot tell you: whether real responses carry fields, nulls or
 * pagination headers this file does not. Moneybird documents a `Link`
 * header with rel="next" for paginated collections
 * (https://developer.moneybird.com/, "Pagination"); scenario.mjs sends one,
 * and the reader also stops on a short page, so both are exercised. A
 * recording against a real test administration replaces this file; see the
 * "Recording" note in scenario.mjs.
 */

export const SYNTHETIC = true;

const ADMIN_A = '100000000000000001';
const ADMIN_B = '100000000000000002';

export const administrations = [
  {
    id: ADMIN_A,
    name: 'Synthetic Studio B.V.',
    language: 'nl',
    currency: 'EUR',
    country: 'NL',
    time_zone: 'Europe/Amsterdam',
    access: 'user',
    suspended: false,
    period_locked_until: null,
    period_start_date: '2025-01-01',
  },
  {
    id: ADMIN_B,
    name: 'Synthetic Side Project',
    language: 'en',
    currency: 'EUR',
    country: 'NL',
    time_zone: 'Europe/Amsterdam',
    access: 'accountant_company',
    suspended: false,
    period_locked_until: '2025-12-31',
    period_start_date: '2024-01-01',
  },
];

/** The fields of `contact` in the pinned OpenAPI document, with synthetic values. */
function contact(administration, n, over) {
  const id = `2000000000000000${String(n).padStart(2, '0')}`;
  const stamp = `2026-0${1 + (n % 8)}-1${n % 10}T09:0${n % 10}:00.000Z`;

  return {
    id,
    administration_id: administration,
    company_name: '',
    firstname: null,
    lastname: null,
    address1: `Voorbeeldstraat ${n}`,
    address2: '',
    zipcode: `10${String(n).padStart(2, '0')} AB`,
    city: 'Amsterdam',
    country: 'NL',
    phone: '',
    delivery_method: 'Email',
    customer_id: String(n),
    tax_number: '',
    chamber_of_commerce: '',
    bank_account: '',
    is_trusted: false,
    max_transfer_amount: null,
    attention: '',
    email: `contact${n}@example.invalid`,
    email_ubl: true,
    send_invoices_to_attention: '',
    send_invoices_to_email: `contact${n}@example.invalid`,
    send_estimates_to_attention: '',
    send_estimates_to_email: `contact${n}@example.invalid`,
    direct_debit: false,
    sepa_active: false,
    sepa_iban: '',
    sepa_iban_account_name: '',
    sepa_bic: '',
    sepa_mandate_id: '',
    sepa_mandate_date: null,
    sepa_sequence_type: 'RCUR',
    credit_card_number: '',
    credit_card_reference: '',
    credit_card_type: null,
    tax_number_validated_at: null,
    tax_number_valid: null,
    invoice_workflow_id: null,
    estimate_workflow_id: null,
    si_identifier: '',
    si_identifier_type: null,
    moneybird_payments_mandate: false,
    created_at: stamp,
    updated_at: stamp,
    version: 1788950000 + n,
    sales_invoices_url: `https://moneybird.com/${administration}/sales_invoices/synthetic${n}/all`,
    notes: [],
    custom_fields: [],
    contact_people: [],
    archived: false,
    events: [],
    ...over,
  };
}

export const contacts = {
  [ADMIN_A]: [
    contact(ADMIN_A, 1, { company_name: 'Fictief Bakkerij B.V.' }),
    contact(ADMIN_A, 2, { firstname: 'Anna', lastname: 'Voorbeeld' }),
    contact(ADMIN_A, 3, {
      company_name: 'Testcafé & Co',
      city: 'Utrecht',
      sepa_iban: 'NL00TEST0000000003',
    }),
    contact(ADMIN_A, 4, {
      firstname: 'Bram',
      lastname: 'Proef',
      archived: true,
    }),
    contact(ADMIN_A, 5, {
      company_name: 'Nep Consultancy',
      country: 'BE',
      city: 'Gent',
    }),
  ],
  [ADMIN_B]: [
    contact(ADMIN_B, 11, { company_name: 'Side Project Client Ltd' }),
  ],
};
