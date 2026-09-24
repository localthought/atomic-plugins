// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/openapi/resolve-refs.js
function resolveRefs(document) {
  const root = document;
  const resolving = /* @__PURE__ */ new Set();
  const resolved2 = /* @__PURE__ */ new Map();
  function resolvePointer(ref) {
    const segments = ref.replace(/^#\//, "").split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node = root;
    for (const segment of segments) {
      node = node[segment];
    }
    return node;
  }
  function walk(node) {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === "object") {
      const obj = node;
      const ref = obj["$ref"];
      if (typeof ref === "string") {
        if (!ref.startsWith("#/")) {
          return obj;
        }
        const target = resolvePointer(ref);
        if (!target || typeof target !== "object") {
          return target;
        }
        if (resolved2.has(target)) {
          return resolved2.get(target);
        }
        if (resolving.has(target)) {
          return target;
        }
        resolving.add(target);
        const result2 = walk(target);
        resolving.delete(target);
        resolved2.set(target, result2);
        return result2;
      }
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = walk(value);
      }
      return result;
    }
    return node;
  }
  return walk(root);
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/read/model.js
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asText(value) {
  return typeof value === "string" ? value : value === null || value === void 0 ? "" : JSON.stringify(value);
}
function pathVariables(template) {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}
function crudResourcesOf(document) {
  const raw = document.components?.["crudResources"];
  if (!isRecord(raw)) {
    throw new Error("OpenAPI document declares no crudResources; apply the CRUD-causality overlay");
  }
  return raw;
}
function listMethodOf(collection) {
  const raw = collection["x-list-method"];
  if (raw === void 0) {
    return "GET";
  }
  const method = typeof raw === "string" ? raw.toUpperCase() : "";
  if (method !== "GET" && method !== "POST") {
    throw new Error(`Unsupported x-list-method ${asText(raw)}`);
  }
  return method;
}
function discoverReadModel(document) {
  const collections = [];
  const firstCollection = /* @__PURE__ */ new Map();
  const bindings = [];
  for (const [resource, def] of Object.entries(crudResourcesOf(document))) {
    if (!isRecord(def)) {
      continue;
    }
    const identity = isRecord(def["identity"]) ? def["identity"] : {};
    const itemUrl = typeof identity["urlTemplate"] === "string" ? identity["urlTemplate"] : "";
    const cols = isRecord(def["collections"]) ? def["collections"] : {};
    const collectionUrlHas = (param) => Object.values(cols).some((c) => isRecord(c) && typeof c["urlTemplate"] === "string" && c["urlTemplate"].includes(`{${param}}`));
    let idField = "id";
    const identityBindings = isRecord(identity["bindings"]) ? identity["bindings"] : {};
    for (const [param, binding] of Object.entries(identityBindings)) {
      const field = isRecord(binding) && typeof binding["field"] === "string" ? binding["field"] : "id";
      bindings.push({ param, resource, field });
      if (itemUrl.includes(`{${param}}`) && !collectionUrlHas(param)) {
        idField = field;
      }
    }
    for (const [name, col] of Object.entries(cols)) {
      if (!isRecord(col) || typeof col["urlTemplate"] !== "string") {
        continue;
      }
      if (!firstCollection.has(resource)) {
        firstCollection.set(resource, name);
      }
      const listQuery = {};
      if (isRecord(col["x-list-query"])) {
        for (const [key, value] of Object.entries(col["x-list-query"])) {
          listQuery[key] = asText(value);
        }
      }
      collections.push({
        name,
        resource,
        url: col["urlTemplate"],
        idField,
        contextParams: pathVariables(col["urlTemplate"]),
        listQuery,
        method: listMethodOf(col),
        listBody: isRecord(col["x-list-body"]) ? structuredClone(col["x-list-body"]) : {}
      });
    }
  }
  const providers = /* @__PURE__ */ new Map();
  for (const { param, resource, field } of bindings) {
    const collection = firstCollection.get(resource);
    if (collection && !providers.has(param)) {
      providers.set(param, { collection, field });
    }
  }
  return { collections, providers };
}
function rootParameters(model) {
  const parameters = /* @__PURE__ */ new Set();
  for (const collection of model.collections) {
    for (const param of collection.contextParams) {
      const provider = model.providers.get(param);
      if (!provider || provider.collection === collection.name) {
        parameters.add(param);
      }
    }
  }
  return [...parameters].sort();
}
function upstreamOf(document) {
  const servers = document["servers"];
  const first = Array.isArray(servers) ? servers[0] : void 0;
  const raw = isRecord(first) ? first["url"] : void 0;
  if (typeof raw !== "string" || !raw) {
    throw new Error("OpenAPI document declares no servers");
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenAPI server must be an HTTP(S) URL");
  }
  return url;
}
function listOperation(document, path, method) {
  const operation = document.paths?.[path]?.[method === "POST" ? "post" : "get"];
  return isRecord(operation) ? operation : void 0;
}
function declaredQueryParameters(operation) {
  return new Set((operation.parameters ?? []).filter((parameter) => isRecord(parameter) && parameter.in === "query").map((parameter) => parameter.name));
}
function describeModel(document, model) {
  return {
    parameters: rootParameters(model),
    collections: model.collections.map((c) => c.name),
    upstream: upstreamOf(document).href
  };
}
function applySelection(document, model, selection) {
  for (const override of selection?.query_overrides ?? []) {
    const matches = model.collections.filter((c) => c.url === override.path);
    const collection = matches[0];
    if (matches.length !== 1 || !collection) {
      throw new Error(`Unknown or ambiguous collection path ${override.path}`);
    }
    const operation = listOperation(document, override.path, collection.method);
    if (!operation) {
      throw new Error(`Collection ${override.path} has no ${collection.method} operation`);
    }
    const declared = declaredQueryParameters(operation);
    for (const [name, value] of Object.entries(override.values)) {
      if (!declared.has(name)) {
        throw new Error(`Unknown query parameter ${name} for ${override.path}`);
      }
      collection.listQuery[name] = asText(value);
    }
  }
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/read/ontology.js
var DATATYPES = {
  string: "https://atomicdata.dev/datatypes/string",
  timestamp: "https://atomicdata.dev/datatypes/timestamp",
  date: "https://atomicdata.dev/datatypes/date",
  integer: "https://atomicdata.dev/datatypes/integer",
  float: "https://atomicdata.dev/datatypes/float",
  boolean: "https://atomicdata.dev/datatypes/boolean",
  json: "https://atomicdata.dev/datatypes/json"
};
function ontologyShortname(name) {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-");
}
function datatypeOf(schema) {
  switch (schema?.type) {
    case "string":
      return schema.format === "date-time" ? DATATYPES.timestamp : schema.format === "date" ? DATATYPES.date : DATATYPES.string;
    case "integer":
      return DATATYPES.integer;
    case "number":
      return DATATYPES.float;
    case "boolean":
      return DATATYPES.boolean;
    default:
      return void 0;
  }
}
function flattenSchema(schema) {
  if (!schema?.allOf) {
    return schema ?? {};
  }
  const { allOf, ...rest } = schema;
  return allOf.map(flattenSchema).reduce((merged, branch) => ({
    ...merged,
    required: [...merged.required ?? [], ...branch.required ?? []],
    properties: { ...merged.properties, ...branch.properties }
  }), rest);
}
function claim(claimed, original) {
  const shortname = ontologyShortname(original);
  const existing = claimed.get(shortname);
  if (existing !== void 0 && existing !== original) {
    throw new Error(`Ontology shortname ${shortname} is claimed by both ${existing} and ${original}`);
  }
  claimed.set(shortname, original);
  return shortname;
}
function deriveOntology(document) {
  const title = document.info?.title?.trim() ?? "";
  const base = title ? ontologyShortname(title) : "ontology";
  const terms = [];
  const classNames = /* @__PURE__ */ new Map();
  const propertyNames = /* @__PURE__ */ new Map();
  const propertyIndex = /* @__PURE__ */ new Map();
  const agreed = /* @__PURE__ */ new Map();
  for (const [resource, def] of Object.entries(crudResourcesOf(document))) {
    if (!isRecord(def)) {
      continue;
    }
    const classShortname = claim(classNames, resource);
    const schema = flattenSchema(def["schema"]);
    const required = new Set(schema.required ?? []);
    const requires = [];
    const recommends = [];
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      const shortname = claim(propertyNames, field);
      const datatype = datatypeOf(fieldSchema);
      let index = propertyIndex.get(shortname);
      if (index === void 0) {
        index = terms.length;
        propertyIndex.set(shortname, index);
        agreed.set(index, datatype);
        terms.push({
          path: `${base}/property/${shortname}`,
          kind: "property",
          shortname,
          description: typeof fieldSchema.description === "string" ? fieldSchema.description : `\`${field}\` of \`${resource}\`.`,
          datatype: datatype ?? DATATYPES.json,
          requires: [],
          recommends: []
        });
      } else if (agreed.get(index) !== datatype) {
        agreed.set(index, void 0);
        terms[index].datatype = DATATYPES.json;
      }
      (required.has(field) ? requires : recommends).push(terms[index].path);
    }
    terms.push({
      path: `${base}/class/${classShortname}`,
      kind: "class",
      shortname: classShortname,
      description: typeof def["description"] === "string" ? def["description"] : `The \`${resource}\` resource.`,
      datatype: DATATYPES.json,
      requires,
      recommends
    });
  }
  return {
    description: title ? `Derived from the "${title}" OpenAPI document.` : "Derived from an OpenAPI document.",
    terms
  };
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/pagination/validate.js
var SCHEME_TYPES = /* @__PURE__ */ new Set(["pageNumber", "pageToken", "nextLink"]);
var REQUEST_ROLES = /* @__PURE__ */ new Set([
  "page",
  "pageSize",
  "offset",
  "pageToken",
  "cursor"
]);
var RESPONSE_ROLES = /* @__PURE__ */ new Set([
  "nextPageToken",
  "nextCursor",
  "nextLink",
  "totalCount",
  "totalPages",
  "pageSize",
  "currentPage"
]);
function isExtensionKey(key) {
  return key.startsWith("x-");
}
function validatePaginationScheme(name, scheme) {
  const errors = [];
  const path = `paginationSchemes.${name}`;
  if (!SCHEME_TYPES.has(scheme.type)) {
    errors.push(`${path}.type must be one of pageNumber, pageToken, or nextLink (got "${String(scheme.type)}")`);
  }
  if (!scheme.request && !scheme.response) {
    errors.push(`${path} must define at least one of "request" or "response"`);
  }
  for (const [fieldName, field] of Object.entries(scheme.request?.queryParameters ?? {})) {
    if (field.role && !isExtensionKey(field.role) && !REQUEST_ROLES.has(field.role)) {
      errors.push(`${path}.request.queryParameters.${fieldName}.role is not a valid request role (got "${field.role}")`);
    }
  }
  for (const [fieldName, field] of Object.entries(scheme.request?.bodyFields ?? {})) {
    if (field.role && !isExtensionKey(field.role) && !REQUEST_ROLES.has(field.role)) {
      errors.push(`${path}.request.bodyFields.${fieldName}.role is not a valid request role (got "${field.role}")`);
    }
  }
  for (const [fieldName, field] of Object.entries(scheme.response?.bodyFields ?? {})) {
    if (field.role && !isExtensionKey(field.role) && !RESPONSE_ROLES.has(field.role)) {
      errors.push(`${path}.response.bodyFields.${fieldName}.role is not a valid response role (got "${field.role}")`);
    }
  }
  for (const [fieldName, field] of Object.entries(scheme.response?.headers ?? {})) {
    if (field.role && !isExtensionKey(field.role) && !RESPONSE_ROLES.has(field.role)) {
      errors.push(`${path}.response.headers.${fieldName}.role is not a valid response role (got "${field.role}")`);
    }
  }
  return errors;
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/pagination/autodetect.js
function validSchemes(document) {
  const map = /* @__PURE__ */ new Map();
  const schemes = document.components?.paginationSchemes ?? {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (validatePaginationScheme(name, scheme).length === 0) {
      map.set(name, scheme);
    }
  }
  return map;
}
function queryParamNames(operation) {
  return new Set((operation.parameters ?? []).filter((parameter) => parameter.in === "query").map((parameter) => parameter.name));
}
function bodyFieldNames(operation) {
  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  return new Set(Object.keys(schema?.properties ?? {}));
}
function autoDetectMatches(scheme, operation) {
  if (scheme.autoDetect === false) {
    return false;
  }
  const options = typeof scheme.autoDetect === "object" ? scheme.autoDetect : {};
  const requireAll = options.requireAll ?? true;
  const results = [];
  if (options.matchQueryParams ?? true) {
    const required = Object.keys(scheme.request?.queryParameters ?? {});
    if (required.length > 0) {
      const declared = queryParamNames(operation);
      results.push(required.every((name) => declared.has(name)));
    }
  }
  if (options.matchBodyFields ?? true) {
    const required = Object.keys(scheme.request?.bodyFields ?? {});
    if (required.length > 0) {
      const declared = bodyFieldNames(operation);
      results.push(required.every((name) => declared.has(name)));
    }
  }
  if (results.length === 0) {
    return false;
  }
  return requireAll ? results.every(Boolean) : results.some(Boolean);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepMerge(base, overrides) {
  const result = {
    ...base
  };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}
function resolveEffectiveScheme(document, operation) {
  const schemes = validSchemes(document);
  const explicit = operation["x-pagination"];
  if (Array.isArray(explicit) && explicit.length > 0) {
    const application = explicit[0];
    const base = application ? schemes.get(application.scheme) : void 0;
    if (!application || !base) {
      return void 0;
    }
    return {
      schemeName: application.scheme,
      scheme: application.overrides ? deepMerge(base, application.overrides) : base
    };
  }
  for (const [schemeName, scheme] of schemes) {
    if (autoDetectMatches(scheme, operation)) {
      return { schemeName, scheme };
    }
  }
  return void 0;
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/pagination/items.js
var COMMON_ITEMS_FIELDS = ["items", "data", "results", "records", "content"];
function effectiveProperties(schema) {
  if (!schema) {
    return {};
  }
  if (schema.allOf) {
    return schema.allOf.reduce((merged, branch) => ({ ...merged, ...effectiveProperties(branch) }), {});
  }
  return { ...schema.properties ?? {} };
}
function metadataFieldRoots(scheme) {
  const roots = /* @__PURE__ */ new Set();
  for (const key of Object.keys(scheme?.response?.bodyFields ?? {})) {
    roots.add(key.split(".")[0] ?? key);
  }
  return roots;
}
function locateItemsField(schema, scheme) {
  const properties = effectiveProperties(schema);
  const excluded = metadataFieldRoots(scheme);
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!excluded.has(name) && propertySchema.type === "array") {
      return name;
    }
  }
  return COMMON_ITEMS_FIELDS.find((name) => name in properties && !excluded.has(name));
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/pagination/response-parser.js
function readNestedField(body, path) {
  let node = body;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) {
      return void 0;
    }
    node = node[segment];
  }
  return node;
}
function setNestedField(body, path, value) {
  const segments = path.split(".");
  let node = body;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const child = node[segment];
    if (typeof child !== "object" || child === null) {
      node[segment] = {};
    }
    node = node[segment];
  }
  node[segments[segments.length - 1]] = value;
}
function parseLinkHeader(header) {
  if (!header) {
    return null;
  }
  const parts = header.split(/,\s*(?=<)/);
  for (const part of parts) {
    const match = part.match(/^\s*<([^>]+)>(.*)/);
    if (!match) {
      continue;
    }
    const [, url, attrs] = match;
    const relMatch = attrs?.match(/\brel\s*=\s*"?([^";,\s]+)"?/i);
    if (relMatch?.[1]?.trim().toLowerCase() === "next") {
      return url ?? null;
    }
  }
  return null;
}
function toStringOrNull(value) {
  if (value === null || value === void 0 || value === "") {
    return null;
  }
  return String(value);
}
function toNumberOrNull(value) {
  if (value === null || value === void 0) {
    return null;
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}
function extractByRole(scheme, body, headers) {
  const roles = /* @__PURE__ */ new Map();
  for (const [path, field] of Object.entries(scheme.response?.bodyFields ?? {})) {
    if (!field.role)
      continue;
    const value = readNestedField(body, path);
    if (value !== void 0) {
      roles.set(field.role, value);
    }
  }
  for (const [name, field] of Object.entries(scheme.response?.headers ?? {})) {
    if (!field.role)
      continue;
    const raw = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    if (raw === void 0)
      continue;
    if (field.role === "nextLink") {
      const parsed = parseLinkHeader(raw);
      if (parsed)
        roles.set("nextLink", parsed);
    } else {
      roles.set(field.role, raw);
    }
  }
  return roles;
}
function deriveHasNextPage(type, state, itemsFetchedSoFar) {
  if (state.nextLink !== null || state.nextPageToken !== null) {
    return true;
  }
  if (state.totalCount !== null && itemsFetchedSoFar !== void 0) {
    return itemsFetchedSoFar < state.totalCount;
  }
  if (type === "pageNumber") {
    if (state.currentPage !== null && state.totalPages !== null) {
      return state.currentPage < state.totalPages;
    }
    if (state.currentPage !== null && state.totalCount !== null && state.pageSize !== null) {
      return state.currentPage * state.pageSize < state.totalCount;
    }
  }
  return false;
}
function parsePaginationState(scheme, body, headers = {}, itemsFetchedSoFar) {
  const roles = extractByRole(scheme, body, headers);
  const state = {
    nextPageToken: toStringOrNull(roles.get("nextPageToken") ?? roles.get("nextCursor") ?? null),
    nextLink: toStringOrNull(roles.get("nextLink") ?? null),
    currentPage: toNumberOrNull(roles.get("currentPage") ?? null),
    totalCount: toNumberOrNull(roles.get("totalCount") ?? null),
    totalPages: toNumberOrNull(roles.get("totalPages") ?? null),
    pageSize: toNumberOrNull(roles.get("pageSize") ?? null),
    hasNextPage: false
  };
  state.hasNextPage = deriveHasNextPage(scheme.type, state, itemsFetchedSoFar);
  return state;
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/pagination/request-builder.js
function fieldsWithRole(scheme, role, locations = ["queryParameters"]) {
  return locations.flatMap((location) => Object.entries(scheme.request?.[location] ?? {}).filter(([, field]) => field.role === role).map(([name]) => name));
}
function cursorValues(scheme, cursor, pageSize, location) {
  const values = {};
  const withRole = (role) => fieldsWithRole(scheme, role, [location]);
  if (pageSize !== void 0) {
    for (const name of withRole("pageSize")) {
      values[name] = pageSize;
    }
  }
  for (const name of withRole("offset")) {
    values[name] = cursor.offset ?? 0;
  }
  for (const name of withRole("page")) {
    values[name] = cursor.page ?? 1;
  }
  if (cursor.pageToken !== void 0) {
    for (const name of [...withRole("pageToken"), ...withRole("cursor")]) {
      values[name] = cursor.pageToken;
    }
  }
  return values;
}
function buildQuery(scheme, cursor, pageSize) {
  const query = {};
  for (const [name, value] of Object.entries(cursorValues(scheme, cursor, pageSize, "queryParameters"))) {
    query[name] = String(value);
  }
  return query;
}
function buildBody(scheme, cursor, pageSize) {
  const body = {};
  for (const [name, value] of Object.entries(cursorValues(scheme, cursor, pageSize, "bodyFields"))) {
    setNestedField(body, name, value);
  }
  return body;
}
function nextCursor(scheme, cursor, state, itemsReturned) {
  if (!state.hasNextPage) {
    return null;
  }
  const both = ["queryParameters", "bodyFields"];
  switch (scheme.type) {
    case "pageToken":
      return state.nextPageToken !== null ? { pageToken: state.nextPageToken } : null;
    case "nextLink":
      return null;
    case "pageNumber":
      if (fieldsWithRole(scheme, "offset", both).length > 0) {
        return { offset: (cursor.offset ?? 0) + itemsReturned };
      }
      if (fieldsWithRole(scheme, "page", both).length > 0) {
        return { page: (cursor.page ?? 1) + 1 };
      }
      return null;
  }
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/read/transport.js
function lowerCaseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/read/pages.js
var DEFAULT_READ_LIMITS = {
  maxRequests: 1e4,
  maxRecords: 5e3,
  timeoutMs: 30 * 60 * 1e3,
  maxRetries: 3
};
var BudgetExhausted = class extends Error {
};
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var Budget = class {
  transport;
  sleep;
  limits;
  deadline;
  requests = 0;
  constructor(transport, limits = {}, sleep = defaultSleep) {
    this.transport = transport;
    this.sleep = sleep;
    this.limits = { ...DEFAULT_READ_LIMITS, ...limits };
    this.deadline = Date.now() + this.limits.timeoutMs;
  }
  async send(request) {
    for (let retries = 0; ; retries += 1) {
      if (Date.now() > this.deadline) {
        throw new BudgetExhausted("Read timed out");
      }
      this.requests += 1;
      if (this.requests > this.limits.maxRequests) {
        throw new BudgetExhausted(`Read exceeds ${this.limits.maxRequests} requests; narrow its scope`);
      }
      const raw = await this.transport(request);
      const response = { ...raw, headers: lowerCaseHeaders(raw.headers) };
      if (response.status !== 429 || retries >= this.limits.maxRetries) {
        return response;
      }
      const retryAfter = response.headers["retry-after"];
      const seconds = Number(retryAfter);
      const at = retryAfter !== void 0 && retryAfter !== "" && Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1e3 : retryAfter ? Date.parse(retryAfter) : NaN;
      if (!Number.isFinite(at)) {
        return response;
      }
      const delay = Math.max(0, at - Date.now());
      if (Date.now() + delay > this.deadline) {
        throw new Error("API retry delay exceeds the remaining read time");
      }
      await this.sleep(delay);
    }
  }
};
var COMMON_ITEMS_FIELDS2 = ["items", "data", "results", "records", "content"];
function pageItems(body, responseSchema, scheme) {
  let array;
  if (Array.isArray(body)) {
    array = body;
  } else if (isRecord(body)) {
    const field = locateItemsField(responseSchema, scheme) ?? COMMON_ITEMS_FIELDS2.find((name) => Array.isArray(body[name]));
    array = field === void 0 ? void 0 : body[field];
  }
  if (!Array.isArray(array)) {
    throw new Error("Could not locate the items array in the response");
  }
  return array.filter(isRecord);
}
function bindPath(template, values) {
  return template.replace(/\{([^}]+)\}/g, (_, name) => {
    const value = values[name];
    if (value === void 0 || value === "") {
      throw new Error(`Missing value for ${name}`);
    }
    return encodeURIComponent(value);
  });
}
function withBody(body, cursorFields) {
  const merged = structuredClone(body);
  const flat = [];
  const collect = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      if (isRecord(value)) {
        collect(value, `${prefix}${key}.`);
      } else {
        flat.push([`${prefix}${key}`, value]);
      }
    }
  };
  collect(cursorFields, "");
  for (const [path, value] of flat) {
    setNestedField(merged, path, value);
  }
  return merged;
}
async function* walkPages(walk) {
  const { document, operation, budget, upstream } = walk;
  const effective = resolveEffectiveScheme(document, operation);
  const scheme = effective?.scheme;
  const responseSchema = operation.responses?.["200"]?.content?.["application/json"]?.schema;
  const basePath = upstream.pathname.replace(/\/$/, "");
  const seen = /* @__PURE__ */ new Set();
  let cursor = {};
  let next;
  let itemsSoFar = 0;
  for (; ; ) {
    let url = next;
    if (!url) {
      url = new URL(upstream.href);
      url.pathname = basePath + walk.path;
      const query = {
        ...walk.query,
        ...scheme ? buildQuery(scheme, cursor, walk.pageSize) : {}
      };
      for (const [key2, value] of Object.entries(query)) {
        url.searchParams.set(key2, value);
      }
    }
    const request = {
      url,
      method: walk.method,
      headers: { accept: "application/json" }
    };
    if (walk.method === "POST") {
      request.headers["content-type"] = "application/json";
      request.body = JSON.stringify(next || !scheme ? walk.body : withBody(walk.body, buildBody(scheme, cursor, walk.pageSize)));
    }
    const key = `${request.method} ${url.href} ${request.body ?? ""}`;
    if (seen.has(key)) {
      throw new Error("Pagination repeated a page; stopping");
    }
    seen.add(key);
    const response = await budget.send(request);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${request.method} ${url.pathname} responded ${response.status}`);
    }
    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error(`${request.method} ${url.pathname} did not return JSON`);
    }
    const items = pageItems(body, responseSchema, scheme);
    itemsSoFar += items.length;
    yield { url, items };
    if (!scheme) {
      return;
    }
    const state = parsePaginationState(scheme, isRecord(body) ? body : {}, response.headers, itemsSoFar);
    if (!state.hasNextPage) {
      return;
    }
    if (scheme.type === "nextLink" || state.nextLink !== null && state.nextPageToken === null) {
      if (state.nextLink === null) {
        return;
      }
      const link = new URL(state.nextLink, url);
      if (link.origin !== upstream.origin || link.username || link.password || link.hash) {
        throw new Error("Pagination left the API origin");
      }
      next = link;
    } else {
      if (scheme.type === "pageNumber" && items.length === 0) {
        return;
      }
      const following = nextCursor(scheme, cursor, state, items.length);
      if (!following) {
        return;
      }
      cursor = following;
      next = void 0;
    }
  }
}

// integrations/pets/node_modules/.pnpm/syncables@0.18.0/node_modules/syncables/build/src/read/read.js
var resolvedCache = /* @__PURE__ */ new WeakMap();
function resolved(document) {
  let result = resolvedCache.get(document);
  if (!result) {
    result = resolveRefs(document);
    resolvedCache.set(document, result);
  }
  return result;
}
function describePlatform(document) {
  const doc = resolved(document);
  return describeModel(doc, discoverReadModel(doc));
}
var ProbeDone = class extends Error {
};
function invocations(collection, model, constants, origins) {
  const groups = /* @__PURE__ */ new Map();
  for (const param of collection.contextParams) {
    if (param in constants) {
      continue;
    }
    const provider = model.providers.get(param);
    if (!provider) {
      continue;
    }
    groups.set(provider.collection, [
      ...groups.get(provider.collection) ?? [],
      { param, field: provider.field }
    ]);
  }
  let combos = [{ ...constants }];
  for (const [source, params] of groups) {
    const next = [];
    for (const combo of combos) {
      for (const parent of origins.get(source) ?? []) {
        const values = { ...parent.path, ...combo };
        for (const { param, field } of params) {
          values[param] = asText(parent.value[field]);
        }
        if (params.every(({ param }) => values[param])) {
          next.push(values);
        }
      }
    }
    combos = next;
  }
  const seen = /* @__PURE__ */ new Set();
  return combos.filter((combo) => {
    const key = JSON.stringify(collection.contextParams.map((p) => combo[p] ?? ""));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
var TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
function typedValue(value, datatype) {
  if (value === null || value === void 0) {
    return void 0;
  }
  if (datatype === DATATYPES.timestamp) {
    if (typeof value !== "string" || !TIMESTAMP.test(value)) {
      throw new Error("Invalid provider timestamp");
    }
    return Date.parse(value);
  }
  return value;
}
async function readPlatform(document, options) {
  const doc = resolved(document);
  const budget = new Budget(options.transport, options.limits, options.sleep);
  const model = discoverReadModel(doc);
  applySelection(doc, model, options.selection);
  const upstream = upstreamOf(doc);
  const constants = options.constants;
  for (const param of rootParameters(model)) {
    if (!constants[param]) {
      throw new Error(`Enter a value for ${param}`);
    }
  }
  const ontology = options.probe ? { description: "", terms: [] } : deriveOntology(doc);
  const properties = new Map(ontology.terms.filter((t) => t.kind === "property").map((t) => [t.shortname, t.datatype]));
  const records = [];
  const identities = /* @__PURE__ */ new Set();
  const errors = [];
  const origins = /* @__PURE__ */ new Map();
  const walk = async (collection, path) => {
    const operation = listOperation(doc, collection.url, collection.method);
    if (!operation) {
      throw new Error(`${collection.url} declares no ${collection.method} operation`);
    }
    const namespace = collection.contextParams.map((p) => path[p] ?? "").join("/");
    const out = [];
    for await (const page of walkPages({
      document: doc,
      operation,
      budget,
      upstream,
      path: bindPath(collection.url, path),
      method: collection.method,
      query: collection.listQuery,
      body: collection.listBody
    })) {
      if (options.probe) {
        throw new ProbeDone();
      }
      for (const value of page.items) {
        const id = asText(value[collection.idField]);
        const key = JSON.stringify([collection.resource, namespace, id]);
        if (!id || identities.has(key)) {
          throw new Error("Missing or repeated record identity; pagination may not be forwarded by the proxy");
        }
        if (records.length >= budget.limits.maxRecords) {
          throw new BudgetExhausted(`Read exceeds ${budget.limits.maxRecords} records; narrow its scope`);
        }
        identities.add(key);
        const values = {};
        for (const [field, raw] of Object.entries(value)) {
          const shortname = ontologyShortname(field);
          const datatype = properties.get(shortname);
          if (!datatype) {
            continue;
          }
          const typed = typedValue(raw, datatype);
          if (typed !== void 0) {
            values[shortname] = typed;
          }
        }
        const name = [value["title"], value["summary"], value["name"]].find((v) => typeof v === "string" && v !== "");
        records.push({
          resource: ontologyShortname(collection.resource),
          namespace,
          id,
          name: name ?? id,
          values
        });
        out.push({ value, path });
      }
    }
    return out;
  };
  let pending = [...model.collections];
  while (pending.length) {
    const waiting = [];
    let progressed = false;
    for (const collection of pending) {
      const sources = collection.contextParams.filter((p) => !(p in constants)).map((p) => model.providers.get(p)?.collection);
      if (sources.some((s) => s === void 0 || s === collection.name)) {
        errors.push(`${collection.name}: its context has no provider`);
        progressed = true;
        continue;
      }
      if (!sources.every((source) => origins.has(source))) {
        waiting.push(collection);
        continue;
      }
      progressed = true;
      const read = [];
      for (const path of invocations(collection, model, constants, origins)) {
        try {
          read.push(...await walk(collection, path));
        } catch (error) {
          if (error instanceof ProbeDone) {
            return {
              platform: options.platform,
              ontology,
              records: [],
              errors: []
            };
          }
          if (options.probe) {
            throw error;
          }
          errors.push(`${collection.name}: ${error.message}`);
          if (error instanceof BudgetExhausted) {
            pending = [];
            break;
          }
        }
      }
      origins.set(collection.name, read);
      if (!pending.length) {
        break;
      }
    }
    if (!pending.length) {
      break;
    }
    if (!progressed) {
      for (const c of waiting) {
        errors.push(`${c.name}: its parent collection could not be read`);
      }
      break;
    }
    pending = waiting;
  }
  if (options.probe) {
    throw new Error("No collection available to check");
  }
  if (!records.length && errors.length) {
    throw new Error(`Read incomplete: ${errors.join("; ")}`);
  }
  return { platform: options.platform, ontology, records, errors };
}

// integrations/pets/app/openapi.json
var openapi_default = {
  openapi: "3.0.3",
  info: {
    title: "Pets",
    version: "1.0.0"
  },
  servers: [
    {
      url: "https://pets.example"
    }
  ],
  paths: {
    "/pets": {
      get: {
        "x-pagination": [
          {
            scheme: "nextLink"
          }
        ],
        responses: {
          "200": {
            description: "Pets",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    $ref: "#/components/schemas/Pet"
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    paginationSchemes: {
      nextLink: {
        type: "nextLink",
        response: {
          headers: {
            Link: {
              role: "nextLink"
            }
          }
        }
      }
    },
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: {
            type: "integer"
          },
          name: {
            type: "string"
          },
          species: {
            type: "string"
          },
          age: {
            type: "integer"
          },
          vaccinated: {
            type: "boolean"
          },
          weight: {
            type: "number"
          },
          updated_at: {
            type: "string",
            format: "date-time"
          }
        }
      }
    },
    crudResources: {
      pet: {
        schema: {
          $ref: "#/components/schemas/Pet"
        },
        identity: {
          urlTemplate: "/pets/{pet_id}",
          bindings: {
            pet_id: {
              field: "id"
            }
          }
        },
        collections: {
          pets: {
            urlTemplate: "/pets"
          }
        }
      }
    }
  }
};

// integrations/pets/app/sync.ts
var PLATFORM = "pets";
var PETS_DOCUMENT = openapi_default;
var A = "https://atomicdata.dev";
var PARENT = `${A}/properties/parent`;
var IS_A = `${A}/properties/isA`;
var NAME = `${A}/properties/name`;
var SHORTNAME = `${A}/properties/shortname`;
var DESCRIPTION = `${A}/properties/description`;
var DATATYPE = `${A}/properties/datatype`;
var RECOMMENDS = `${A}/properties/recommends`;
var PROPERTIES = `${A}/properties/properties`;
var PROPERTY_CLASS = `${A}/classes/Property`;
function displayName(shortname) {
  const words = shortname.split("-").join(" ");
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}
var asList = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
async function syncPets(store, transport, { read = readPlatform } = {}) {
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error("This app has no table with a row class to sync into.");
  const result = await read(PETS_DOCUMENT, {
    platform: PLATFORM,
    constants: {},
    transport
  });
  const klass = await store.getResource(data.rowClass);
  const ontologySubject = klass.get(PARENT);
  if (typeof ontologySubject !== "string")
    throw new Error("The row class has no parent ontology to add fields to.");
  const properties = await ensureProperties(
    store,
    ontologySubject,
    result.ontology.terms.filter(
      (t) => t.kind === "property" && t.shortname !== "name"
    )
  );
  const recommends = asList(klass.get(RECOMMENDS));
  const wanted = [NAME, ...properties.values()];
  const merged = [
    ...recommends,
    ...wanted.filter((s) => !recommends.includes(s))
  ];
  if (merged.length !== recommends.length || klass.get(NAME) !== "Pet") {
    await klass.set(RECOMMENDS, merged).set(NAME, "Pet").save();
  }
  const table = await store.getResource(data.table);
  if (table.get(NAME) !== "Pets") await table.set(NAME, "Pets").save();
  const idProperty = properties.get("id");
  if (!idProperty) throw new Error("The Pets API document has no id field.");
  const existing = /* @__PURE__ */ new Map();
  for (const subject of await store.query({
    property: PARENT,
    value: data.table
  })) {
    const row = await store.getResource(subject);
    const id = row.get(idProperty);
    if (id !== void 0 && id !== null) existing.set(String(id), row);
  }
  const summary = {
    total: result.records.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    errors: result.errors
  };
  for (const record of result.records) {
    const propVals = { [NAME]: record.name };
    for (const [shortname, value] of Object.entries(record.values)) {
      const property = properties.get(shortname);
      if (property) propVals[property] = value;
    }
    const row = existing.get(record.id);
    if (!row) {
      await store.newResource({
        parent: data.table,
        isA: [data.rowClass],
        propVals
      });
      summary.added++;
      continue;
    }
    const changed = Object.entries(propVals).filter(
      ([property, value]) => row.get(property) !== value
    );
    if (changed.length === 0) {
      summary.unchanged++;
      continue;
    }
    for (const [property, value] of changed) row.set(property, value);
    await row.save();
    summary.updated++;
  }
  return summary;
}
async function ensureProperties(store, ontologySubject, terms) {
  const ontology = await store.getResource(ontologySubject);
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = /* @__PURE__ */ new Map();
  for (const subject of listed) {
    const property = await store.getResource(subject);
    const shortname = property.get(SHORTNAME);
    if (typeof shortname === "string") byShortname.set(shortname, subject);
  }
  const created = [];
  const out = /* @__PURE__ */ new Map();
  for (const term of terms) {
    let subject = byShortname.get(term.shortname);
    if (!subject) {
      const name = displayName(term.shortname);
      const property = await store.newResource({
        parent: ontologySubject,
        isA: [PROPERTY_CLASS],
        propVals: {
          [SHORTNAME]: term.shortname,
          [NAME]: name,
          [DESCRIPTION]: term.description || `${name} of a pet, from the Pets API.`,
          [DATATYPE]: term.datatype
        }
      });
      subject = property.subject;
      created.push(subject);
    }
    out.set(term.shortname, subject);
  }
  if (created.length > 0)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();
  return out;
}

// integrations/pets/app/transport.ts
var RECONNECT_CODES = [
  "unknown_connection",
  "not_delegated",
  "capability_scope",
  "platform_mismatch",
  "credential_refresh_failed"
];
var REFUSAL_CODES = [
  ...RECONNECT_CODES,
  "missing_signature",
  "unsupported_signature_version",
  "invalid_agent",
  "agent_key_mismatch",
  "stale_timestamp",
  "bad_signature",
  "replayed",
  "invalid_capability",
  "capability_expired",
  "capability_too_long",
  "wrong_audience",
  "capability_key_mismatch",
  "not_owner",
  "access_denied"
];
function proxyRefusal(response) {
  const body = response.body;
  const code = typeof body?.error === "string" ? body.error : void 0;
  if (response.status < 400 || !code || !REFUSAL_CODES.includes(code))
    return void 0;
  const detail = typeof body?.message === "string" ? `: ${body.message}` : "";
  return new Error(
    RECONNECT_CODES.includes(code) ? `The integration proxy refused this connection (${code}${detail}). Connect again.` : `The integration proxy refused the request (${code}${detail}).`
  );
}
function relayTransport(proxy, reference, upstream) {
  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/$/, "");
  return async (request) => {
    const { url } = request;
    if (url.origin !== base.origin || prefix !== "" && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      throw new Error(`Refusing a request outside ${upstream}: ${url.href}`);
    const path = `${url.pathname.slice(prefix.length) || "/"}${url.search}`;
    const response = await proxy.request({
      ...reference,
      path,
      method: request.method,
      ...request.body !== void 0 ? { body: request.body } : {}
    });
    const refused = proxyRefusal(response);
    if (refused) throw refused;
    return {
      status: response.status,
      headers: response.headers ?? {},
      body: typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? null)
    };
  };
}

// integrations/pets/app/controller.ts
function describe(state) {
  switch (state.kind) {
    case "loading":
      return "Loading\u2026";
    case "no-relay":
      return "This host cannot reach the integration proxy for apps yet.";
    case "disconnected":
      return "Not connected. Connect your Pets account to import your pets.";
    case "connecting":
      return "Waiting for you to confirm the connection\u2026";
    case "ready":
      return "Connected.";
    case "syncing":
      return "Syncing\u2026";
    case "synced": {
      const s = state.summary;
      const errors = s.errors.length ? ` Skipped: ${s.errors.join("; ")}` : "";
      return `Last synced ${state.at.toLocaleTimeString()}: ${s.total} pets (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged).${errors}`;
    }
    case "error":
      return `Sync failed: ${state.message}`;
  }
}
var message = (error) => error instanceof Error ? error.message : String(error);
function createController(store, render, sync = syncPets) {
  let state = { kind: "loading" };
  const set = (next) => {
    state = next;
    render(state);
  };
  const upstream = describePlatform(PETS_DOCUMENT).upstream;
  return {
    state: () => state,
    /**
     * Finds this app's connection and starts one sync when there is one.
     * Resolves once the connection is known, not when the sync ends, so the
     * host sees the view as rendered straight away.
     */
    async load() {
      const proxy = store.proxy;
      if (!proxy) {
        set({ kind: "no-relay" });
        return {};
      }
      const [connection] = await proxy.connections({ platform: PLATFORM });
      if (!connection) {
        set({ kind: "disconnected" });
        return {};
      }
      set({ kind: "ready", connection });
      return { syncing: this.sync() };
    },
    async connect() {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: "no-relay" });
      set({ kind: "connecting" });
      try {
        const result = await proxy.connect({ platform: PLATFORM });
        if (result?.status === "connected") await this.load();
        else set({ kind: "disconnected" });
      } catch (error) {
        set({ kind: "error", message: message(error) });
      }
    },
    async sync() {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: "no-relay" });
      if (!("connection" in state) || !state.connection) return;
      if (state.kind === "syncing") return;
      const connection = state.connection;
      set({ kind: "syncing", connection });
      try {
        const summary = await sync(
          store,
          relayTransport(proxy, connection, upstream)
        );
        set({ kind: "synced", connection, at: /* @__PURE__ */ new Date(), summary });
      } catch (error) {
        set({ kind: "error", connection, message: message(error) });
      }
    }
  };
}

// integrations/pets/app/main.ts
async function view({ root, store }) {
  const doc = root.ownerDocument;
  const heading = doc.createElement("h1");
  heading.textContent = "Pets";
  const status = doc.createElement("p");
  status.setAttribute("role", "status");
  const connect = doc.createElement("button");
  connect.type = "button";
  connect.textContent = "Connect Pets";
  const sync = doc.createElement("button");
  sync.type = "button";
  sync.textContent = "Sync now";
  root.style.fontFamily = "system-ui, sans-serif";
  root.style.padding = "1rem";
  root.replaceChildren(heading, status, connect, sync);
  const render = (state) => {
    status.textContent = describe(state);
    connect.hidden = !(state.kind === "disconnected" || state.kind === "error" && !state.connection);
    sync.hidden = !(state.kind === "ready" || state.kind === "synced" || state.kind === "syncing" || state.kind === "error" && !!state.connection);
    sync.disabled = state.kind === "syncing";
  };
  const controller = createController(store, render);
  render(controller.state());
  connect.addEventListener("click", () => void controller.connect());
  sync.addEventListener("click", () => void controller.sync());
  await controller.load().catch((error) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  });
}
export {
  view
};
