#!/usr/bin/env node
// Runs pending Drizzle migrations against $DATABASE_URL / $NETLIFY_DB_URL.
// Used by netlify.toml's build command so we get full error output on failure
// (drizzle-kit's CLI swallows errors in some environments).
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DB_URL;
if (!url) {
  console.error("DATABASE_URL or NETLIFY_DB_URL must be set");
  process.exit(1);
}

console.log("Connecting to database...");
const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

try {
  const db = drizzle(pool);
  console.log("Applying migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully.");
} catch (err) {
  console.error("Migration failed:");
  console.error(err);
  process.exit(1);
} finally {
  await pool.end();
}
