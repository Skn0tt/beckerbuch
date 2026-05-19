// OpenAI handler for the mockttp proxy.
//
// Matches POST .../chat/completions on either:
//   - api.openai.com/v1/chat/completions — the SDK's default when no
//     OPENAI_BASE_URL is set.
//   - <site>/.netlify/ai/chat/completions — Netlify's AI Gateway,
//     which the netlify CLI injects automatically when the project is
//     linked to a site (via OPENAI_BASE_URL + a gateway token). The
//     gateway speaks the OpenAI chat-completions wire format.
//
// We match by path (regex) so the handler is independent of which
// base URL the SDK ends up using at runtime.
//
// The dedup feature is the only OpenAI caller we have. We reproduce
// the structured-response shape the real model would return when given
// the dedup `response_format` schema: a JSON string in
// `choices[0].message.content` with `{"merges": [{ids: [...]}]}`.
//
// Grouping strategy mirrors the previous `fakeBackend()` in
// app/lib/dedup.ts — group input items by (lowercased item name with
// trailing "s" stripped), emit merges for any group of ≥2 ids. That
// keeps the existing handoff-dedup specs unchanged.
//
// Failure path: any request whose payload contains the magic ingredient
// name "__force_dedup_failure__" returns HTTP 500. This replaces the
// old `DEDUP_FAKE_FAIL=1` env knob: specs opt in by naming an
// ingredient with that string, instead of toggling process env.

export const DEDUP_FAILURE_TRIGGER = "__force_dedup_failure__";

function deriveMerges(items) {
  const buckets = new Map();
  for (const it of items) {
    const item = typeof it?.item === "string" ? it.item : "";
    const id = typeof it?.id === "string" ? it.id : null;
    if (!id) continue;
    const key = item.toLowerCase().trim().replace(/s$/, "");
    const list = buckets.get(key) ?? [];
    list.push(id);
    buckets.set(key, list);
  }
  const merges = [];
  for (const list of buckets.values()) {
    if (list.length >= 2) merges.push({ ids: list });
  }
  return merges;
}

export async function registerOpenAiHandlers(server) {
  // Match the OpenAI chat-completions endpoint by *path*, not host:
  //   - direct OpenAI:  https://api.openai.com/v1/chat/completions
  //   - Netlify AI Gateway: https://<site>/.netlify/ai/chat/completions
  // Both speak the OpenAI chat-completions wire format, so the same
  // handler response works for either.
  await server
    .forPost(/\/(?:v1|\.netlify\/ai)\/chat\/completions(?:\?.*)?$/)
    .thenCallback(async (req) => {
      let body;
      try {
        body = await req.body.getJson();
      } catch {
        body = null;
      }

      // The dedup user message is a JSON-encoded {items: [...]}. Find
      // it and parse it so we can emit a deterministic response.
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const userMsg = messages.find((m) => m?.role === "user");
      let items = [];
      if (userMsg && typeof userMsg.content === "string") {
        try {
          const parsed = JSON.parse(userMsg.content);
          if (Array.isArray(parsed?.items)) items = parsed.items;
        } catch {
          // ignore — emit an empty merges set below
        }
      }

      // Opt-in failure trigger for the "LLM backend failed → fall back
      // to all-singletons" spec.
      const triggered = items.some(
        (it) =>
          typeof it?.item === "string" &&
          it.item.includes(DEDUP_FAILURE_TRIGGER),
      );
      if (triggered) {
        return {
          statusCode: 500,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { message: "forced test failure" } }),
        };
      }

      const merges = deriveMerges(items);
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
