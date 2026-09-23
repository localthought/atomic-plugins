// @wc-ignore-file
import { Datatype } from '@tomic/lib';
import type {
  FetchedPlatform,
  FetchedRecord,
  JSONValue,
  Term,
} from './types.js';

export const NOTION_PLATFORM = 'notion';
export const PAGE_RESOURCE = 'page';

/** Notion property types this lens projects; the same subset as the sandbox pilot. */
export const notionFieldTypes = [
  'title',
  'rich_text',
  'number',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'select',
  'multi_select',
  'status',
] as const;
export type NotionFieldType = (typeof notionFieldTypes)[number];

/**
 * Spelled out because `Datatype.JSON` is missing from the published
 * `@tomic/lib` 0.40 that devonian declares as its peer (and that devonian's
 * own tests installed while this lens lived there). It is only present in
 * the atomic-server source that integrations/ resolves `@tomic/lib` to.
 */
export const JSON_DATATYPE =
  'https://atomicdata.dev/datatypes/json' as Datatype;

const datatypes: Record<NotionFieldType, Datatype> = {
  title: Datatype.STRING,
  rich_text: Datatype.STRING,
  number: Datatype.FLOAT,
  checkbox: Datatype.BOOLEAN,
  url: Datatype.STRING,
  email: Datatype.STRING,
  phone_number: Datatype.STRING,
  select: Datatype.STRING,
  status: Datatype.STRING,
  multi_select: JSON_DATATYPE,
};

const supported = (type: unknown): type is NotionFieldType =>
  typeof type === 'string' &&
  (notionFieldTypes as readonly string[]).includes(type);

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Term shortname for a Notion property id. Property ids are short,
 * case-sensitive, percent-encoded strings (`title`, `%3AUPp`, `BJXS`), so they
 * are hex-encoded instead of lowercased or slugged. Two different ids can
 * never share a shortname, and a rename in Notion does not change it.
 */
export function notionFieldShortname(propertyId: string): string {
  if (!propertyId) throw new Error('Notion property id is empty');
  const hex = Array.from(new TextEncoder().encode(propertyId), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');

  return `notion-${hex}`;
}

/**
 * Plain text from a Notion rich-text array, or `undefined` when the text has
 * formatting, links, mentions or equations. Those have no lossless plain-text
 * form, so the lens leaves them unprojected rather than flattening them.
 */
export function notionPlainText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  let text = '';

  for (const part of parts) {
    const p = object(part);
    const content = object(p.text).content;
    if (
      p.type !== 'text' ||
      typeof content !== 'string' ||
      object(p.text).link ||
      Object.entries(object(p.annotations)).some(([k, v]) =>
        k === 'color' ? v !== 'default' : v !== false,
      )
    )
      return undefined;
    text += content;
  }

  return text;
}

const optionId = (value: unknown): string | undefined => {
  const id = object(value).id;

  return typeof id === 'string' && id ? id : undefined;
};

/**
 * Decodes one Notion page property value. Returns `undefined` when the value
 * cannot be represented losslessly (formatted text, malformed options), and
 * `null` when Notion holds no value (no number, no selected option). Atomic
 * has no null, so the projection leaves an empty value's key absent.
 * `false`, `0` and `[]` are values, not empties.
 */
export function notionFieldValue(
  type: NotionFieldType,
  raw: unknown,
): JSONValue | null | undefined {
  switch (type) {
    case 'title':
    case 'rich_text':
      return notionPlainText(raw);
    case 'number':
      return raw === null || (typeof raw === 'number' && Number.isFinite(raw))
        ? raw
        : undefined;
    case 'checkbox':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'url':
    case 'email':
    case 'phone_number':
      return raw === null || typeof raw === 'string' ? raw : undefined;
    case 'select':
    case 'status':
      if (raw === null) return null;

      return optionId(raw);

    case 'multi_select': {
      if (!Array.isArray(raw)) return undefined;
      const ids = raw.map(optionId);

      return ids.every((id): id is string => id !== undefined)
        ? [...ids].sort()
        : undefined;
    }
  }
}

interface FieldDefinition {
  id: string;
  name: string;
  type: NotionFieldType;
}

export interface NotionProjectionOptions {
  /**
   * The data source the pages were queried from. When set, a page whose
   * `parent.data_source_id` differs (moved to another data source) fails the
   * projection instead of being imported into the wrong table.
   */
  dataSource?: string;
}

const normalizeUuid = (value: unknown): string =>
  typeof value === 'string' ? value.replaceAll('-', '').toLowerCase() : '';

/**
 * Read-only projection of pages from one Notion data source, as fetched by
 * the generic Syncables engine (`resource: 'page'`, `values` holding the raw
 * page object including `properties`).
 *
 * - Every supported property becomes a typed value keyed by
 *   `notionFieldShortname(property.id)`. The Notion property id is stable
 *   across renames, and the display name only goes into the term description.
 * - The record name is the plain-text title (`Untitled` when empty).
 * - Archived or trashed pages are left out and listed in `errors`. A page
 *   missing from a fetch never means it should be deleted.
 * - Formatted rich text and malformed option values are left unprojected, and
 *   each one is listed in `errors`. The raw `properties` object passes through
 *   untouched, as do unsupported types (formula, relation, date, people, files,
 *   ...), so nothing provider-side is lost.
 * - A property id whose type differs between pages in one fetch (the schema
 *   changed mid-read) throws.
 *
 * It does not write anything back or reconcile views. Two-way sync belongs
 * to a Devonian bridge that does not exist yet.
 */
export function notionProjection(
  fetched: FetchedPlatform,
  options: NotionProjectionOptions = {},
): FetchedPlatform {
  if (fetched.platform !== NOTION_PLATFORM) return fetched;
  const page = fetched.ontology.terms.find(
    t => t.kind === 'class' && t.shortname === PAGE_RESOURCE,
  );
  if (!page) return fetched;

  const fields = new Map<string, FieldDefinition>();
  const errors = [...(fetched.errors ?? [])];
  const records: FetchedRecord[] = [];

  for (const row of fetched.records) {
    if (row.resource !== PAGE_RESOURCE) {
      records.push(row);
      continue;
    }

    if (row.values.archived === true || row.values.in_trash === true) {
      errors.push(
        `Notion page ${row.id} is archived or in trash; left out, not deleted`,
      );
      continue;
    }

    if (options.dataSource !== undefined) {
      const parent = object(row.values.parent).data_source_id;
      if (normalizeUuid(parent) !== normalizeUuid(options.dataSource))
        throw new Error(
          `Notion page ${row.id} is outside data source ${options.dataSource}`,
        );
    }

    const values: Record<string, JSONValue> = { ...row.values };
    let title = '';

    for (const [name, property] of Object.entries(
      object(row.values.properties),
    )) {
      const p = object(property);
      const id = p.id;
      if (typeof id !== 'string' || !supported(p.type)) continue;
      const known = fields.get(id);
      if (known && known.type !== p.type)
        throw new Error(
          `Notion property ${id} changed type from ${known.type} to ${p.type} during one fetch`,
        );
      if (!known) fields.set(id, { id, name, type: p.type });
      const value = notionFieldValue(p.type, p[p.type]);

      if (value === undefined) {
        errors.push(
          `Notion page ${row.id} property "${name}" (${p.type}) has no lossless plain value; left unprojected`,
        );
        continue;
      }

      if (value === null) continue;
      values[notionFieldShortname(id)] = value;
      if (p.type === 'title') title = (value as string).trim();
    }

    records.push({ ...row, name: title || 'Untitled', values });
  }

  const terms: Term[] = [...fields.values()].map(field => ({
    path: `urn:atomic:notion:property:${encodeURIComponent(field.id)}`,
    kind: 'property',
    shortname: notionFieldShortname(field.id),
    datatype: datatypes[field.type],
    description: `Notion property "${field.name}" (${field.type}, id ${field.id}).`,
    requires: [],
    recommends: [],
  }));
  if (
    fetched.ontology.terms.some(t =>
      terms.some(extra => extra.shortname === t.shortname),
    )
  )
    throw new Error(
      'Notion projection property collides with provider ontology',
    );

  return {
    ...fetched,
    ontology: {
      ...fetched.ontology,
      terms: [
        ...fetched.ontology.terms.map(t =>
          t === page
            ? {
                ...t,
                recommends: [
                  ...t.recommends,
                  ...terms.map(extra => extra.path),
                ],
              }
            : t,
        ),
        ...terms,
      ],
    },
    records,
    ...(errors.length ? { errors } : {}),
  };
}
