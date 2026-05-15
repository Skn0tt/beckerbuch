import { execSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FullConfig } from "@playwright/test";

export default async function globalSetup(_config: FullConfig) {
  console.log("[globalSetup] Starting Postgres container…");

  // The TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE env var only matters for
  // docker-in-docker scenarios where containers need to know how to reach
  // the host's socket. When it points at a non-existent path (e.g. on a
  // Colima host where /var/run/docker.sock doesn't exist), Testcontainers
  // can fail its runtime probe. Clear it for the test process — the actual
  // connection still uses DOCKER_HOST.
  if (process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE) {
    delete process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE;
  }

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16",
  )
    .withDatabase("cookbook_test")
    .withUsername("cookbook")
    .withPassword("cookbook")
    .withReuse()
    .start();

  const databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;

  console.log("[globalSetup] Enabling extensions…");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS unaccent;
  `);
  await client.end();

  console.log("[globalSetup] Applying schema (drizzle-kit push)…");
  execSync("npx drizzle-kit push --force", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  console.log(`[globalSetup] Ready: ${databaseUrl}`);

  return async () => {
    if (process.env.TESTCONTAINERS_REUSE_ENABLE === "true") {
      console.log("[globalTeardown] Reuse mode — leaving container running.");
      return;
    }
    console.log("[globalTeardown] Stopping container…");
    await container.stop();
  };
}

