#!/usr/bin/env node
// Runs pending Drizzle migrations against the configured database.
// Used by netlify.toml's build command. Resolves the URL via
// @netlify/database (which reads NETLIFY_DB_URL) with a DATABASE_URL fallback.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { getConnectionString } from "@netlify/database";

const url = process.env.DATABASE_URL ?? getConnectionString();

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
