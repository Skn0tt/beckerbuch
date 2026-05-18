import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  expect: {
    // Mantine + React Router revalidations can occasionally take a couple
    // of seconds under load; give expects extra headroom so transient
    // server pauses don't fail assertions.
    timeout: 10_000,
  },
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
