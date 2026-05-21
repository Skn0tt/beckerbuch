// Playwright-shaped Route: wraps the decrypted incoming HTTP request
// inside the proxy, and gives the handler a fetch-API Request plus
// fulfill/continue/abort/fetch knobs. Mirrors the shape of
// page.route() in Playwright so specs feel familiar.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "undici";

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

// Internal: dispatcher used for outbound fetch from inside the proxy.
// Must NOT use ProxyAgent — otherwise we'd recurse through ourselves.
// Threaded from createProxy so tests can configure trusted CAs.

export class Route {
  private settled = false;
  private readonly _request: Request;

  constructor(
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
    /** Absolute URL the original CONNECT/host header reconstructed. */
    private readonly absoluteUrl: string,
    private readonly bodyBuf: Buffer,
    private readonly dispatcher: Agent,
  ) {
    this._request = buildRequest(req, absoluteUrl, bodyBuf);
  }

  /** The intercepted request, as a fetch Request. */
  request(): Request {
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
        // Skip hop-by-hop + body-framing headers that Node sets itself.
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

  /** Has the route been fulfilled/continued/aborted? */
  isSettled(): boolean {
    return this.settled;
  }

  private assertUnsettled(): void {
    if (this.settled) {
      throw new Error("Route already settled (fulfilled/continued/aborted)");
    }
  }
}

function buildRequest(
  req: IncomingMessage,
  absoluteUrl: string,
  bodyBuf: Buffer,
): Request {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i];
    const v = req.rawHeaders[i + 1];
    if (k.toLowerCase() === "host") continue;
    headers.append(k, v);
  }
  const init: RequestInit = {
    method: req.method ?? "GET",
    headers,
  };
  if (methodHasBody(req.method ?? "GET") && bodyBuf.length > 0) {
    init.body = toUint8(bodyBuf) as unknown as BodyInit;
    // Required by undici for streaming bodies; harmless for buffers.
    (init as { duplex?: string }).duplex = "half";
  }
  return new Request(absoluteUrl, init);
}

function toUint8(buf: string | Buffer | Uint8Array): Uint8Array {
  if (typeof buf === "string") return new TextEncoder().encode(buf);
  // Copy into a plain ArrayBuffer-backed Uint8Array to avoid the
  // SharedArrayBuffer-flavour incompatibility in BodyInit types.
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

function methodHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "DELETE" && m !== "OPTIONS";
}

const HOP_BY_HOP = new Set([
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
  const url = new URL(urlStr);
  if (typeof pattern === "function") return pattern(url);
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
