// Playwright-shape mock proxy facade backed by mockttp.
//
// `createProxy()` starts a mockttp HTTPS-MITM forward proxy and
// returns a `Proxy` handle whose API mirrors Playwright's
// `page.route` surface.
//
// Routing model: registrations are kept in a single ordered list and
// consulted at request time by the matching predicate of a single
// mockttp rule. The rule's callback walks all matching registrations
// LIFO (latest-first), giving each a fresh Route. A handler may call
// `route.fallback()` to delegate to the next matching handler;
// `{ times: N }` auto-removes the handler after N invocations.
// Unmatched requests fall through to mockttp's pass-through default.

import { EventEmitter } from "node:events";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import {
  generateCACertificate,
  getLocal,
  type AbortedRequest,
  type CompletedRequest,
  type CompletedResponse,
  type Mockttp,
} from "mockttp";

import {
  makeEnsureCacheEntry,
  walkChain,
  type CacheEntry,
  type Registration,
} from "./chain";
import {
  logBridgeError,
  safeEmit,
  waitFor,
  type ProxyEvent,
  type WaitMatcher,
  type WaitOptions,
} from "./events";
import { matchPattern, type RoutePattern } from "./matcher";
import { buildProxyResponse } from "./response";
import type { ProxyRequest } from "./request";
import type { ProxyResponse } from "./response";
import type { RouteFetcher, RouteHandler } from "./route";

export interface RouteOptions {
  /** Auto-remove this handler after N invocations. */
  times?: number;
}

export interface Proxy {
  url: string;
  caCertPath: string;
  /** PEM-encoded CA cert. Tests can sign upstream leaf certs with this. */
  caCertPem: string;
  /** Env block to merge into a child process for HTTPS_PROXY + CA trust. */
  env: NodeJS.ProcessEnv;
  /**
   * Register a route handler. Latest-registered handler runs first;
   * `route.fallback()` delegates to the next matching handler.
   */
  route(
    pattern: RoutePattern,
    handler: RouteHandler,
    options?: RouteOptions,
  ): Promise<void>;
  /**
   * Remove route handler(s). Without `handler`, removes every
   * registration for the given pattern (compared by reference).
   * With `handler`, removes the matching registration only.
   */
  unroute(pattern: RoutePattern, handler?: RouteHandler): Promise<void>;
  /** Drop all registered routes — typically called per-test on teardown. */
  unrouteAll(): Promise<void>;

  // Event API (Playwright-shape)
  on(event: "request", listener: (req: ProxyRequest) => void): this;
  on(event: "response", listener: (res: ProxyResponse) => void): this;
  on(event: "requestfinished", listener: (req: ProxyRequest) => void): this;
  on(event: "requestfailed", listener: (req: ProxyRequest) => void): this;
  once(event: "request", listener: (req: ProxyRequest) => void): this;
  once(event: "response", listener: (res: ProxyResponse) => void): this;
  once(event: "requestfinished", listener: (req: ProxyRequest) => void): this;
  once(event: "requestfailed", listener: (req: ProxyRequest) => void): this;
  off(event: "request", listener: (req: ProxyRequest) => void): this;
  off(event: "response", listener: (res: ProxyResponse) => void): this;
  off(event: "requestfinished", listener: (req: ProxyRequest) => void): this;
  off(event: "requestfailed", listener: (req: ProxyRequest) => void): this;
  removeAllListeners(event?: ProxyEvent): this;

  /**
   * Resolve with the first intercepted request whose URL matches
   * `urlOrPredicate`. Subscribes before returning so
   * `Promise.all([waitForRequest(...), trigger()])` is race-free.
   */
  waitForRequest(
    urlOrPredicate: WaitMatcher<ProxyRequest>,
    options?: WaitOptions,
  ): Promise<ProxyRequest>;

  /** Same as waitForRequest, but for responses. */
  waitForResponse(
    urlOrPredicate: WaitMatcher<ProxyResponse>,
    options?: WaitOptions,
  ): Promise<ProxyResponse>;

  close(): Promise<void>;
}

export interface CreateProxyOptions {
  /**
   * Extra CA PEM(s) the upstream-passthrough should trust. Real
   * upstreams use system-trusted certs; this is only useful for tests
   * that spin up their own HTTPS upstream with a synthetic cert.
   */
  trustedUpstreamCa?: string | string[];
}

export async function createProxy(
  options: CreateProxyOptions = {},
): Promise<Proxy> {
  const ca = await generateCACertificate();
  const dir = await mkdtemp(join(tmpdir(), "playwright-mocks-ca-"));
  const caCertPath = join(dir, "ca.pem");
  await writeFile(caCertPath, ca.cert);

  const extraCAs = options.trustedUpstreamCa
    ? (Array.isArray(options.trustedUpstreamCa)
        ? options.trustedUpstreamCa
        : [options.trustedUpstreamCa]
      ).map((cert) => ({ cert }))
    : undefined;

  const server: Mockttp = getLocal({
    https: { cert: ca.cert, key: ca.key },
  });
  await server.start();

  // Outbound dispatcher used by route.continue() / route.fetch() — and
  // by the walker when the chain falls through (passthrough). The test
  // process has no HTTPS_PROXY, so undici fetch goes direct; no
  // recursion through mockttp.
  const fetchAgent = options.trustedUpstreamCa
    ? new Agent({ connect: { ca: options.trustedUpstreamCa } })
    : new Agent();
  const fetcher: RouteFetcher = (url, init) =>
    undiciFetch(url, {
      ...init,
      dispatcher: fetchAgent,
      // undici typing differs slightly from DOM fetch for body shapes.
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

  // ----- routing state -------------------------------------------------
  const registrations: Registration[] = [];

  // ----- event bridge --------------------------------------------------
  const events = new EventEmitter();
  events.setMaxListeners(0);

  // Per-exchange cache keyed by mockttp `req.id`. The bridge and the
  // walker both consult this so `request.response()` resolves with the
  // matching response no matter which fired first.
  const requestCache = new Map<string, CacheEntry>();
  const ensureCacheEntry = makeEnsureCacheEntry(requestCache);

  // mockttp's `request` event fires after the request body is buffered.
  // The walker may have already created the cache entry by then (its
  // `thenCallback` and this event both spawn from `waitForCompletedRequest`
  // — order between them isn't guaranteed). Idempotent emission via
  // the `emittedRequest` flag handles either order.
  await server.on("request", (req: CompletedRequest) => {
    try {
      const entry = ensureCacheEntry(req);
      if (!entry.emittedRequest) {
        entry.emittedRequest = true;
        safeEmit(events, "request", entry.proxyReq);
      }
    } catch (err) {
      logBridgeError("request", err);
    }
  });

  await server.on("response", (res: CompletedResponse) => {
    try {
      const entry = requestCache.get(res.id);
      if (!entry) return;
      const proxyRes = buildProxyResponse(entry.proxyReq, res);
      entry.resolveResponse(proxyRes);
      safeEmit(events, "response", proxyRes);
      if (!entry.finalized) {
        entry.finalized = true;
        safeEmit(events, "requestfinished", entry.proxyReq);
      }
      requestCache.delete(res.id);
    } catch (err) {
      logBridgeError("response", err);
    }
  });

  await server.on("abort", (req: AbortedRequest) => {
    try {
      const entry = requestCache.get(req.id);
      if (!entry) return;
      entry.resolveResponse(null);
      if (!entry.finalized) {
        entry.finalized = true;
        safeEmit(events, "requestfailed", entry.proxyReq);
      }
      requestCache.delete(req.id);
    } catch (err) {
      logBridgeError("abort", err);
    }
  });

  // ----- mockttp rule wiring ------------------------------------------
  // One rule covers every request we have a registration for; the
  // matching predicate consults the live `registrations` array so adds
  // and removals take effect immediately without re-installing the rule.
  // Unmatched requests fall through to the `forUnmatchedRequest` default.
  await installPassthroughDefault(server, extraCAs);
  await server
    .forAnyRequest()
    .matching((req) =>
      registrations.some((r) => matchPattern(r.pattern, req.url)),
    )
    .thenCallback(async (req) =>
      walkChain(req, registrations, ensureCacheEntry, fetcher),
    );

  // ----- handle -------------------------------------------------------
  const proxyUrl = server.url;
  const handle: Proxy = {
    url: proxyUrl,
    caCertPath,
    caCertPem: ca.cert,
    env: {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      // mockttp itself sets NO_PROXY=localhost when proxyEnv is used,
      // but we're emitting a hand-rolled env block. Without this,
      // SSR-internal loopback fetches would go through us too.
      NO_PROXY: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caCertPath,
    },

    async route(pattern, handler, opts) {
      registrations.push({
        pattern,
        handler,
        remaining: opts?.times,
      });
    },

    async unroute(pattern, handler) {
      for (let i = registrations.length - 1; i >= 0; i--) {
        const r = registrations[i];
        if (r.pattern !== pattern) continue;
        if (handler && r.handler !== handler) continue;
        registrations.splice(i, 1);
      }
    },

    async unrouteAll() {
      registrations.length = 0;
    },

    on(event, listener) {
      events.on(event, listener as (...args: unknown[]) => void);
      return handle;
    },
    once(event, listener) {
      events.once(event, listener as (...args: unknown[]) => void);
      return handle;
    },
    off(event, listener) {
      events.off(event, listener as (...args: unknown[]) => void);
      return handle;
    },
    removeAllListeners(event) {
      if (event) events.removeAllListeners(event);
      else events.removeAllListeners();
      return handle;
    },

    waitForRequest(urlOrPredicate, opts) {
      return waitFor<ProxyRequest>(events, "request", urlOrPredicate, opts);
    },
    waitForResponse(urlOrPredicate, opts) {
      return waitFor<ProxyResponse>(
        events,
        "response",
        urlOrPredicate,
        opts,
        (res) => res.url(),
      );
    },

    async close() {
      await server.stop();
      await fetchAgent.close();
      await rm(dir, { recursive: true, force: true });
    },
  };

  return handle;
}

/**
 * Default policy: anything we didn't explicitly mock passes through to
 * the real upstream. Trade-off: a forgotten mock silently hits the
 * real internet instead of failing fast — keep the upstream allowlist
 * small.
 */
async function installPassthroughDefault(
  server: Mockttp,
  extraCACertificates: Array<{ cert: string }> | undefined,
) {
  await server.forUnmatchedRequest().thenPassThrough({
    additionalTrustedCAs: extraCACertificates,
    beforeRequest: (req) => {
      if (process.env.PROXY_LOG_UNMATCHED === "1") {
        console.log(`[proxy] passthrough ${req.method} ${req.url}`);
      }
    },
  });
}
