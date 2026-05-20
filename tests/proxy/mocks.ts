// Test-callable mock helpers for the per-worker mockttp proxy.
//
// Each helper registers a small set of rules on the supplied `proxy`
// (a mockttp server). Specs call them in `test` or `test.beforeEach`,
// so the mocks live next to the assertions that depend on them.
//
// The per-test `proxy` fixture resets the mockttp between tests, so
// helpers may assume they start from a clean slate (plus the default
// unmatched-passthrough rule the fixture re-installs).

import type { Mockttp } from "mockttp";
import {
  KPTNCOOK_TEST_API_KEY,
  TINY_JPEG,
  type MockKptncookRecipe,
} from "./fixtures";

const SHARE_BASE = "https://share.kptncook.com";
const MOBILE_BASE = "https://mobile.kptncook.com";

/**
 * Mock the kptncook share-link redirect:
 *   GET https://share.kptncook.com/<shareToken> → 302 to canonical URL.
 *
 * Pass a list of recipes; tokens not in the list fall through to the
 * default policy (passthrough — which in tests means the real host,
 * so the spec will visibly fail). Call once per test with all the
 * recipes that test cares about.
 */
export async function mockKptncookShareRedirects(
  proxy: Mockttp,
  recipes: MockKptncookRecipe[],
) {
  const byToken = new Map(recipes.map((r) => [r.shareToken, r]));
  await proxy
    .forGet(/^https:\/\/share\.kptncook\.com\/[^/]+$/)
    .thenCallback((req) => {
      const url = new URL(req.url);
      const token = url.pathname.slice(1);
      const recipe = byToken.get(token);
      if (!recipe) return { statusCode: 404 };
      return {
        statusCode: 302,
        headers: { location: `${SHARE_BASE}/de/${recipe.uid}/cooking` },
      };
    });
}

/**
 * Mock the kptncook batch-resolve endpoint:
 *   POST https://mobile.kptncook.com/recipes/search?kptnkey=...
 *
 * Requires `kptnkey` to match `KPTNCOOK_TEST_API_KEY` (the value the
 * worker fixture sets on the netlify-dev env).
 */
export async function mockKptncookSearch(
  proxy: Mockttp,
  recipes: MockKptncookRecipe[],
) {
  const byOid = new Map(recipes.map((r) => [r.oid, r]));
  const byUid = new Map(recipes.map((r) => [r.uid, r]));
  await proxy
    .forPost(`${MOBILE_BASE}/recipes/search`)
    .thenCallback(async (req) => {
      const url = new URL(req.url);
      if (url.searchParams.get("kptnkey") !== KPTNCOOK_TEST_API_KEY) {
        return {
          statusCode: 401,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "bad kptnkey" }),
        };
      }
      const text = await req.body.getText();
      let body: unknown;
      try {
        body = JSON.parse(text ?? "");
      } catch {
        body = null;
      }
      if (!Array.isArray(body)) {
        return {
          statusCode: 400,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "expected array body" }),
        };
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
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(out),
      };
    });
}

/**
 * Mock kptncook image hosting:
 *   GET https://mobile.kptncook.com/images/* → tiny 1×1 JPEG.
 *
 * Use when the spec exercises photo fetching. Returns the same tiny
 * JPEG regardless of path.
 */
export async function mockKptncookImages(proxy: Mockttp) {
  await proxy
    .forGet(/^https:\/\/mobile\.kptncook\.com\/images\/.+/)
    .thenReply(200, TINY_JPEG, {
      "content-type": "image/jpeg",
      "content-length": String(TINY_JPEG.length),
    });
}

/**
 * One-call convenience for the common "kptncook upstream is fully
 * mocked" case: share redirect + search + images, for the given
 * recipes.
 */
export async function mockKptncook(
  proxy: Mockttp,
  recipes: MockKptncookRecipe[],
) {
  await mockKptncookShareRedirects(proxy, recipes);
  await mockKptncookSearch(proxy, recipes);
  await mockKptncookImages(proxy);
}

// ---------------------------------------------------------------------
// OpenAI

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
 * Mock the OpenAI chat-completions endpoint for the dedup feature.
 *
 * Matches on path so it works for either base URL the SDK might pick:
 *   - `https://api.openai.com/v1/chat/completions` (default)
 *   - `<site>/.netlify/ai/chat/completions` (Netlify AI Gateway,
 *     injected automatically when the project is linked to a site)
 *
 * With `{ fail: true }`, returns HTTP 500 — use to exercise the
 * app's LLM-failure fallback. Otherwise returns a structured
 * dedup response.
 */
export async function mockOpenAiDedup(
  proxy: Mockttp,
  options: OpenAiDedupOptions = {},
) {
  await proxy
    .forPost(/\/(?:v1|\.netlify\/ai)\/chat\/completions(?:\?.*)?$/)
    .thenCallback(async (req) => {
      if (options.fail) {
        return {
          statusCode: 500,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { message: "forced test failure" } }),
        };
      }

      type DedupRequestBody = { messages?: unknown; model?: unknown };
      let body: DedupRequestBody | null = null;
      try {
        const json = (await req.body.getJson()) as unknown;
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
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
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
        }),
      };
    });
}
