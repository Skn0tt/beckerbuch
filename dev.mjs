#!/usr/bin/env node
// Dev orchestrator for the test rig (also usable for local dev):
//   1. Start (or reuse) a Postgres Testcontainer
//   2. Apply the Drizzle schema
//   3. Spawn `netlify dev` with DATABASE_URL injected into its environment
//
// Playwright's webServer config points at this script. There is no separate
// globalSetup — everything ordering-sensitive happens here, in one place.

import { execSync, spawn } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

if (process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE) {
  delete process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE;
}

let databaseUrl;

if (process.env.SKIP_TESTCONTAINER === "1" && process.env.DATABASE_URL) {
  // Neon parity CI: an external Postgres URL is already set (an
  // ephemeral Neon branch) and migrations have already been applied
  // outside this script. Skip container + schema push.
  databaseUrl = process.env.DATABASE_URL;
  console.log(`[dev] SKIP_TESTCONTAINER=1, reusing DATABASE_URL=${databaseUrl}`);
} else {
  console.log("[dev] Starting Postgres container…");
  const container = await new PostgreSqlContainer("postgres:16")
    .withDatabase("cookbook_test")
    .withUsername("cookbook")
    .withPassword("cookbook")
    .withReuse()
    .start();

  databaseUrl = container.getConnectionUri();
  console.log(`[dev] DATABASE_URL=${databaseUrl}`);

  console.log("[dev] Enabling extensions…");
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

  console.log("[dev] Applying schema (drizzle-kit push)…");
  execSync("npx drizzle-kit push --force", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

console.log("[dev] Starting kptncook mock…");
const { startKptncookMock, KPTNCOOK_MOCK_PORT, KPTNCOOK_MOCK_API_KEY } =
  await import("./tests/kptncook-mock.mjs");
const kptncookMock = await startKptncookMock();
const kptncookBaseUrl = `http://127.0.0.1:${KPTNCOOK_MOCK_PORT}`;
console.log(`[dev] kptncook mock at ${kptncookBaseUrl}`);

console.log("[dev] Spawning netlify dev…");
const child = spawn("npx", ["netlify", "dev", "--port", "8888", "--no-open"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: process.env.NODE_ENV ?? "test",
    SESSION_SECRET:
      process.env.SESSION_SECRET ?? "test-only-not-a-secret-but-long-enough",
    ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? "test-admin-token",
    KPTNCOOK_API_KEY: process.env.KPTNCOOK_API_KEY ?? KPTNCOOK_MOCK_API_KEY,
    KPTNCOOK_BASE_URL: process.env.KPTNCOOK_BASE_URL ?? kptncookBaseUrl,
    // Issue #7: tests use the deterministic fake dedup backend so
    // we never hit the real LLM during npm test.
    DEDUP_BACKEND: process.env.DEDUP_BACKEND ?? "fake",
  },
});

const forward = (sig) => () => {
  kptncookMock.close();
  child.kill(sig);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("exit", (code) => {
  kptncookMock.close();
  process.exit(code ?? 0);
});
