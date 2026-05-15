import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  // 2 workers ≈ 35% faster than serial without overwhelming the
  // netlify dev → Vite SSR pipeline. 3+ workers triggers proxy
  // timeouts.
  workers: 2,
  // One retry absorbs occasional dev-server contention hiccups (a
  // single request occasionally exceeds the default 5s timeout when
  // Vite is mid-transform). A genuine regression fails on every
  // retry, so this doesn't hide real bugs.
  retries: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:8888",
    trace: "on-first-retry",
  },
  webServer: {
    command: "node dev.mjs",
    url: "http://localhost:8888",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
