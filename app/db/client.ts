import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { getPool } from "./pool";

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (cached) return cached;
  cached = drizzle(getPool(), { schema });
  return cached;
}
