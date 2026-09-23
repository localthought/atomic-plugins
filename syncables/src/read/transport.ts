/**
 * The read path's only way to reach the network: a caller-supplied function.
 * In a browser plugin that is the host's `request()` into an integration
 * proxy; in a test it is a stub; `fetchTransport` adapts anything
 * fetch-shaped. Nothing under `src/read/` calls `fetch` itself.
 */

export type ListMethod = 'GET' | 'POST';

export interface TransportRequest {
  /** Absolute URL under the document's `servers[0].url`. */
  url: URL;
  method: ListMethod;
  /** Lower-case header names. `content-type` is set for a POST. */
  headers: Record<string, string>;
  /** JSON text; only present for a POST. */
  body?: string;
}

export interface TransportResponse {
  status: number;
  /** Header names in any case; the read path lower-cases them. */
  headers: Record<string, string>;
  /** Raw response text; the read path parses it as JSON. */
  body: string;
}

export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;

/** The subset of `fetch` that `fetchTransport` calls. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

/** Adapts `fetch` (or a host function with its shape) to a `Transport`. */
export function fetchTransport(fetchLike: FetchLike): Transport {
  return async (request) => {
    const response = await fetchLike(request.url.href, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}

export function lowerCaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}
