/**
 * Stale-while-revalidate for React Router loaders.
 *
 * - The route exports `clientLoader = createSwrClientLoader<LoaderData>()`
 *   alongside its normal server `loader`.
 * - The component reads data via `useSwrData<LoaderData>()` instead of
 *   destructuring loaderData directly.
 *
 * On a client-side navigation back to a route the user has visited
 * before in this browser:
 *   1. clientLoader checks the cache (in-memory Map, falls back to
 *      localStorage). On hit it kicks off serverLoader() in the
 *      background and returns the cached payload immediately.
 *   2. The component paints the cached data (instant).
 *   3. When the background fetch resolves, useSwrData swaps state to
 *      the fresh payload and the component re-renders.
 *
 * Initial SSR is unaffected (clientLoader.hydrate is not set). The
 * cache is populated on the first client nav into a route; subsequent
 * navs are instant.
 *
 * NOT for routes with actions / fetchers — mutations would briefly
 * flash stale post-action data. Apply only to GET-only views.
 */

import { useEffect, useRef, useState } from "react";
import {
  useFetchers,
  useLoaderData,
  useNavigation,
  type ClientLoaderFunctionArgs,
} from "react-router";

const STORAGE_PREFIX = "swr:";
// Bumped automatically on every Netlify deploy (see vite.config.ts).
// Old entries with a different version are ignored on read.
declare const __SWR_VERSION__: string;
const VERSION = __SWR_VERSION__;
// One year — effectively "no TTL". Cache is invalidated by
// (a) bumping VERSION on every deploy and (b) clearAllSwr() on
// logout / mutation. The TTL is just a final backstop against truly
// ancient entries.
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

type Envelope<T> = { v: string; at: number; data: T };

// In-memory hot cache. Avoids re-parsing JSON from localStorage on
// every nav, and works in SSR / tests where localStorage isn't
// available.
const hot = new Map<string, unknown>();

function storageKey(key: string): string {
  return STORAGE_PREFIX + key;
}

function load<T>(key: string): T | undefined {
  if (hot.has(key)) return hot.get(key) as T;
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return undefined;
    const env = JSON.parse(raw) as Envelope<T>;
    if (env.v !== VERSION) return undefined;
    if (Date.now() - env.at > TTL_MS) return undefined;
    hot.set(key, env.data);
    return env.data;
  } catch {
    return undefined;
  }
}

function save<T>(key: string, data: T): void {
  hot.set(key, data);
  if (typeof localStorage === "undefined") return;
  try {
    const env: Envelope<T> = { v: VERSION, at: Date.now(), data };
    localStorage.setItem(storageKey(key), JSON.stringify(env));
  } catch {
    // Quota exceeded or non-serialisable payload — hot cache still works.
  }
}

/**
 * Wipe every SWR entry. Call from `clientAction` on logout so the
 * next user signing in on the same browser doesn't see leftover data.
 */
export function clearAllSwr(): void {
  hot.clear();
  if (typeof localStorage === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

type SwrPayload<T> = { data: T; refresh: Promise<T> | null };

function cacheKey(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

function isSwrPayload<T>(value: unknown): value is SwrPayload<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    "refresh" in value
  );
}

/**
 * Unwrap loaderData that may be either the raw server-loader payload
 * (during initial SSR hydration, when clientLoader hasn't run) or
 * the SWR envelope (after a client-side navigation).
 *
 * Use in `meta()` and anywhere outside `useSwrData` that reads loaderData.
 */
export function unwrapSwr<T>(value: T | SwrPayload<T>): T {
  return isSwrPayload<T>(value) ? value.data : value;
}

export function createSwrClientLoader<T>() {
  return async ({
    serverLoader,
    request,
  }: ClientLoaderFunctionArgs): Promise<SwrPayload<T>> => {
    const key = cacheKey(request);
    const refresh = (serverLoader() as Promise<T>).then((fresh) => {
      save(key, fresh);
      return fresh;
    });
    const cached = load<T>(key);
    if (cached !== undefined) {
      // Don't let an unhandled rejection from the background refresh
      // log noise during normal nav — the cached render is what the
      // user sees, and the next refresh attempt will surface a real
      // problem.
      refresh.catch(() => {});
      return { data: cached, refresh };
    }
    return { data: await refresh, refresh: null };
  };
}

/**
 * Component-side companion to `createSwrClientLoader`. Returns the
 * cached payload on first paint, then swaps to the fresh payload
 * when the background revalidation resolves.
 */
export function useSwrData<T>(): T {
  const raw = useLoaderData() as T | SwrPayload<T>;
  // On initial SSR hydration clientLoader hasn't run yet, so we get
  // the raw server payload. On subsequent client navigations we get
  // the SWR envelope.
  const wrapped: SwrPayload<T> = isSwrPayload<T>(raw)
    ? raw
    : { data: raw, refresh: null };
  const { data, refresh } = wrapped;
  // Derived state: when RR navigates to a different cache key, `data`
  // flips to the new cached entry — reset `current` during render
  // (the idiomatic React 19 pattern, avoids an effect-driven cascade).
  const [state, setState] = useState({ data, current: data });
  if (data !== state.data) {
    setState({ data, current: data });
  }
  useEffect(() => {
    if (!refresh) return;
    let cancelled = false;
    refresh.then((fresh) => {
      if (cancelled) return;
      setState((s) => ({ data: s.data, current: fresh }));
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);
  return state.current;
}

/**
 * Wipes the SWR cache the moment any submission starts (either a
 * navigation-form submit or a fetcher submit). The post-action
 * revalidation then runs against an empty cache → user sees fresh
 * data, never the pre-mutation snapshot.
 *
 * Mount once in the root component so every SWR'd route is covered
 * regardless of where the mutation lives.
 */
export function useSwrInvalidateOnMutation(): void {
  const nav = useNavigation();
  const fetchers = useFetchers();
  const isMutating =
    nav.state === "submitting" ||
    fetchers.some((f) => f.state === "submitting");
  const wasMutating = useRef(false);
  useEffect(() => {
    if (isMutating && !wasMutating.current) {
      clearAllSwr();
    }
    wasMutating.current = isMutating;
  }, [isMutating]);
}
