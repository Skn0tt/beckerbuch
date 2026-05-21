// Routing chain: registration list + per-exchange cache + walker.
//
// The walker is the heart of the chain semantics: latest-first
// iteration, per-handler Route, fallback delegation, `{ times }`
// auto-removal, and chain-exhaustion-as-passthrough (via an internal
// `route.continue()`).

import type { CompletedRequest } from "mockttp";

import { matchPattern, type RoutePattern } from "./matcher";
import type { ProxyRequest } from "./request";
import type { ProxyResponse } from "./response";
import { buildProxyRequest } from "./request";
import {
  Route,
  type MockttpCallbackResult,
  type RouteFetcher,
  type RouteHandler,
} from "./route";

export interface Registration {
  pattern: RoutePattern;
  handler: RouteHandler;
  /** Remaining invocations when `{ times }` was supplied. */
  remaining?: number;
}

export interface CacheEntry {
  proxyReq: ProxyRequest;
  resolveResponse: (res: ProxyResponse | null) => void;
  /** Has the bridge already emitted the `request` event for this id? */
  emittedRequest: boolean;
  /** Has the bridge already emitted a `requestfinished` / `requestfailed`? */
  finalized: boolean;
}

/**
 * Build a cache-entry factory backed by `cache`. Idempotent: bridge and
 * walker can race-create the entry for the same `req.id` and both end
 * up with the same instance.
 */
export function makeEnsureCacheEntry(
  cache: Map<string, CacheEntry>,
): (req: CompletedRequest) => CacheEntry {
  return (req) => {
    const existing = cache.get(req.id);
    if (existing) return existing;
    let resolveResponse!: (res: ProxyResponse | null) => void;
    const responsePromise = new Promise<ProxyResponse | null>((r) => {
      resolveResponse = r;
    });
    responsePromise.catch(() => {});
    const proxyReq = buildProxyRequest(req, responsePromise);
    const entry: CacheEntry = {
      proxyReq,
      resolveResponse,
      emittedRequest: false,
      finalized: false,
    };
    cache.set(req.id, entry);
    return entry;
  };
}

export async function walkChain(
  req: CompletedRequest,
  registrations: Registration[],
  ensureCacheEntry: (req: CompletedRequest) => CacheEntry,
  fetcher: RouteFetcher,
): Promise<MockttpCallbackResult> {
  const entry = ensureCacheEntry(req);
  const proxyReq = entry.proxyReq;

  // Snapshot the matching set in LIFO order. Snapshot-not-live so a
  // handler that registers another route mid-chain (rare but possible)
  // doesn't reshuffle the walk under our feet.
  const matches: Registration[] = [];
  for (let i = registrations.length - 1; i >= 0; i--) {
    if (matchPattern(registrations[i].pattern, req.url)) {
      matches.push(registrations[i]);
    }
  }

  for (const reg of matches) {
    // Each handler gets a fresh Route — settling one mustn't bleed
    // into the next iteration.
    const route = new Route(proxyReq, req, fetcher);

    // Fire-and-forget — handler may stash the route and settle it later.
    Promise.resolve(reg.handler(route)).catch((err) => {
      route._failFromHandler(err);
    });

    const outcome = await route._settled;

    // `times` counts every invocation (matching Playwright). The
    // handler is removed as soon as the count hits zero, even if it
    // chose to fallback this round.
    if (reg.remaining !== undefined) {
      reg.remaining--;
      if (reg.remaining <= 0) {
        const idx = registrations.indexOf(reg);
        if (idx >= 0) registrations.splice(idx, 1);
      }
    }

    if (outcome.kind === "response") return outcome.result;
    // outcome.kind === "fallback" → try the next matching handler.
  }

  // Chain exhausted (or every handler fell back). Forward the request
  // to the real upstream. We do this via `route.continue()` so we
  // share the same body/header sanitisation as user-driven continues.
  const route = new Route(proxyReq, req, fetcher);
  await route.continue();
  const final = await route._settled;
  if (final.kind !== "response") {
    throw new Error(
      "internal: walker continue() did not produce a response outcome",
    );
  }
  return final.result;
}
