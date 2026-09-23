# OpenAPI Pagination Schemes Extension

**Spec version:** 0.1.0

---

## 1. Introduction

The OpenAPI Pagination Schemes Extension defines a standard way to describe API pagination behaviour in an OpenAPI document. It enables clients, SDKs, and tooling to automatically understand and navigate paginated responses without requiring hand-written, API-specific pagination logic.

The extension adds a `paginationSchemes` map under `components`. Each entry describes one pagination strategy supported by the API — its request parameters, response fields, and auto-detection rules.

The extension can be applied to existing OpenAPI documents without modification by using an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html).

---

## 2. Overview

```yaml
components:
  paginationSchemes:
    <scheme-name>:         # Pagination Scheme Object (§4.1)
      type: pageNumber | pageToken | nextLink
      autoDetect: true | false | AutoDetectObject
      request:             # Request Pagination Fields Object (§4.3)
        queryParameters:
          <param-name>:    # Request Field Object (§4.3.1)
            role: page | pageSize | offset | pageToken | cursor
            required: false
        bodyFields: { ... }
        headerFields: { ... }
      response:            # Response Pagination Fields Object (§4.4)
        bodyFields:
          <field-name>:    # Response Field Object (§4.4.1)
            role: nextPageToken | nextCursor | nextLink | totalCount | totalPages | pageSize | currentPage
        headers:
          <header-name>: { ... }
```

---

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "MAY" are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A _scheme_ is a named entry in `components.paginationSchemes`.

A _field_ is a named entry in a Request or Response Pagination Fields Object.

---

## 4. Pagination Scheme Object

### 4.1 Pagination Scheme Object

Describes a single pagination strategy.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `SchemeType` (§4.2) | **Yes** | The kind of pagination. |
| `description` | string | No | Human-readable description. |
| `autoDetect` | boolean \| `AutoDetectObject` (§6.3) | No | Controls auto-detection. Default: `true` (use §6.2 rules). `false` disables auto-detection for this scheme. |
| `request` | `RequestPaginationFieldsObject` (§4.3) | Conditional* | Describes pagination request fields. |
| `response` | `ResponsePaginationFieldsObject` (§4.4) | Conditional* | Describes pagination response fields. |
| `x-*` | any | No | Extension fields. |

\* At least one of `request` or `response` MUST be present.

### 4.2 Scheme Types

| Value | Description |
|-------|-------------|
| `pageNumber` | Page-number or offset-based pagination. The client increments a page number or offset with each request. |
| `pageToken` | Opaque cursor/token-based pagination. The server returns a token in the response; the client sends it back on the next request. |
| `nextLink` | Hypermedia-style pagination. The server returns the full URL of the next page, either in a response header or body field. The client follows the URL directly. |

### 4.3 Request Pagination Fields Object

Describes the fields the client sends to control pagination.

| Field | Type | Description |
|-------|------|-------------|
| `queryParameters` | `Record<string, RequestFieldObject>` | Query string parameters. Key is the parameter name. |
| `bodyFields` | `Record<string, RequestFieldObject>` | Top-level fields in the JSON request body. Key is the field name. |
| `headerFields` | `Record<string, RequestFieldObject>` | HTTP request headers. Key is the header name. |
| `x-*` | any | Extension fields. |

#### 4.3.1 Request Field Object

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Human-readable description. |
| `schema` | OAS Schema Object | JSON Schema describing the field value. |
| `role` | `RequestRole` (§4.5) | Semantic role of this field. |
| `required` | boolean | Whether this field is required. Default: `false`. |
| `x-*` | any | Extension fields. |

### 4.4 Response Pagination Fields Object

Describes the fields the client reads from the server response to determine the next page.

| Field | Type | Description |
|-------|------|-------------|
| `bodyFields` | `Record<string, ResponseFieldObject>` | Top-level fields in the JSON response body. Key is the field name as it appears in the response. |
| `headers` | `Record<string, ResponseFieldObject>` | HTTP response headers. Key is the header name. |
| `x-*` | any | Extension fields. |

#### 4.4.1 Response Field Object

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Human-readable description. |
| `schema` | OAS Schema Object | JSON Schema describing the field value. |
| `role` | `ResponseRole` (§4.5) | Semantic role of this field. |
| `x-*` | any | Extension fields. |

### 4.5 Semantic Roles

#### Request Roles

| Role | Scheme type | Description |
|------|-------------|-------------|
| `page` | `pageNumber` | 1-based page number. |
| `pageSize` | all | Maximum number of items to return per page. |
| `offset` | `pageNumber` | 0-based item offset. |
| `pageToken` | `pageToken` | Opaque continuation token from the previous response. |
| `cursor` | `pageToken` | Synonym for `pageToken`. |

#### Response Roles

| Role | Scheme type | Description |
|------|-------------|-------------|
| `nextPageToken` | `pageToken` | Token to send with the next request. Absent or empty when there are no more pages. |
| `nextCursor` | `pageToken` | Synonym for `nextPageToken`. |
| `nextLink` | `nextLink` | Full URL of the next page. Absent when there are no more pages. |
| `totalCount` | all | Total number of items across all pages. |
| `totalPages` | `pageNumber` | Total number of pages. |
| `pageSize` | all | Number of items in the current page (as confirmed by the server). |
| `currentPage` | `pageNumber` | The current page number (as confirmed by the server). |

---

## 5. Overrides — Pagination Application Object

An individual operation may reference a scheme from `components.paginationSchemes` and optionally override parts of it. This is done via the `pagination` field on an OAS Operation Object.

```yaml
paths:
  /items:
    get:
      x-pagination:
        - scheme: pageToken
          overrides:
            request:
              queryParameters:
                continuation:
                  role: pageToken
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scheme` | string | **Yes** | Key into `components.paginationSchemes`. |
| `overrides` | Partial `PaginationSchemeObject` | No | Deep-merged on top of the referenced scheme for this operation. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

---

## 6. Auto-Detection

When an operation does not explicitly reference a scheme, tooling MAY attempt to infer which schemes apply by comparing the operation's parameters and response fields against the schemes defined in `components.paginationSchemes`.

### 6.1 Disabling Auto-Detection

Set `autoDetect: false` on a scheme to prevent it from being matched automatically.

### 6.2 Default Auto-Detection Rules

When `autoDetect` is `true` (the default), a scheme matches an operation when:

1. Every `queryParameters` key in the scheme's `request` is present in the operation's query parameters, **and**
2. Every `bodyFields` key in the scheme's `request` is present in the operation's request body schema.

(`matchQueryParams: true`, `matchBodyFields: true`, `requireAll: true` — see §6.3.)

Response fields and response headers are **not** considered by default.

### 6.3 Custom Auto-Detection — Auto-Detect Object

The `autoDetect` field may be an object for fine-grained control:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `matchQueryParams` | boolean | `true` | Require all scheme `queryParameters` to be present on the operation. |
| `matchBodyFields` | boolean | `true` | Require all scheme request `bodyFields` to be present in the request body. |
| `matchResponseFields` | boolean | `false` | Require all scheme response `bodyFields` to be present in the operation's response body. |
| `matchHeaders` | boolean | `false` | Require all scheme response `headers` to be present in the operation's response. |
| `requireAll` | boolean | `true` | `true` = ALL enabled dimensions must match. `false` = ANY enabled dimension is sufficient. |
| `x-*` | any | | Extension fields. |

**Example** — detect by response header only (e.g. `Link: rel="next"`):

```yaml
paginationSchemes:
  nextLink:
    type: nextLink
    autoDetect:
      matchQueryParams: false
      matchBodyFields: false
      matchHeaders: true
      requireAll: false
    response:
      headers:
        Link:
          role: nextLink
```

---

## 7. Applying via OpenAPI Overlays

The recommended way to add `paginationSchemes` to an existing API without modifying the original document is an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html):

```yaml
overlay: 1.0.0
info:
  title: My API Pagination Schemes
  version: 1.0.0
actions:
  - target: $.components
    update:
      paginationSchemes:
        pageToken:
          type: pageToken
          request:
            queryParameters:
              pageToken:
                role: pageToken
              pageSize:
                role: pageSize
          response:
            bodyFields:
              nextPageToken:
                role: nextPageToken
```

---

## 8. Examples

### 8.1 Token-based pagination (Google-style)

```yaml
paginationSchemes:
  pageToken:
    type: pageToken
    request:
      queryParameters:
        pageToken:
          role: pageToken
        pageSize:
          role: pageSize
    response:
      bodyFields:
        nextPageToken:
          role: nextPageToken
```

### 8.2 Page-number pagination

```yaml
paginationSchemes:
  pageNumber:
    type: pageNumber
    request:
      queryParameters:
        page:
          role: page
        limit:
          role: pageSize
    response:
      bodyFields:
        total:
          role: totalCount
        totalPages:
          role: totalPages
        currentPage:
          role: currentPage
```

### 8.3 Link-header pagination (GitHub-style)

```yaml
paginationSchemes:
  nextLink:
    type: nextLink
    autoDetect:
      matchQueryParams: false
      matchBodyFields: false
      matchHeaders: true
      requireAll: false
    request:
      queryParameters:
        per_page:
          role: pageSize
    response:
      headers:
        Link:
          role: nextLink
```

### 8.4 Offset-based pagination

```yaml
paginationSchemes:
  offset:
    type: pageNumber
    request:
      queryParameters:
        start:
          role: offset
        num:
          role: pageSize
```

---

## 9. Validation

A conforming implementation MUST enforce:

1. `type` MUST be one of `pageNumber`, `pageToken`, or `nextLink`.
2. At least one of `request` or `response` MUST be present.
3. `role` values in request fields MUST be from: `page`, `pageSize`, `offset`, `pageToken`, `cursor` — or an `x-` prefixed extension.
4. `role` values in response fields MUST be from: `nextPageToken`, `nextCursor`, `nextLink`, `totalCount`, `totalPages`, `pageSize`, `currentPage` — or an `x-` prefixed extension.
5. The `scheme` field in a Pagination Application Object (§5) MUST reference a key that exists in `components.paginationSchemes`.

A validation error SHOULD identify the precise location of the violation (e.g. `paginationSchemes.myScheme.request.queryParameters.page`).

---

## Reference Implementation

[`michielbdejong/openapi-pagination-client`](https://github.com/michielbdejong/openapi-pagination-client) — a TypeScript client library that drives pagination entirely from `paginationSchemes` definitions. The `src/types.ts` file mirrors this specification's objects 1:1.

## Overlay Collection

[`pondersource/overlays`](https://github.com/pondersource/overlays) — a collection of OpenAPI Overlays that add `paginationSchemes` to existing public APIs (GitHub REST API, 200+ googleapis.com APIs, and more).
