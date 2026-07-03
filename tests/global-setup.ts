// Per-run bootstrap: Postgres testcontainer + drizzle schema push +
// a production build of the app. Runs once before any worker starts;
// sets `DATABASE_URL` on `process.env` so worker fixtures inherit it
// when spawning their per-worker `react-router-serve` process.
//
// With `withReuse()`, the container survives across `playwright test`
// invocations on a developer machine; CI cold-starts.

import { execSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

export default async function globalSetup() {
  if (process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE) {
    delete process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE;
  }

  console.log("[global-setup] Starting Postgres container…");
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("cookbook_test")
    .withUsername("cookbook")
    .withPassword("cookbook")
    .withReuse()
    .start();

  const databaseUrl = container.getConnectionUri();
  console.log(`[global-setup] DATABASE_URL=${databaseUrl}`);

  console.log("[global-setup] Enabling extensions…");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS unaccent;
    CREATE EXTENSION IF NOT EXISTS vector;
  `);
  await client.end();

  console.log("[global-setup] Applying schema (drizzle-kit push)…");
  execSync("npx drizzle-kit push --force", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  // Tests run against the production build (one `react-router-serve`
  // process per worker), not the Vite dev server. This eliminates the
  // typegen-on-boot race that bites when multiple workers boot Vite
  // in parallel, and matches what gets deployed to Netlify.
  console.log("[global-setup] Building app (react-router build)…");
  execSync("npm run build", { stdio: "inherit" });

  process.env.DATABASE_URL = databaseUrl;
}
