import { and, eq } from "drizzle-orm";
import { data } from "react-router";
import type { Route } from "./+types/u.$id.avatar.$token";
import { requireFlatMember } from "../auth/require";
import { db } from "../db/client";
import { flatMembers } from "../db/schema";
import { readAvatar } from "../lib/avatars";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loader({ request, params }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  if (!UUID_RE.test(params.id) || !UUID_RE.test(params.token)) {
    throw data("Avatar not found.", { status: 404 });
  }
  const [member] = await db()
    .select({ userId: flatMembers.userId })
    .from(flatMembers)
    .where(
      and(eq(flatMembers.flatId, ctx.flat.id), eq(flatMembers.userId, params.id)),
    )
    .limit(1);
  if (!member) throw data("Avatar not found.", { status: 404 });
  const blob = await readAvatar(`avatars/${params.id}/${params.token}`);
  if (!blob) throw data("Avatar not found.", { status: 404 });
  return new Response(blob.body, {
    headers: {
      "Content-Type": blob.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
