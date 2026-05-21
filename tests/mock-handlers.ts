// Shared route-handler factories for HTTP mocks. Each function returns
// a Playwright-shaped route handler (closure) that specs hand to
// `mocks.route(...)` inline. Helpers don't *register* anything — that
// stays in the spec, next to the assertions.

import type { RouteHandler } from "./playwright-mocks/src";
import {
  KPTNCOOK_TEST_API_KEY,
  TINY_JPEG,
  type MockKptncookRecipe,
} from "./mock-data";

const SHARE_BASE = "https://share.kptncook.com";

// --------------------------------------------------------------------
// kptncook

/**
 * Handler for the kptncook share-link redirect:
 *   GET https://share.kptncook.com/<shareToken> → 302 to canonical URL.
 *
 * Tokens not in the supplied list return 404 from the handler.
 */
export function kptncookShareRedirectHandler(
  recipes: MockKptncookRecipe[],
): RouteHandler {
  const byToken = new Map(recipes.map((r) => [r.shareToken, r]));
  return async (route) => {
    const url = new URL(route.url());
    const token = url.pathname.slice(1);
    const recipe = byToken.get(token);
    if (!recipe) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 302,
      headers: { location: `${SHARE_BASE}/de/${recipe.uid}/cooking` },
    });
  };
}

/**
 * Handler for the kptncook batch-resolve endpoint:
 *   POST https://mobile.kptncook.com/recipes/search?kptnkey=...
 *
 * Requires `kptnkey` to match `KPTNCOOK_TEST_API_KEY` (the value the
 * worker fixture sets on the vite dev env).
 */
export function kptncookSearchHandler(recipes: MockKptncookRecipe[]): RouteHandler {
  const byOid = new Map(recipes.map((r) => [r.oid, r]));
  const byUid = new Map(recipes.map((r) => [r.uid, r]));
  return async (route) => {
    const url = new URL(route.url());
    if (url.searchParams.get("kptnkey") !== KPTNCOOK_TEST_API_KEY) {
      await route.fulfill({ status: 401, json: { error: "bad kptnkey" } });
      return;
    }
    let body: unknown;
    try {
      body = route.request().postDataJSON();
    } catch {
      body = null;
    }
    if (!Array.isArray(body)) {
      await route.fulfill({ status: 400, json: { error: "expected array body" } });
      return;
    }
    const out: Array<Record<string, unknown>> = [];
    for (const entry of body) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { identifier?: unknown; uid?: unknown };
      if (typeof e.identifier === "string") {
        const r = byOid.get(e.identifier);
        if (r) out.push(r.payload);
      } else if (typeof e.uid === "string") {
        const r = byUid.get(e.uid);
        if (r) out.push(r.payload);
      }
    }
    await route.fulfill({ status: 200, json: out });
  };
}

/** Returns a 1×1 JPEG for any path under mobile.kptncook.com/images/. */
export function kptncookImagesHandler(): RouteHandler {
  return async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: TINY_JPEG,
    });
  };
}

// --------------------------------------------------------------------
// OpenAI dedup

export type OpenAiDedupOptions =
  | { fail: true }
  | {
      fail?: false;
      /**
       * Explicit merges to return. Each entry is the list of input
       * item ids that should be merged. If omitted, falls back to the
       * deterministic "group by lowercased item with trailing s
       * stripped" algorithm — handy as a sensible default for specs
       * that don't care about the exact grouping.
       */
      merges?: Array<{ ids: string[] }>;
    };

interface DedupItem {
  id?: unknown;
  item?: unknown;
}

function deriveMerges(items: DedupItem[]): Array<{ ids: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const it of items) {
    const item = typeof it?.item === "string" ? it.item : "";
    const id = typeof it?.id === "string" ? it.id : null;
    if (!id) continue;
    const key = item.toLowerCase().trim().replace(/s$/, "");
    const list = buckets.get(key) ?? [];
    list.push(id);
    buckets.set(key, list);
  }
  const merges: Array<{ ids: string[] }> = [];
  for (const list of buckets.values()) {
    if (list.length >= 2) merges.push({ ids: list });
  }
  return merges;
}

/**
 * Handler for the OpenAI chat-completions endpoint, dedup-shaped
 * response. Matches whatever URL the SDK ends up using (default
 * api.openai.com or Netlify AI Gateway).
 *
 * With `{ fail: true }`, returns HTTP 500 — use to exercise the
 * app's LLM-failure fallback. Otherwise returns a structured
 * dedup response derived from the request body (or the explicit
 * `merges` if supplied).
 */
export function openAiDedupHandler(options: OpenAiDedupOptions = {}): RouteHandler {
  return async (route) => {
    if (options.fail) {
      await route.fulfill({
        status: 500,
        json: { error: { message: "forced test failure" } },
      });
      return;
    }

    type DedupRequestBody = { messages?: unknown; model?: unknown };
    let body: DedupRequestBody | null = null;
    try {
      const json = route.request().postDataJSON() as unknown;
      if (json && typeof json === "object") body = json as DedupRequestBody;
    } catch {
      body = null;
    }

    let merges = options.merges;
    if (!merges) {
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const userMsg = (messages as Array<{ role?: unknown; content?: unknown }>).find(
        (m) => m?.role === "user",
      );
      let items: DedupItem[] = [];
      if (userMsg && typeof userMsg.content === "string") {
        try {
          const parsed = JSON.parse(userMsg.content) as { items?: unknown };
          if (Array.isArray(parsed?.items)) items = parsed.items as DedupItem[];
        } catch {
          // ignore
        }
      }
      merges = deriveMerges(items);
    }

    const content = JSON.stringify({ merges });
    await route.fulfill({
      status: 200,
      json: {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: typeof body?.model === "string" ? body.model : "gpt-5-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    });
  };
}
