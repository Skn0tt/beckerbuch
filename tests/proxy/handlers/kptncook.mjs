// kptncook handlers for the mockttp proxy.
//
// Mirrors the real upstream's two relevant surfaces:
//   - https://share.kptncook.com/<token>   → 302 to the canonical recipe URL
//   - https://mobile.kptncook.com/recipes/search?kptnkey=...
//                                          → batch resolve-ids endpoint
//   - https://mobile.kptncook.com/images/* → served as a tiny JPEG
//
// All routes match the real production hosts; the app code talks to
// them as if they were the real upstream, with the proxy MITMing.

import {
  ALL_KPTNCOOK_RECIPES,
  KPTNCOOK_TEST_API_KEY,
  TINY_JPEG,
} from "../fixtures.mjs";

const SHARE_BASE = "https://share.kptncook.com";
const MOBILE_BASE = "https://mobile.kptncook.com";

function findByOid(oid) {
  return ALL_KPTNCOOK_RECIPES.find((r) => r.oid === oid);
}
function findByUid(uid) {
  return ALL_KPTNCOOK_RECIPES.find((r) => r.uid === uid);
}
function findByShareToken(token) {
  return ALL_KPTNCOOK_RECIPES.find((r) => r.shareToken === token);
}

export async function registerKptncookHandlers(server) {
  // GET https://share.kptncook.com/<token> → 302 to canonical URL.
  await server
    .forGet(/^https:\/\/share\.kptncook\.com\/[^/]+$/)
    .thenCallback((req) => {
      const url = new URL(req.url);
      const token = url.pathname.slice(1);
      const recipe = findByShareToken(token);
      if (!recipe) return { statusCode: 404 };
      return {
        statusCode: 302,
        headers: {
          location: `${SHARE_BASE}/de/${recipe.uid}/cooking`,
        },
      };
    });

  // POST https://mobile.kptncook.com/recipes/search?kptnkey=...
  await server
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
      let body;
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
      const out = [];
      for (const entry of body) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.identifier === "string") {
          const r = findByOid(entry.identifier);
          if (r) out.push(r.payload);
        } else if (typeof entry.uid === "string") {
          const r = findByUid(entry.uid);
          if (r) out.push(r.payload);
        }
      }
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(out),
      };
    });

  // GET https://mobile.kptncook.com/images/<anything> → tiny JPEG.
  await server
    .forGet(/^https:\/\/mobile\.kptncook\.com\/images\/.+/)
    .thenReply(
      200,
      TINY_JPEG,
      {
        "content-type": "image/jpeg",
        "content-length": String(TINY_JPEG.length),
      },
    );
}
