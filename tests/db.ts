import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFileSync, existsSync } from "node:fs";
import * as schema from "../app/db/schema";

let _pool: Pool | undefined;

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync(".cookbook-test-db-url")) {
    const url = readFileSync(".cookbook-test-db-url", "utf8").trim();
    process.env.DATABASE_URL = url;
    return url;
  }
  throw new Error(
    "DATABASE_URL not set and .cookbook-test-db-url missing — run dev.mjs (or `npm test`) first",
  );
}

export function pool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: databaseUrl() });
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
