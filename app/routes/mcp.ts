import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Route } from "./+types/mcp";
import { tryGetMcpContext } from "../auth/oauth-token";
import {
  createRecipe,
  editRecipe,
  fetchPhotoFromUrl,
  getRecipeForFlat,
  photoFromBase64,
  searchRecipes,
  type FlatRecipe,
  type RecipeListItem,
} from "../lib/recipes";
import { importRecipe } from "../lib/recipe-import";
import { exportAnalysisTables } from "../lib/analysis-export";
import { getPlanForMcp } from "../lib/kitchen-data";
import {
  PLAN_NOTE_MAX,
  addToDraft,
  backToDraft,
  markCooked,
  removeFromDraft,
  reorderLane,
  setCook,
  setNote,
  setPortions,
} from "../lib/kitchen";

const UUID_SCHEMA = z.guid("Recipe id must be a UUID.");
const INSTANCE_UUID = z.guid("Instance id must be a UUID.");

const ingredientSchema = z.object({
  amount: z.string().optional(),
  unit: z.string().optional(),
  item: z.string().trim().min(1).max(200),
});

// The same object fetch_recipe returns. Null is accepted so a client can
// pass the field through when the source page had no cover. On add, null
// is not a photo: the call still needs bytes or photoUrl. On edit, null
// leaves the current cover alone.
const photoBytesSchema = z
  .object({
    contentType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("MIME type, for example image/jpeg"),
    base64: z
      .string()
      .min(1)
      .describe("Image bytes as standard base64, without a data-URL prefix"),
  })
  .describe(
    "Cover already downloaded. Pass the photo object from fetch_recipe through unchanged. Do not re-host or describe the image.",
  )
  .nullable()
  .optional();

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
    .describe(
      "Ingredient lines, in order. Do not list kitchen staples like salt, pepper, sugar, or oil here — assume the cook already has them. Mention their amounts inline in the steps instead.",
    ),
  steps: z
    .string()
    .default("")
    .describe(
      "Free-text cooking steps. Give the amounts of kitchen staples (salt, pepper, sugar, oil) inline here rather than listing them as ingredients.",
    ),
  sourceUrl: z.string().url().optional().describe("Where the recipe came from"),
  photo: photoBytesSchema.describe(
    "Required on add unless photoUrl is set. Pass the photo object from fetch_recipe through unchanged. Null is not a photo. Do not drop a cover you were given.",
  ),
  photoUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Public image URL for the server to fetch. On add, pass this or photo — a recipe is not saved without one. Use photo when the bytes are already in hand.",
    ),
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
    .describe(
      "Replace the full ingredient list. Do not list kitchen staples like salt, pepper, sugar, or oil here — assume the cook already has them. Mention their amounts inline in the steps instead.",
    ),
  steps: z
    .string()
    .optional()
    .describe(
      "Replace the steps text; use an empty string to clear it. Give the amounts of kitchen staples (salt, pepper, sugar, oil) inline here rather than listing them as ingredients.",
    ),
  sourceUrl: z
    .string()
    .url()
    .nullable()
    .optional()
    .describe("Replace the source URL; pass null to clear it"),
  photo: photoBytesSchema,
  photoUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Fetch and replace the recipe photo from this public image URL. Use photo instead when the bytes are already in hand.",
    ),
  removePhoto: z
    .boolean()
    .default(false)
    .optional()
    .describe("Remove the current recipe photo"),
};

const PLAN_SHAPE_DOC =
  "Returns JSON: { draft: PlanEntry[], stock: PlanEntry[], members: { id, displayName }[] }. " +
  "PlanEntry: { id (instance id), recipeId, recipeName, portions, position, cook: { id, displayName } | null, note }. " +
  "cook.displayName is null if that member left the flat. " +
  "Use members[].id as cookId for set_cook / add_to_draft. Use entry id as instanceId for mutations. " +
  "Promoting draft → in stock (finalise / shopping handoff) is UI-only and not available here.";

const updatePlanInput = {
  action: z
    .enum([
      "add_to_draft",
      "remove_from_draft",
      "set_portions",
      "set_cook",
      "set_note",
      "reorder",
      "back_to_draft",
      "mark_cooked",
    ])
    .describe(
      "Mutation to apply. Finalise (draft → in stock) is not available via MCP — use the Cookbook UI.",
    ),
  recipeId: UUID_SCHEMA.optional().describe("Required for add_to_draft"),
  instanceId: INSTANCE_UUID.optional().describe(
    "Required for remove_from_draft, set_portions, set_cook, set_note, back_to_draft, mark_cooked",
  ),
  portions: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Portions (1–1000). For add_to_draft / set_portions (draft only)",
    ),
  cookId: UUID_SCHEMA.nullable()
    .optional()
    .describe(
      `Flat member id from plan.members, or null to unassign. Required for set_cook (omit only on add_to_draft).`,
    ),
  note: z
    .string()
    .max(PLAN_NOTE_MAX)
    .nullable()
    .optional()
    .describe(
      `Free-text note (max ${PLAN_NOTE_MAX} chars). Required for set_note — pass null/empty to clear. Optional on add_to_draft.`,
    ),
  list: z
    .enum(["draft", "in_stock"])
    .optional()
    .describe("Lane for reorder: draft or in_stock"),
  instanceIds: z
    .array(INSTANCE_UUID)
    .optional()
    .describe("Full ordered list of instance ids in that lane (reorder)"),
};

type UpdatePlanArgs = {
  action:
    | "add_to_draft"
    | "remove_from_draft"
    | "set_portions"
    | "set_cook"
    | "set_note"
    | "reorder"
    | "back_to_draft"
    | "mark_cooked";
  recipeId?: string;
  instanceId?: string;
  portions?: number;
  cookId?: string | null;
  note?: string | null;
  list?: "draft" | "in_stock";
  instanceIds?: string[];
};

async function applyPlanUpdate(
  flatId: string,
  userId: string,
  args: UpdatePlanArgs,
): Promise<
  | { ok: true; action: string; instanceId?: string; created?: boolean }
  | { ok: false; error: string }
> {
  switch (args.action) {
    case "add_to_draft": {
      if (!args.recipeId || !UUID_SCHEMA.safeParse(args.recipeId).success) {
        return { ok: false, error: "recipeId is required and must be a UUID." };
      }
      const result = await addToDraft({
        flatId,
        recipeId: args.recipeId,
        portions: args.portions,
        note: args.note,
        cookId: args.cookId,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        action: args.action,
        instanceId: result.instanceId,
        created: result.created,
      };
    }
    case "remove_from_draft": {
      if (
        !args.instanceId ||
        !INSTANCE_UUID.safeParse(args.instanceId).success
      ) {
        return {
          ok: false,
          error: "instanceId is required and must be a UUID.",
        };
      }
      const result = await removeFromDraft({
        flatId,
        instanceId: args.instanceId,
      });
      if (!result.ok) return result;
      return { ok: true, action: args.action, instanceId: args.instanceId };
    }
    case "set_portions": {
      if (
        !args.instanceId ||
        !INSTANCE_UUID.safeParse(args.instanceId).success
      ) {
        return {
          ok: false,
          error: "instanceId is required and must be a UUID.",
        };
      }
      if (args.portions === undefined) {
        return { ok: false, error: "portions is required." };
      }
      const result = await setPortions({
        flatId,
        instanceId: args.instanceId,
        portions: args.portions,
      });
      if (!result.ok) return result;
      return { ok: true, action: args.action, instanceId: args.instanceId };
    }
    case "set_cook": {
      if (
        !args.instanceId ||
        !INSTANCE_UUID.safeParse(args.instanceId).success
      ) {
        return {
          ok: false,
          error: "instanceId is required and must be a UUID.",
        };
      }
      if (args.cookId === undefined) {
        return {
          ok: false,
          error: "cookId is required (pass null to unassign).",
        };
      }
      if (args.cookId !== null && !UUID_SCHEMA.safeParse(args.cookId).success) {
        return { ok: false, error: "cookId must be a UUID or null." };
      }
      const result = await setCook({
        flatId,
        instanceId: args.instanceId,
        cookId: args.cookId,
      });
      if (!result.ok) return result;
      return { ok: true, action: args.action, instanceId: args.instanceId };
    }
    case "set_note": {
      if (
        !args.instanceId ||
        !INSTANCE_UUID.safeParse(args.instanceId).success
      ) {
        return {
          ok: false,
          error: "instanceId is required and must be a UUID.",
        };
      }
      if (args.note === undefined) {
        return {
          ok: false,
          error: "note is required (pass null or empty to clear).",
        };
      }
      const result = await setNote({
        flatId,
        instanceId: args.instanceId,
        note: args.note,
      });
      if (!result.ok) return result;
      return { ok: true, action: args.action, instanceId: args.instanceId };
    }
    case "reorder": {
      if (args.list !== "draft" && args.list !== "in_stock") {
        return { ok: false, error: "list must be draft or in_stock." };
      }
      if (!args.instanceIds || args.instanceIds.length === 0) {
        return { ok: false, error: "instanceIds is required." };
      }
      if (new Set(args.instanceIds).size !== args.instanceIds.length) {
        return { ok: false, error: "instanceIds must be unique." };
      }
      for (const id of args.instanceIds) {
        if (!INSTANCE_UUID.safeParse(id).success) {
          return { ok: false, error: "instanceIds must be UUIDs." };
        }
      }
      const result = await reorderLane({
        flatId,
        lane: args.list === "in_stock" ? "stock" : "draft",
        instanceIds: args.instanceIds,
      });
      if (!result.ok) return result;
      return { ok: true, action: args.action };
    }
    case "back_to_draft": {
      if (
        !args.instanceId ||
        !INSTANCE_UUID.safeParse(args.instanceId).success
      ) {
        return {
          ok: false,
          error: "instanceId is required and must be a UUID.",
        };
      }
      const result = await backToDraft({
        flatId,
        instanceId: args.instanceId,
      });
      if (!result.ok) return result;
      return { ok: true, action: args.action, instanceId: args.instanceId };
    }
    case "mark_cooked": {
      if (
        !args.instanceId ||
        !INSTANCE_UUID.safeParse(args.instanceId).success
      ) {
        return {
          ok: false,
          error: "instanceId is required and must be a UUID.",
        };
      }
      const result = await markCooked({
        flatId,
        userId,
        instanceId: args.instanceId,
      });
      if (!result.ok) return result;
      return { ok: true, action: args.action, instanceId: args.instanceId };
    }
    default:
      return { ok: false, error: "Unknown action." };
  }
}

type RecipePhotoArgs = {
  photo?: { contentType: string; base64: string } | null;
  photoUrl?: string;
  removePhoto?: boolean;
};

/**
 * One cover source. `photo` is bytes the client already has (the object
 * from fetch_recipe). `photoUrl` is a public URL the server fetches.
 * `removePhoto` clears the current cover. Passing more than one is an error.
 */
async function resolveRecipePhoto(args: RecipePhotoArgs): Promise<
  | {
      ok: true;
      photo?: { bytes: Uint8Array; contentType: string };
      removePhoto: boolean;
    }
  | { ok: false; error: string }
> {
  const hasPhoto = args.photo != null;
  const hasUrl = typeof args.photoUrl === "string" && args.photoUrl.length > 0;
  const remove = args.removePhoto === true;
  const chosen = [
    hasPhoto ? "photo" : null,
    hasUrl ? "photoUrl" : null,
    remove ? "removePhoto" : null,
  ].filter((name): name is string => name !== null);

  if (chosen.length > 1) {
    if (
      chosen.length === 2 &&
      chosen[0] === "photoUrl" &&
      chosen[1] === "removePhoto"
    ) {
      return {
        ok: false,
        error: "photoUrl and removePhoto cannot be used together.",
      };
    }
    if (chosen.length === 2) {
      return {
        ok: false,
        error: `${chosen[0]} and ${chosen[1]} cannot be used together.`,
      };
    }
    return {
      ok: false,
      error: "photo, photoUrl, and removePhoto cannot be used together.",
    };
  }

  if (hasPhoto && args.photo) {
    const decoded = photoFromBase64(args.photo.contentType, args.photo.base64);
    if (!decoded.ok) return decoded;
    return {
      ok: true,
      photo: { bytes: decoded.bytes, contentType: decoded.contentType },
      removePhoto: false,
    };
  }

  if (hasUrl && args.photoUrl) {
    const fetched = await fetchPhotoFromUrl(args.photoUrl);
    if (!fetched.ok) return fetched;
    return {
      ok: true,
      photo: { bytes: fetched.bytes, contentType: fetched.contentType },
      removePhoto: false,
    };
  }

  return { ok: true, removePhoto: remove };
}

async function handle(request: Request): Promise<Response> {
  const ctx = await tryGetMcpContext(request);
  if (!ctx) {
    return unauthorized(request);
  }

  const server = new McpServer(
    { name: "kochbuch", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "kochbuch_add_recipe",
    {
      title: "Add a recipe",
      description:
        "Add a new recipe to the authenticated user's flat. A photo is required: pass fetch_recipe's photo object as photo, or photoUrl for a public image. A call with neither is rejected and nothing is saved. Returns the recipe id and a URL to view it.",
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

      const resolved = await resolveRecipePhoto(args);
      if (!resolved.ok) return toolError(resolved.error);
      if (!resolved.photo) {
        return toolError(
          "A photo is required. Pass photo (the object from fetch_recipe) or photoUrl (a public image URL).",
        );
      }
      const photo = resolved.photo;

      const { id } = await createRecipe({
        flatId: ctx.flat.id,
        name: args.name,
        baseQuantity: args.baseQuantity,
        sourceUrl: args.sourceUrl ?? null,
        sourceHost,
        steps: args.steps ?? "",
        ingredients: normalizeIngredients(args.ingredients),
        photo: { bytes: photo.bytes, contentType: photo.contentType },
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
      if (!UUID_SCHEMA.safeParse(args.id).success)
        return toolError("Recipe id must be a UUID.");
      const recipe = await getRecipeForFlat({
        flatId: ctx.flat.id,
        id: args.id,
      });
      if (!recipe) return toolError("Recipe not found.");
      return jsonResult(recipePayload(recipe, request));
    },
  );

  server.registerTool(
    "kochbuch_edit_recipe",
    {
      title: "Edit a recipe",
      description:
        "Patch fields on an existing recipe in the authenticated user's flat. Returns the recipe id and a URL to view it. Replace the cover with photo (bytes already in hand) or photoUrl (a public image URL). Pass removePhoto to clear it. Use only one of those.",
      inputSchema: editRecipeInput,
    },
    async (args) => {
      if (!UUID_SCHEMA.safeParse(args.id).success)
        return toolError("Recipe id must be a UUID.");

      const resolved = await resolveRecipePhoto(args);
      if (!resolved.ok) return toolError(resolved.error);
      const photo = resolved.photo;

      const recipe = await editRecipe({
        flatId: ctx.flat.id,
        id: args.id,
        patch: {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.baseQuantity !== undefined
            ? { baseQuantity: args.baseQuantity }
            : {}),
          ...(args.steps !== undefined ? { steps: args.steps } : {}),
          ...(args.sourceUrl !== undefined
            ? { sourceUrl: args.sourceUrl }
            : {}),
          ...(args.ingredients
            ? { ingredients: normalizeIngredients(args.ingredients) }
            : {}),
          ...(photo ? { photo } : {}),
          ...(resolved.removePhoto ? { removePhoto: true } : {}),
        },
      });
      if (!recipe) return toolError("Recipe not found.");
      return jsonResult(recipeRefPayload(recipe.id, request));
    },
  );

  server.registerTool(
    "fetch_recipe",
    {
      title: "Fetch a recipe from a URL",
      description:
        "Resolve a recipe into a normalized payload that can be passed to kochbuch_add_recipe. Accepts any recipe page URL that exposes schema.org JSON-LD metadata (most recipe sites and food blogs), as well as kptncook share URLs, uids (7-8 chars), or oids (24 hex chars). Does not store anything — the agent should review and call kochbuch_add_recipe to actually save it. When the result includes a photo, pass that object unchanged as kochbuch_add_recipe's photo argument so the cover is stored. If photo is null, add still requires a photo via photoUrl or a photo object. kptncook imports require KPTNCOOK_API_KEY to be configured server-side.",
      inputSchema: {
        input: z
          .string()
          .trim()
          .min(1)
          .describe(
            "A recipe page URL (e.g. https://example.com/recipes/banana-bread), a kptncook share URL (e.g. https://share.kptncook.com/abc123), uid, or oid",
          ),
        includePhoto: z
          .boolean()
          .default(true)
          .describe("Fetch the cover image bytes (base64 in result)"),
      },
    },
    async (args) => {
      const result = await importRecipe(args.input, {
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
        note: r.photo
          ? "Pass these fields to kochbuch_add_recipe. Pass this photo object unchanged as the photo argument so the cover is stored."
          : 'No cover was found. kochbuch_add_recipe still requires a photo: pass photo with image bytes, or photoUrl with a public image URL.',
      });
    },
  );

  server.registerTool(
    "kochbuch_export_analysis",
    {
      title: "Export analysis tables",
      description:
        "Export the flat's cooking data as normalized JSON tables (recipes, ingredients, cooked) for local analysis. Save each array and load into DuckDB / pandas / SQLite — join ingredients.recipeId → recipes.id (and cooked.recipeId). Cook and recipe names are already on each cooked row. Does not include passwords, photos, steps, or draft/in-stock instances. For the live Draft / In stock plan, use kochbuch_get_plan / kochbuch_update_plan.",
      inputSchema: {},
    },
    async () => {
      const payload = await exportAnalysisTables(ctx.flat.id);
      return jsonResult(payload);
    },
  );

  server.registerTool(
    "kochbuch_get_plan",
    {
      title: "Get the meal plan",
      description:
        "Return the flat's current Draft and In stock plan entries plus household members. " +
        PLAN_SHAPE_DOC,
      inputSchema: {},
    },
    async () => {
      const plan = await getPlanForMcp(ctx.flat.id);
      return jsonResult(plan);
    },
  );

  server.registerTool(
    "kochbuch_update_plan",
    {
      title: "Update the meal plan",
      description:
        "Mutate Draft / In stock. Actions: add_to_draft (recipeId; optional portions, note, cookId), " +
        "remove_from_draft, set_portions (draft only), set_cook (requires cookId; null unassigns), " +
        "set_note (requires note; null/empty clears), reorder (list + unique instanceIds), " +
        "back_to_draft, mark_cooked. Does not finalise draft → in stock (UI-only). " +
        "On success returns { ok, plan, ... } where plan matches kochbuch_get_plan. " +
        PLAN_SHAPE_DOC,
      inputSchema: updatePlanInput,
    },
    async (args) => {
      const result = await applyPlanUpdate(ctx.flat.id, ctx.user.id, args);
      if (!result.ok) return toolError(result.error);
      const plan = await getPlanForMcp(ctx.flat.id);
      return jsonResult({ ...result, plan });
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    // Default is 4 MiB. A cover at the 5 MB photo cap is ~6.7 MB of base64,
    // so the bytes from fetch_recipe would be refused before validation.
    maxRequestBodySize: 8 * 1024 * 1024,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(await normalizeToolCallArgs(request));
  } finally {
    await server.close().catch(() => {});
  }
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
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
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
    photoUrl: recipe.photoBlobKey
      ? `${origin}/r/${recipe.id}/photo?v=${encodeURIComponent(recipe.photoBlobKey)}`
      : null,
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

function unauthorized(request: Request): Response {
  const origin = new URL(request.url).origin;
  // RFC 9728 §3.1 / §5.3: the resource_metadata URL is path-suffixed with
  // the resource path. Our resource is at /mcp.
  return new Response(
    JSON.stringify({
      error: "unauthorized",
      error_description: "Bearer token required",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="kochbuch", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      },
    },
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  return handle(request);
}

export async function action({ request }: Route.ActionArgs) {
  return handle(request);
}
