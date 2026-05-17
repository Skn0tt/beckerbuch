import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Route } from "./+types/mcp";
import { tryGetMcpContext } from "../auth/oauth-token";
import { createRecipe, fetchPhotoFromUrl } from "../lib/recipes";

const ingredientSchema = z.object({
  amount: z.string().optional(),
  unit: z.string().optional(),
  item: z.string().min(1).max(200),
});

const addRecipeInput = {
  name: z.string().min(1).max(200).describe("Recipe name"),
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
