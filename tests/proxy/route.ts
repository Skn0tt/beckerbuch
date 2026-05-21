// Playwright-shaped Route + ProxyRequest/ProxyResponse pair. The same
// ProxyRequest wrapper is emitted on the proxy's "request" event and
// returned from route.request(). ProxyResponse mirrors Playwright's
// Response (url/status/statusText/headers/body/text/json/request).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "undici";

// --------------------------------------------------------------------
// Public types

export interface FulfillOptions {
  status?: number;
  statusText?: string;
  headers?: Record<string, string | string[]>;
  /** Raw body. String → utf-8. Buffer → bytes. */
  body?: string | Buffer | Uint8Array;
  /** Convenience: JSON-stringify + set content-type. */
  json?: unknown;
  /** Fulfill from a fetch Response (e.g. transformed passthrough). */
  response?: Response;
}

export interface ContinueOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
}

export type RouteHandler = (route: Route) => void | Promise<void>;

/**
 * Playwright-shape Request. Returned from `route.request()` AND emitted
 * on the proxy's "request" event.
 */
export interface ProxyRequest {
  url(): string;
  method(): string;
  /** Lower-cased keys, multi-value joined with `,` (Playwright shape). */
  headers(): Record<string, string>;
  /** Body as utf-8 text, or null if the request had no body. */
  postData(): string | null;
  /** Body as a Buffer, or null if the request had no body. */
  postDataBuffer(): Buffer | null;
  /** Body parsed as JSON. Throws if invalid JSON / no body. */
  postDataJSON(): unknown;
}

/** Playwright-shape Response, fired on the proxy's "response" event. */
export interface ProxyResponse {
  url(): string;
  status(): number;
  statusText(): string;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  request(): ProxyRequest;
}

/** What we send back to the client. Used to build a ProxyResponse. */
export interface ResponseSnapshot {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
}

// --------------------------------------------------------------------
// ProxyRequest

export function buildProxyRequest(
  req: IncomingMessage,
  absoluteUrl: string,
  bodyBuf: Buffer,
): ProxyRequest {
  const method = req.method ?? "GET";
  const headers = normaliseHeaders(req.rawHeaders);
  const hasBody = bodyBuf.length > 0;
  return {
    url: () => absoluteUrl,
    method: () => method,
    headers: () => ({ ...headers }),
    postData: () => (hasBody ? bodyBuf.toString("utf8") : null),
    postDataBuffer: () => (hasBody ? Buffer.from(bodyBuf) : null),
    postDataJSON: () => {
      if (!hasBody) throw new Error("postDataJSON: request had no body");
      return JSON.parse(bodyBuf.toString("utf8")) as unknown;
    },
  };
}

export function buildProxyResponse(
  request: ProxyRequest,
  snapshot: ResponseSnapshot,
): ProxyResponse {
  const headersLower: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot.headers)) {
    headersLower[k.toLowerCase()] = v;
  }
  return {
    url: () => request.url(),
    status: () => snapshot.status,
    statusText: () => snapshot.statusText,
    headers: () => ({ ...headersLower }),
    body: async () => Buffer.from(snapshot.body),
    text: async () => snapshot.body.toString("utf8"),
    json: async () => JSON.parse(snapshot.body.toString("utf8")) as unknown,
    request: () => request,
  };
}

// --------------------------------------------------------------------
// Route

export class Route {
  private settled = false;
  /** Recorded outbound response, populated by fulfill()/continue(). null = aborted. */
  private snapshot: ResponseSnapshot | null = null;

  constructor(
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
    /** Absolute URL the original CONNECT/host header reconstructed. */
    private readonly absoluteUrl: string,
    private readonly bodyBuf: Buffer,
    private readonly dispatcher: Agent,
    private readonly _request: ProxyRequest,
  ) {}

  /** The intercepted request (Playwright-shape). */
  request(): ProxyRequest {
    return this._request;
  }

  /** Absolute URL of the intercepted request. */
  url(): string {
    return this.absoluteUrl;
  }

  async fulfill(options: FulfillOptions = {}): Promise<void> {
    this.assertUnsettled();
    this.settled = true;

    let status = options.status ?? 200;
    let statusText = options.statusText;
    const headers: Record<string, string | string[]> = {};

    let body: Buffer = Buffer.alloc(0);
    if (options.response) {
      status = options.response.status;
      statusText = statusText ?? options.response.statusText;
      options.response.headers.forEach((v, k) => {
        if (HOP_BY_HOP.has(k.toLowerCase())) return;
        if (k.toLowerCase() === "content-length") return;
        headers[k] = v;
      });
      const ab = await options.response.arrayBuffer();
      body = Buffer.from(ab);
    } else if (options.json !== undefined) {
      body = Buffer.from(JSON.stringify(options.json), "utf8");
      headers["content-type"] = "application/json";
    } else if (typeof options.body === "string") {
      body = Buffer.from(options.body, "utf8");
    } else if (options.body) {
      body = Buffer.from(
        options.body.buffer,
        options.body.byteOffset,
        options.body.byteLength,
      );
    }

    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) headers[k] = v;
    }
    if (!hasHeader(headers, "content-length")) {
      headers["content-length"] = String(body.length);
    }

    this.res.writeHead(status, statusText, headers);
    this.res.end(body);

    this.snapshot = {
      status,
      statusText: statusText ?? defaultStatusText(status),
      headers: flattenHeaders(headers),
      body,
    };
  }

  async continue(options: ContinueOptions = {}): Promise<void> {
    this.assertUnsettled();
    const response = await this.doFetch(options);
    await this.fulfill({ response });
  }

  async fetch(options: ContinueOptions = {}): Promise<Response> {
    return this.doFetch(options);
  }

  abort(reason: string = "failed"): void {
    this.assertUnsettled();
    this.settled = true;
    this.res.socket?.destroy(new Error(`route.abort: ${reason}`));
    // snapshot stays null → no "response" event emitted.
  }

  /** Has the route been fulfilled/continued/aborted? */
  isSettled(): boolean {
    return this.settled;
  }

  /** Captured snapshot of what we sent back, or null if aborted/not settled. */
  responseSnapshot(): ResponseSnapshot | null {
    return this.snapshot;
  }

  private async doFetch(options: ContinueOptions): Promise<Response> {
    const url = options.url ?? this.absoluteUrl;
    const method = options.method ?? this.req.method ?? "GET";

    const headers = new Headers();
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) headers.set(k, v);
    } else {
      // Forward incoming headers, minus hop-by-hop + Host (let undici set it).
      for (let i = 0; i < this.req.rawHeaders.length; i += 2) {
        const k = this.req.rawHeaders[i];
        const v = this.req.rawHeaders[i + 1];
        const kl = k.toLowerCase();
        if (HOP_BY_HOP.has(kl) || kl === "host" || kl === "content-length") continue;
        headers.append(k, v);
      }
    }

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      body =
        typeof options.body === "string"
          ? options.body
          : (toUint8(options.body) as unknown as BodyInit);
    } else if (methodHasBody(method) && this.bodyBuf.length > 0) {
      body = toUint8(this.bodyBuf) as unknown as BodyInit;
    }

    return fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      // undici-specific option (no proxy → don't recurse).
      dispatcher: this.dispatcher,
    } as RequestInit & { dispatcher: unknown });
  }

  private assertUnsettled(): void {
    if (this.settled) {
      throw new Error("Route already settled (fulfilled/continued/aborted)");
    }
  }
}

// --------------------------------------------------------------------
// Helpers

function normaliseHeaders(rawHeaders: string[]): Record<string, string> {
  // Multi-value headers are joined with `, ` to match Playwright's shape.
  const out: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const k = rawHeaders[i].toLowerCase();
    const v = rawHeaders[i + 1];
    out[k] = k in out ? `${out[k]}, ${v}` : v;
  }
  return out;
}

function flattenHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function defaultStatusText(status: number): string {
  // Tiny subset is enough — Node fills the rest, but our snapshot must
  // be a plain string when no statusText was supplied.
  return STATUS_TEXTS[status] ?? "";
}

const STATUS_TEXTS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function toUint8(buf: string | Buffer | Uint8Array): Uint8Array {
  if (typeof buf === "string") return new TextEncoder().encode(buf);
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

export function methodHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "DELETE" && m !== "OPTIONS";
}

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function hasHeader(
  headers: Record<string, string | string[]>,
  name: string,
): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

// --------------------------------------------------------------------
// Matcher

export type RoutePattern = string | RegExp | ((url: URL) => boolean);

export function matchPattern(pattern: RoutePattern, urlStr: string): boolean {
  if (typeof pattern === "function") {
    return pattern(new URL(urlStr));
  }
  if (pattern instanceof RegExp) return pattern.test(urlStr);
  return globMatch(pattern, urlStr);
}

// Playwright-ish glob: `*` matches any chars except `/`, `**` matches
// any chars including `/`. Anchors at start + end. Plain strings
// without globs match exact URL.
function globMatch(pattern: string, urlStr: string): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re).test(urlStr);
}
