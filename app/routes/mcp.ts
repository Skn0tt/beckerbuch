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
  searchRecipes,
  type FlatRecipe,
  type RecipeListItem,
} from "../lib/recipes";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const recipeIdSchema = z
  .string()
  .regex(UUID_RE, "Recipe id must be a UUID.")
  .describe("Recipe id");

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
        ingredients: args.ingredients.map((p, position) => ({
          position,
          amount: p.amount?.trim() ? p.amount.trim() : null,
          unit: p.unit?.trim() ? p.unit.trim() : null,
          item: p.item.trim(),
        })),
        photo,
      });

      const url = new URL(request.url);
      const recipeUrl = `${url.origin}/recipes/${id}`;
      return {
        content: [
          {
            type: "text",
            text: `Added "${args.name}". View it at ${recipeUrl}`,
          },
        ],
      };
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
      if (!UUID_RE.test(args.id)) return toolError("Recipe id must be a UUID.");
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
        "Patch fields on an existing recipe in the authenticated user's flat.",
      inputSchema: editRecipeInput,
    },
    async (args) => {
      if (!UUID_RE.test(args.id)) return toolError("Recipe id must be a UUID.");
      if (args.photoUrl && args.removePhoto) {
        return toolError("photoUrl and removePhoto cannot be used together.");
      }

      let photo: { bytes: Uint8Array; contentType: string } | undefined;
      if (args.photoUrl) {
        const fetched = await fetchPhotoFromUrl(args.photoUrl);
        if (!fetched.ok) return toolError(fetched.error);
        photo = { bytes: fetched.bytes, contentType: fetched.contentType };
      }

      const nextIngredients = args.ingredients?.map((ingredient, position) => {
        const item = ingredient.item.trim();
        return {
          position,
          amount: ingredient.amount?.trim() ? ingredient.amount.trim() : null,
          unit: ingredient.unit?.trim() ? ingredient.unit.trim() : null,
          item,
        };
      });
      if (nextIngredients?.some((ingredient) => ingredient.item.length === 0)) {
        return toolError("Each ingredient item is required.");
      }

      const recipe = await editRecipe({
        flatId: ctx.flat.id,
        id: args.id,
        patch: {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.baseQuantity !== undefined ? { baseQuantity: args.baseQuantity } : {}),
          ...(args.steps !== undefined ? { steps: args.steps } : {}),
          ...(args.sourceUrl !== undefined ? { sourceUrl: args.sourceUrl } : {}),
          ...(nextIngredients ? { ingredients: nextIngredients } : {}),
          ...(photo ? { photo } : {}),
          ...(args.removePhoto ? { removePhoto: true } : {}),
        },
      });
      if (!recipe) return toolError("Recipe not found.");
      return jsonResult(recipePayload(recipe, request));
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => {});
  }
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

function unauthorized(request: Request): Response {
  const origin = new URL(request.url).origin;
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="kochbuch", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
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
