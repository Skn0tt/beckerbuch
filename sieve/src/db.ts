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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coverage_hits (
      run_id     uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      test_id    text NOT NULL,
      file_path  text NOT NULL,
      line       int NOT NULL CHECK (line > 0),
      PRIMARY KEY (run_id, test_id, file_path, line)
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS coverage_hits_run_line_idx
      ON coverage_hits (run_id, file_path, line)`);
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
