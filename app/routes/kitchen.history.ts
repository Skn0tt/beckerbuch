import { z } from "zod";
import { requireFlatMember } from "../auth/require";
import { loadCookedHistory } from "../lib/kitchen-data";

export async function loader({ request }: { request: Request }) {
  const ctx = await requireFlatMember(request);
  const url = new URL(request.url);
  const offsetRaw = url.searchParams.get("offset") ?? "0";
  const offset = z.coerce.number().int().min(0).catch(0).parse(offsetRaw);
  const result = await loadCookedHistory(ctx.flat.id, offset);
  return Response.json(result);
}
