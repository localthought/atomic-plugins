/**
 * Type definitions for the OpenAPI Pagination Schemes Extension.
 * Spec version 0.1.0: https://github.com/pondersource/openapi-pagination-schemes-extension
 *
 * Field names, optionality, and enum values are taken verbatim from the
 * spec (mirroring the reference implementation's src/types.ts) so a
 * PaginationSchemeObject can be lifted from an OAS document without
 * transformation.
 */

export type SchemeType = 'pageNumber' | 'pageToken' | 'nextLink';

export type RequestRole =
  | 'page'
  | 'pageSize'
  | 'offset'
  | 'pageToken'
  | 'cursor';

export type ResponseRole =
  | 'nextPageToken'
  | 'nextCursor'
  | 'nextLink'
  | 'totalCount'
  | 'totalPages'
  | 'pageSize'
  | 'currentPage';

export interface RequestFieldObject {
  description?: string;
  schema?: unknown;
  role?: RequestRole;
  required?: boolean;
  [key: `x-${string}`]: unknown;
}

export interface RequestPaginationFieldsObject {
  queryParameters?: Record<string, RequestFieldObject>;
  bodyFields?: Record<string, RequestFieldObject>;
  headerFields?: Record<string, RequestFieldObject>;
  [key: `x-${string}`]: unknown;
}

export interface ResponseFieldObject {
  description?: string;
  schema?: unknown;
  role?: ResponseRole;
  [key: `x-${string}`]: unknown;
}

export interface ResponsePaginationFieldsObject {
  bodyFields?: Record<string, ResponseFieldObject>;
  headers?: Record<string, ResponseFieldObject>;
  [key: `x-${string}`]: unknown;
}

export interface AutoDetectObject {
  matchQueryParams?: boolean;
  matchBodyFields?: boolean;
  matchResponseFields?: boolean;
  matchHeaders?: boolean;
  requireAll?: boolean;
  [key: `x-${string}`]: unknown;
}

export interface PaginationSchemeObject {
  type: SchemeType;
  description?: string;
  autoDetect?: boolean | AutoDetectObject;
  request?: RequestPaginationFieldsObject;
  response?: ResponsePaginationFieldsObject;
  [key: `x-${string}`]: unknown;
}

export interface PaginationApplicationObject {
  scheme: string;
  overrides?: Partial<PaginationSchemeObject>;
  description?: string;
  [key: `x-${string}`]: unknown;
}

export type PaginationSchemesMap = Record<string, PaginationSchemeObject>;

/** Everything derivable from a server response about the state of pagination. */
export interface PaginationResponseState {
  nextPageToken: string | null;
  nextLink: string | null;
  currentPage: number | null;
  totalCount: number | null;
  totalPages: number | null;
  pageSize: number | null;
  hasNextPage: boolean;
}

/** Query parameters to send for a single page request. */
export type PaginationQuery = Record<string, string>;
