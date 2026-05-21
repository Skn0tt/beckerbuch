// Playwright-shape Route.
//
// `Route` uses an internal deferred so `fulfill` / `continue` /
// `abort` / `fetch` / `fallback` work whether the route handler
// resolves them inline or stashes the route and resolves them later
// — matching Playwright's contract. The chain walker awaits
// `_settled` to drive each registered handler.

import { readFile } from "node:fs/promises";

import type { CompletedRequest } from "mockttp";

import { HOP_BY_HOP, methodHasBody, toUint8 } from "./internal/headers";
import { inferContentType } from "./internal/mime";
import type { ProxyRequest } from "./request";

/**
 * Shape returned from a mockttp `.thenCallback(...)` to control how the
 * response is sent. Re-declared here because the internal type isn't
 * re-exported from `mockttp`'s main entry point.
 */
export type MockttpCallbackResult =
  | {
      statusCode?: number;
      statusMessage?: string;
      headers?: Record<string, string | string[]>;
      body?: string | Buffer | Uint8Array;
    }
  | "close"
  | "reset";

/**
 * Outcome of a single Route lifecycle. The chain walker uses `kind` to
 * decide whether the request is settled (`response`) or should
 * delegate to the next handler in the chain (`fallback`).
 */
export type RouteOutcome =
  | { kind: "response"; result: MockttpCallbackResult }
  | { kind: "fallback" };

export interface FulfillOptions {
  status?: number;
  statusText?: string;
  headers?: Record<string, string | string[]>;
  /** Raw body. String → utf-8. Buffer → bytes. */
  body?: string | Buffer | Uint8Array;
  /** Convenience: JSON-stringify + set content-type. */
  json?: unknown;
  /**
   * Read body from a file path. Content-type is inferred from the
   * extension unless overridden via `contentType` or `headers`.
   */
  path?: string;
  /** Override response content-type. */
  contentType?: string;
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

/** Callback used by Route to perform an upstream fetch for continue/fetch. */
export type RouteFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export class Route {
  private settled = false;
  private resolveSettled!: (value: RouteOutcome) => void;
  private rejectSettled!: (reason: unknown) => void;
  /**
   * Promise the chain walker awaits. Resolves with the route's outcome
   * — a concrete response (fulfill/continue/abort/fetch) or a fallback
   * sentinel that asks the walker to invoke the next handler.
   */
  readonly _settled: Promise<RouteOutcome>;

  constructor(
    private readonly _request: ProxyRequest,
    /** Underlying mockttp request (used by `continue`/`fetch` to forward bytes). */
    private readonly mreq: CompletedRequest,
    /** Outbound fetcher for `continue` / `fetch`. */
    private readonly fetcher: RouteFetcher,
  ) {
    this._settled = new Promise<RouteOutcome>((resolve, reject) => {
      this.resolveSettled = resolve;
      this.rejectSettled = reject;
    });
    // Swallow unhandled-rejection warnings from this promise; we only
    // surface its rejection through the chain walker.
    this._settled.catch(() => {});
  }

  /** The intercepted request (Playwright-shape). */
  request(): ProxyRequest {
    return this._request;
  }

  /** Absolute URL of the intercepted request. */
  url(): string {
    return this._request.url();
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
    } else if (options.path !== undefined) {
      body = await readFile(options.path);
      const inferred = options.contentType ?? inferContentType(options.path);
      if (inferred) headers["content-type"] = inferred;
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

    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) headers[k] = v;
    }

    this.resolveSettled({
      kind: "response",
      result: {
        statusCode: status,
        statusMessage: statusText,
        headers,
        body,
      },
    });
  }

  async continue(options: ContinueOptions = {}): Promise<void> {
    this.assertUnsettled();
    const response = await this.doFetch(options);
    await this.fulfill({ response });
  }

  async fetch(options: ContinueOptions = {}): Promise<Response> {
    return this.doFetch(options);
  }

  abort(_reason: string = "failed"): void {
    this.assertUnsettled();
    this.settled = true;
    // mockttp resets the connection — closest to Playwright's ERR_FAILED.
    // We don't honour the various `reason` codes (namenotresolved etc.)
    // — TCP reset is the only signal we can produce from a forward proxy.
    this.resolveSettled({ kind: "response", result: "reset" });
  }

  /**
   * Delegate to the next-registered handler in the chain. If no more
   * handlers match, the request passes through to the network. Like
   * `fulfill`, this may be called after the route handler returns.
   */
  fallback(): void {
    this.assertUnsettled();
    this.settled = true;
    this.resolveSettled({ kind: "fallback" });
  }

  /**
   * Internal: fail the route from a thrown handler. Only used by the
   * server facade when the user's handler throws *without* having
   * settled the route. If the route is already settled, this is a no-op.
   */
  _failFromHandler(err: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectSettled(err);
  }

  /** Has the route been fulfilled/continued/aborted/fallbacked? */
  isSettled(): boolean {
    return this.settled;
  }

  private async doFetch(options: ContinueOptions): Promise<Response> {
    const url = options.url ?? this._request.url();
    const method = options.method ?? this.mreq.method;

    const headers = new Headers();
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) headers.set(k, v);
    } else {
      for (let i = 0; i < this.mreq.rawHeaders.length; i++) {
        const [k, v] = this.mreq.rawHeaders[i];
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
    } else if (methodHasBody(method)) {
      const buf = this.mreq.body.buffer;
      if (buf && buf.length > 0) {
        body = toUint8(buf) as unknown as BodyInit;
      }
    }

    return this.fetcher(url, {
      method,
      headers,
      body,
      redirect: "manual",
    });
  }

  private assertUnsettled(): void {
    if (this.settled) {
      throw new Error("Route already handled");
    }
  }
}
