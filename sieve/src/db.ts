import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  if (process.env.SIEVE_SKIP_MIGRATE !== "1") {
    const sql = await readFile(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(sql);
  }
  // Additive patches for reuse / skip-migrate sessions.
  await pool.query(
    `ALTER TABLE test_results
     ADD COLUMN IF NOT EXISTS title_path text NOT NULL DEFAULT ''`,
  );
}

export async function withClient<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
