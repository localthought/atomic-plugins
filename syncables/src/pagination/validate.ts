import type {
  PaginationSchemeObject,
  RequestRole,
  ResponseRole,
} from './types.js';

const SCHEME_TYPES = new Set(['pageNumber', 'pageToken', 'nextLink']);
const REQUEST_ROLES: Set<RequestRole> = new Set([
  'page',
  'pageSize',
  'offset',
  'pageToken',
  'cursor',
]);
const RESPONSE_ROLES: Set<ResponseRole> = new Set([
  'nextPageToken',
  'nextCursor',
  'nextLink',
  'totalCount',
  'totalPages',
  'pageSize',
  'currentPage',
]);

function isExtensionKey(key: string): boolean {
  return key.startsWith('x-');
}

/**
 * Validates a single scheme against spec section 9. Returns a list of
 * human-readable errors (each naming the offending location), empty if
 * the scheme is valid. Schemes with errors are excluded from
 * auto-detection rather than throwing — one malformed scheme in a
 * document shouldn't prevent using the others.
 */
export function validatePaginationScheme(
  name: string,
  scheme: PaginationSchemeObject,
): string[] {
  const errors: string[] = [];
  const path = `paginationSchemes.${name}`;

  if (!SCHEME_TYPES.has(scheme.type)) {
    errors.push(
      `${path}.type must be one of pageNumber, pageToken, or nextLink (got "${String(scheme.type)}")`,
    );
  }

  if (!scheme.request && !scheme.response) {
    errors.push(`${path} must define at least one of "request" or "response"`);
  }

  for (const [fieldName, field] of Object.entries(
    scheme.request?.queryParameters ?? {},
  )) {
    if (
      field.role &&
      !isExtensionKey(field.role) &&
      !REQUEST_ROLES.has(field.role)
    ) {
      errors.push(
        `${path}.request.queryParameters.${fieldName}.role is not a valid request role (got "${field.role}")`,
      );
    }
  }
  for (const [fieldName, field] of Object.entries(
    scheme.request?.bodyFields ?? {},
  )) {
    if (
      field.role &&
      !isExtensionKey(field.role) &&
      !REQUEST_ROLES.has(field.role)
    ) {
      errors.push(
        `${path}.request.bodyFields.${fieldName}.role is not a valid request role (got "${field.role}")`,
      );
    }
  }

  for (const [fieldName, field] of Object.entries(
    scheme.response?.bodyFields ?? {},
  )) {
    if (
      field.role &&
      !isExtensionKey(field.role) &&
      !RESPONSE_ROLES.has(field.role)
    ) {
      errors.push(
        `${path}.response.bodyFields.${fieldName}.role is not a valid response role (got "${field.role}")`,
      );
    }
  }
  for (const [fieldName, field] of Object.entries(
    scheme.response?.headers ?? {},
  )) {
    if (
      field.role &&
      !isExtensionKey(field.role) &&
      !RESPONSE_ROLES.has(field.role)
    ) {
      errors.push(
        `${path}.response.headers.${fieldName}.role is not a valid response role (got "${field.role}")`,
      );
    }
  }

  return errors;
}
