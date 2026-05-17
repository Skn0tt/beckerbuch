import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { getDatabaseUrl } from "./url";

let pool: Pool | null = null;
let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (cached) return cached;
  pool = new Pool({ connectionString: getDatabaseUrl() });
  cached = drizzle(pool, { schema });
  return cached;
}
