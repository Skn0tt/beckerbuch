import { and, eq } from "drizzle-orm";
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/u.$id.avatar.$token";
import { requireFlatMember } from "../auth/require";
import { db } from "../db/client";
import { flatMembers } from "../db/schema";
import { readAvatar } from "../lib/avatars";
import { parseParams } from "../lib/form";

const ParamsSchema = z.object({ id: z.guid(), token: z.guid() });

export async function loader({ request, params }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const { id, token } = parseParams(ParamsSchema, params, "Avatar not found.");
  const [member] = await db()
    .select({ userId: flatMembers.userId })
    .from(flatMembers)
    .where(
      and(eq(flatMembers.flatId, ctx.flat.id), eq(flatMembers.userId, id)),
    )
    .limit(1);
  if (!member) throw data("Avatar not found.", { status: 404 });
  const blob = await readAvatar(`avatars/${id}/${token}`);
  if (!blob) throw data("Avatar not found.", { status: 404 });
  return new Response(blob.body, {
    headers: {
      "Content-Type": blob.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
