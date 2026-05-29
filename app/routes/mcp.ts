import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Route } from "./+types/mcp";
import { tryGetMcpContext } from "../auth/mcp-token";
import {
  createRecipe,
  editRecipe,
  fetchPhotoFromUrl,
  getRecipeForFlat,
  searchRecipes,
  type FlatRecipe,
  type RecipeListItem,
} from "../lib/recipes";
import { importKptncookRecipe } from "../lib/kptncook";

const UUID_SCHEMA = z.guid("Recipe id must be a UUID.");

const ingredientSchema = z.object({
  amount: z.string().optional(),
  unit: z.string().optional(),
  item: z.string().trim().min(1).max(200),
});

const addRecipeInput = {
  name: z.string().trim().min(1).max(200).describe("Recipe name"),
  baseQuantity: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .describe("How many portions the listed amounts make"),
  ingredients: z
    .array(ingredientSchema)
    .min(1)
    .describe("Ingredient lines, in order"),
  steps: z.string().default("").describe("Free-text cooking steps"),
  sourceUrl: z.string().url().optional().describe("Where the recipe came from"),
  photoUrl: z
    .string()
    .url()
    .optional()
    .describe("Public image URL; server will fetch and store it"),
};

const recipeIdSchema = UUID_SCHEMA.describe("Recipe id");

const searchRecipesInput = {
  query: z
    .string()
    .default("")
    .describe("Free-text search. Leave empty to list recent recipes."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum number of results to return (1-50)."),
};

const getRecipeInput = {
  id: recipeIdSchema,
};

const editRecipeInput = {
  id: recipeIdSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Replace the recipe name"),
  baseQuantity: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Replace the base quantity"),
  ingredients: z
    .array(ingredientSchema)
    .min(1)
    .optional()
    .describe("Replace the full ingredient list"),
  steps: z
    .string()
    .optional()
    .describe("Replace the steps text; use an empty string to clear it"),
  sourceUrl: z
    .string()
    .url()
    .nullable()
    .optional()
    .describe("Replace the source URL; pass null to clear it"),
  photoUrl: z
    .string()
    .url()
    .optional()
    .describe("Fetch and replace the recipe photo from this public image URL"),
  removePhoto: z
    .boolean()
    .default(false)
    .optional()
    .describe("Remove the current recipe photo"),
};

async function handle(request: Request): Promise<Response> {
  const ctx = await tryGetMcpContext(request);
  if (!ctx) {
    logMcp("unauthorized", { method: request.method, url: redactUrl(request.url) });
    return unauthorized();
  }

  const normalized = await normalizeToolCallArgs(request);
  const reqBody = await readBodySafely(normalized);
  logMcp("request", {
    method: normalized.method,
    url: redactUrl(normalized.url),
    user: ctx.user.email,
    body: reqBody.preview,
  });

  const server = new McpServer(
    { name: "kochbuch", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "kochbuch_add_recipe",
    {
      title: "Add a recipe",
      description:
        "Add a new recipe to the authenticated user's flat. Returns the recipe id and a URL to view it.",
      inputSchema: addRecipeInput,
    },
    async (args) => {
      let sourceHost: string | null = null;
      if (args.sourceUrl) {
        try {
          sourceHost = new URL(args.sourceUrl).host;
        } catch {
          return toolError("sourceUrl is not a valid URL.");
        }
      }

      let photo: { bytes: Uint8Array; contentType: string } | undefined;
      if (args.photoUrl) {
        const fetched = await fetchPhotoFromUrl(args.photoUrl);
        if (!fetched.ok) return toolError(fetched.error);
        photo = { bytes: fetched.bytes, contentType: fetched.contentType };
      }

      const { id } = await createRecipe({
        flatId: ctx.flat.id,
        name: args.name,
        baseQuantity: args.baseQuantity,
        sourceUrl: args.sourceUrl ?? null,
        sourceHost,
        steps: args.steps ?? "",
        ingredients: normalizeIngredients(args.ingredients),
        photo,
      });

      return jsonResult(recipeRefPayload(id, request));
    },
  );

  server.registerTool(
    "kochbuch_search_recipes",
    {
      title: "Search recipes",
      description:
        "Search the authenticated user's recipes by name, ingredients, or source host.",
      inputSchema: searchRecipesInput,
    },
    async (args) => {
      const recipes = await searchRecipes({
        flatId: ctx.flat.id,
        query: args.query ?? "",
        limit: args.limit ?? 20,
      });
      return jsonResult({
        query: args.query ?? "",
        results: recipes.map((recipe) => recipeListPayload(recipe, request)),
      });
    },
  );

  server.registerTool(
    "kochbuch_get_recipe",
    {
      title: "Get a recipe",
      description: "Fetch one recipe from the authenticated user's flat.",
      inputSchema: getRecipeInput,
    },
    async (args) => {
      if (!UUID_SCHEMA.safeParse(args.id).success) return toolError("Recipe id must be a UUID.");
      const recipe = await getRecipeForFlat({ flatId: ctx.flat.id, id: args.id });
      if (!recipe) return toolError("Recipe not found.");
      return jsonResult(recipePayload(recipe, request));
    },
  );

  server.registerTool(
    "kochbuch_edit_recipe",
    {
      title: "Edit a recipe",
      description:
        "Patch fields on an existing recipe in the authenticated user's flat. Returns the recipe id and a URL to view it.",
      inputSchema: editRecipeInput,
    },
    async (args) => {
      if (!UUID_SCHEMA.safeParse(args.id).success) return toolError("Recipe id must be a UUID.");
      if (args.photoUrl && args.removePhoto) {
        return toolError("photoUrl and removePhoto cannot be used together.");
      }

      let photo: { bytes: Uint8Array; contentType: string } | undefined;
      if (args.photoUrl) {
        const fetched = await fetchPhotoFromUrl(args.photoUrl);
        if (!fetched.ok) return toolError(fetched.error);
        photo = { bytes: fetched.bytes, contentType: fetched.contentType };
      }

      const recipe = await editRecipe({
        flatId: ctx.flat.id,
        id: args.id,
        patch: {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.baseQuantity !== undefined ? { baseQuantity: args.baseQuantity } : {}),
          ...(args.steps !== undefined ? { steps: args.steps } : {}),
          ...(args.sourceUrl !== undefined ? { sourceUrl: args.sourceUrl } : {}),
          ...(args.ingredients ? { ingredients: normalizeIngredients(args.ingredients) } : {}),
          ...(photo ? { photo } : {}),
          ...(args.removePhoto ? { removePhoto: true } : {}),
        },
      });
      if (!recipe) return toolError("Recipe not found.");
      return jsonResult(recipeRefPayload(recipe.id, request));
    },
  );

  server.registerTool(
    "kptncook_fetch_recipe",
    {
      title: "Fetch a kptncook recipe",
      description:
        "Resolve a kptncook share URL, uid (7-8 chars), or oid (24 hex chars) into a normalized recipe payload that can be passed to kochbuch_add_recipe. Does not store anything — the agent should review and call kochbuch_add_recipe to actually save it. Requires KPTNCOOK_API_KEY to be configured server-side.",
      inputSchema: {
        input: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Share URL (e.g. https://share.kptncook.com/abc123), uid, or oid",
          ),
        includePhoto: z
          .boolean()
          .default(true)
          .describe("Fetch the cover image bytes (base64 in result)"),
      },
    },
    async (args) => {
      const result = await importKptncookRecipe(args.input, {
        includePhoto: args.includePhoto !== false,
      });
      if (!result.ok) return toolError(result.error);
      const r = result.recipe;
      return jsonResult({
        name: r.name,
        baseQuantity: r.baseQuantity,
        sourceUrl: r.sourceUrl,
        steps: r.steps,
        ingredients: r.ingredients,
        photo: r.photo
          ? {
              contentType: r.photo.contentType,
              base64: Buffer.from(r.photo.bytes).toString("base64"),
            }
          : null,
        note:
          "Pass these fields to kochbuch_add_recipe. The photo is returned as base64 for reference; kochbuch_add_recipe currently only accepts photoUrl, so the photo cannot be carried through automatically yet.",
      });
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(normalized);
    const resBody = await readResponseBodyForLog(response);
    logMcp("response", {
      method: normalized.method,
      url: redactUrl(normalized.url),
      user: ctx.user.email,
      status: response.status,
      body: resBody.preview,
    });
    return response;
  } finally {
    await server.close().catch(() => {});
  }
}

const MAX_LOG_BODY = 4096;

function logMcp(kind: string, fields: Record<string, unknown>) {
  // Stays a single line so Netlify's log viewer doesn't split it. The
  // body is already truncated by readBodySafely / readResponseBodyForLog.
  console.log(`[mcp] ${kind} ${JSON.stringify(fields)}`);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("token")) u.searchParams.set("token", "<redacted>");
    return u.pathname + (u.search ? u.search : "");
  } catch {
    return url;
  }
}

async function readBodySafely(
  request: Request,
): Promise<{ preview: string }> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) {
    return { preview: "" };
  }
  try {
    const text = await request.clone().text();
    return { preview: truncate(text, MAX_LOG_BODY) };
  } catch (err) {
    return { preview: `<unreadable: ${(err as Error).message}>` };
  }
}

async function readResponseBodyForLog(
  response: Response,
): Promise<{ preview: string }> {
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  // SSE streams keep streaming forever — don't drain them.
  if (ct.includes("text/event-stream") || !response.body) {
    return { preview: `<${ct || "no-body"}>` };
  }
  try {
    const text = await response.clone().text();
    return { preview: truncate(text, MAX_LOG_BODY) };
  } catch (err) {
    return { preview: `<unreadable: ${(err as Error).message}>` };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…<+${text.length - max}B>`;
}

/**
 * Some MCP clients (observed in the wild) send `tools/call` without an
 * `arguments` field when the tool's inputSchema only contains optional /
 * defaulted fields. The SDK's zod validator rejects `undefined` against a
 * `z.object(...)` shape and the call fails with "Invalid arguments".
 * Default missing `arguments` to `{}` so defaults apply as intended.
 */
async function normalizeToolCallArgs(request: Request): Promise<Request> {
  if (request.method !== "POST") return request;
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) return request;
  const text = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Request(request, { body: text });
  }
  const messages = Array.isArray(body) ? body : [body];
  let changed = false;
  for (const message of messages) {
    if (
      message &&
      typeof message === "object" &&
      (message as { method?: unknown }).method === "tools/call"
    ) {
      const params = (message as { params?: Record<string, unknown> }).params;
      if (params && params.arguments === undefined) {
        params.arguments = {};
        changed = true;
      }
    }
  }
  const nextBody = changed ? JSON.stringify(body) : text;
  return new Request(request, { body: nextBody });
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function normalizeIngredients(
  ingredients: Array<{ amount?: string; unit?: string; item: string }>,
) {
  return ingredients.map((ingredient, position) => ({
    position,
    amount: ingredient.amount?.trim() ? ingredient.amount.trim() : null,
    unit: ingredient.unit?.trim() ? ingredient.unit.trim() : null,
    item: ingredient.item,
  }));
}

function recipeListPayload(recipe: RecipeListItem, request: Request) {
  const origin = new URL(request.url).origin;
  return {
    id: recipe.id,
    name: recipe.name,
    baseQuantity: recipe.baseQuantity,
    updatedAt: recipe.updatedAt.toISOString(),
    url: `${origin}/recipes/${recipe.id}`,
    publicUrl: `${origin}/r/${recipe.id}`,
  };
}

function recipeRefPayload(recipeId: string, request: Request) {
  const origin = new URL(request.url).origin;
  return {
    id: recipeId,
    url: `${origin}/recipes/${recipeId}`,
  };
}

function recipePayload(recipe: FlatRecipe, request: Request) {
  const origin = new URL(request.url).origin;
  return {
    id: recipe.id,
    name: recipe.name,
    baseQuantity: recipe.baseQuantity,
    steps: recipe.steps,
    sourceUrl: recipe.sourceUrl,
    sourceHost: recipe.sourceHost,
    photoUrl: recipe.photoBlobKey ? `${origin}/r/${recipe.id}/photo` : null,
    createdAt: recipe.createdAt.toISOString(),
    updatedAt: recipe.updatedAt.toISOString(),
    url: `${origin}/recipes/${recipe.id}`,
    publicUrl: `${origin}/r/${recipe.id}`,
    ingredients: recipe.ingredients.map((ingredient) => ({
      amount: ingredient.amount,
      unit: ingredient.unit,
      item: ingredient.item,
    })),
  };
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: "unauthorized",
      error_description:
        "MCP token required. Pass it as ?token=<uuid> or Authorization: Bearer <uuid>.",
    }),
    {
      status: 401,
      headers: { "content-type": "application/json" },
    },
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  return handle(request);
}

export async function action({ request }: Route.ActionArgs) {
  return handle(request);
}
