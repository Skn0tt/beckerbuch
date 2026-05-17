import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

let pool: Pool | null = null;
let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (cached) return cached;
  const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL or NETLIFY_DATABASE_URL must be set");
  pool = new Pool({ connectionString: url });
  cached = drizzle(pool, { schema });
  return cached;
}
