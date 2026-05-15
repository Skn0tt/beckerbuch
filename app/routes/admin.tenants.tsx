import { randomUUID } from "node:crypto";
import type { Route } from "./+types/admin.tenants";
import { db } from "../db/client";
import { flats, invites } from "../db/schema";
import { checkAdmin } from "../auth/admin";
import { generateInviteToken } from "../auth/invite";

type Body = {
  flatName?: string;
};

/**
 * Provision a fresh flat and a single-use invite. The first redeemer of
 * the invite becomes the founder via the normal /invite/:token flow —
 * we deliberately don't pre-create a user here so there's only one
 * user-creation code path to worry about.
 */
export async function action({ request }: Route.ActionArgs) {
  const denied = checkAdmin(request);
  if (denied) return denied;
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = ((await safeJson(request)) ?? {}) as Body;
  const flatName = body.flatName ?? `Test Flat ${randomUUID().slice(0, 8)}`;

  const result = await db().transaction(async (tx) => {
    const [flat] = await tx
      .insert(flats)
      .values({ name: flatName })
      .returning({ id: flats.id, name: flats.name });
    const inviteToken = generateInviteToken();
    await tx.insert(invites).values({
      token: inviteToken,
      flatId: flat.id,
      // createdBy is null: this is a system-created bootstrap invite,
      // there is no user yet.
    });
    return { flat, inviteToken };
  });

  return Response.json({
    flat: result.flat,
    inviteUrl: `${new URL(request.url).origin}/invite/${result.inviteToken}`,
    inviteToken: result.inviteToken,
  });
}

async function safeJson(request: Request): Promise<unknown> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}
