// Playwright-shape Request wrapper around mockttp's CompletedRequest.

import type { CompletedRequest } from "mockttp";

import { allValues, firstHeader, normaliseHeaders } from "./internal/headers";
import type { ProxyResponse } from "./response";

/**
 * Playwright-shape Request. Returned from `route.request()` AND emitted
 * on the proxy's "request" event.
 */
export interface ProxyRequest {
  url(): string;
  method(): string;
  /** Lower-cased keys, multi-value joined with `, ` (Playwright shape). */
  headers(): Record<string, string>;
  /** Async sibling of `headers()`, mirrors Playwright's API. */
  allHeaders(): Promise<Record<string, string>>;
  /** First value of `name` (case-insensitive), or null. */
  headerValue(name: string): string | null;
  /** All values for `name` (case-insensitive), in occurrence order. */
  headerValues(name: string): string[];
  /** Body as utf-8 text, or null if the request had no body. */
  postData(): string | null;
  /** Body as a Buffer, or null if the request had no body. */
  postDataBuffer(): Buffer | null;
  /** Body parsed as JSON. Throws if invalid JSON / no body. */
  postDataJSON(): unknown;
  /**
   * Resolve with the response once it arrives, or `null` if the
   * request was aborted / failed.
   */
  response(): Promise<ProxyResponse | null>;
}

export function buildProxyRequest(
  req: CompletedRequest,
  responsePromise: Promise<ProxyResponse | null>,
): ProxyRequest {
  const url = req.url;
  const method = req.method;
  const rawHeaders = req.rawHeaders;
  const headers = normaliseHeaders(rawHeaders);
  const bodyBuf = req.body.buffer ?? Buffer.alloc(0);
  const hasBody = bodyBuf.length > 0;
  return {
    url: () => url,
    method: () => method,
    headers: () => ({ ...headers }),
    allHeaders: async () => ({ ...headers }),
    headerValue: (name) => firstHeader(rawHeaders, name),
    headerValues: (name) => allValues(rawHeaders, name),
    postData: () => (hasBody ? bodyBuf.toString("utf8") : null),
    postDataBuffer: () => (hasBody ? Buffer.from(bodyBuf) : null),
    postDataJSON: () => {
      if (!hasBody) throw new Error("postDataJSON: request had no body");
      return JSON.parse(bodyBuf.toString("utf8")) as unknown;
    },
    response: () => responsePromise,
  };
}
