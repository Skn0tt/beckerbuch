// Playwright-shape Response wrapper around mockttp's CompletedResponse.

import type { CompletedResponse } from "mockttp";

import { allValues, firstHeader } from "./internal/headers";
import type { ProxyRequest } from "./request";

/** Playwright-shape Response, fired on the proxy's "response" event. */
export interface ProxyResponse {
  url(): string;
  status(): number;
  statusText(): string;
  /** True for 2xx. */
  ok(): boolean;
  headers(): Record<string, string>;
  allHeaders(): Promise<Record<string, string>>;
  headerValue(name: string): string | null;
  headerValues(name: string): string[];
  body(): Promise<Buffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  request(): ProxyRequest;
}

export function buildProxyResponse(
  request: ProxyRequest,
  res: CompletedResponse,
): ProxyResponse {
  const headersLower: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    headersLower[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  }
  const rawHeaders: Array<[string, string]> = res.rawHeaders ?? [];
  const buf = res.body?.buffer ?? Buffer.alloc(0);
  const status = res.statusCode;
  return {
    url: () => request.url(),
    status: () => status,
    statusText: () => res.statusMessage ?? "",
    ok: () => status >= 200 && status < 300,
    headers: () => ({ ...headersLower }),
    allHeaders: async () => ({ ...headersLower }),
    headerValue: (name) => firstHeader(rawHeaders, name),
    headerValues: (name) => allValues(rawHeaders, name),
    body: async () => Buffer.from(buf),
    text: async () => buf.toString("utf8"),
    json: async () => JSON.parse(buf.toString("utf8")) as unknown,
    request: () => request,
  };
}
