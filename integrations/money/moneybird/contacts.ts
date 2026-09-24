// @wc-ignore-file
/**
 * Which Moneybird contact fields become typed columns, and how. This is the
 * whole of what the read-only milestone (atomic-plugins#102) imports: one
 * collection, contacts, of one chosen administration. Every other field of
 * `contact` in the OpenAPI document (addresses beyond the city, SEPA and
 * credit-card fields, contact people, notes, custom fields, events) is left
 * out on purpose; so are all other collections.
 */
import type { Contact } from './read.js';

const DATATYPE = 'https://atomicdata.dev/datatypes/';

export interface ContactField {
  /** Key in Moneybird's `contact`. */
  key: string;
  /** Property shortname in the app's ontology. */
  shortname: string;
  name: string;
  description: string;
  datatype: string;
}

const text = (key: string, name: string, description: string) => ({
  key,
  shortname: `moneybird-${key.replace(/_/g, '-')}`,
  name,
  description,
  datatype: `${DATATYPE}string`,
});

export const CONTACT_FIELDS: ContactField[] = [
  text('id', 'Moneybird ID', 'Moneybird contact identifier, as sent.'),
  text(
    'administration_id',
    'Administration ID',
    'Moneybird administration the contact belongs to.',
  ),
  text('company_name', 'Company name', 'Company name; may be empty.'),
  text('firstname', 'First name', 'First name; may be empty.'),
  text('lastname', 'Last name', 'Last name; may be empty.'),
  text('email', 'E-mail', 'Primary e-mail address.'),
  text('city', 'City', 'City of the primary address.'),
  text('country', 'Country', 'ISO 3166-1 alpha-2 country code.'),
  text('customer_id', 'Customer ID', 'The customer number shown in Moneybird.'),
  {
    key: 'archived',
    shortname: 'moneybird-archived',
    name: 'Archived',
    description: 'Archived in Moneybird.',
    datatype: `${DATATYPE}boolean`,
  },
  text(
    'updated_at',
    'Updated in Moneybird',
    'Moneybird updated_at, the exact ISO 8601 string it sent.',
  ),
  {
    key: 'version',
    shortname: 'moneybird-version',
    name: 'Version',
    description: 'Moneybird record version; changes with every edit there.',
    datatype: `${DATATYPE}integer`,
  },
];

/** The row's identity: administration and contact id, stable across reads. */
export const sourceId = (contact: Contact, administrationId: string) =>
  `moneybird:${administrationId}:contact:${contact.id}`;

/** A readable row name: company, else person, else the id. */
export function contactName(contact: Contact): string {
  const company =
    typeof contact.company_name === 'string' ? contact.company_name.trim() : '';
  if (company) return company;
  const person = [contact.firstname, contact.lastname]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' ');

  return person || `Contact ${contact.id}`;
}

/**
 * Field values by shortname. Absent and null values are left out rather than
 * written as empty, so a column the provider did not send stays unset.
 * Identifiers are strings even when Moneybird sends a number.
 */
export function contactValues(
  contact: Contact,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};

  for (const field of CONTACT_FIELDS) {
    const raw = contact[field.key];
    if (raw === undefined || raw === null) continue;

    if (field.datatype.endsWith('boolean')) {
      if (typeof raw === 'boolean') values[field.shortname] = raw;
    } else if (field.datatype.endsWith('integer')) {
      if (typeof raw === 'number' && Number.isSafeInteger(raw))
        values[field.shortname] = raw;
    } else if (typeof raw === 'string' || typeof raw === 'number') {
      values[field.shortname] = String(raw);
    }
  }

  return values;
}
