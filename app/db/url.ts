import { getConnectionString } from "@netlify/database";

// Resolves a Postgres connection string. Prefers a manually-set DATABASE_URL
// (used by tests against Testcontainers and any external Postgres) and falls
// back to Netlify Database's auto-injected NETLIFY_DB_URL via the official
// @netlify/database helper.
export function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return getConnectionString();
}
