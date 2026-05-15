import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../app/db/schema";

let _pool: Pool | undefined;

export function pool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL not set — globalSetup must run before fixtures use the test DB",
      );
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

export function db() {
  return drizzle(pool(), { schema });
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
