import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:8888",
    trace: "on-first-retry",
  },
  globalSetup: "./tests/global-setup.ts",
  webServer: {
    command: "npx netlify dev --port 8888",
    url: "http://localhost:8888",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-only-not-a-secret",
    },
  },
});
