import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: true,
  // TODO(perf): per-worker `netlify dev` boot is slow (~15–30s cold),
  // so we're temporarily pinned to a single worker. Speeding up the
  // dev-server boot is a separate workstream; once that lands we can
  // unpin this (or remove the line entirely).
  workers: 1,
  expect: {
    // Mantine + React Router revalidations can occasionally take a couple
    // of seconds under load; give expects extra headroom so transient
    // server pauses don't fail assertions.
    timeout: 10_000,
  },
  reporter: process.env.CI ? "github" : "list",
  use: {
    // baseURL is set per worker by the `server` fixture, which spawns
    // its own `netlify dev`. There is no global webServer; see
    // tests/fixtures.ts.
    trace: "on-first-retry",
  },
});

