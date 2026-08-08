import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  fullyParallel: true,
  expect: {
    // Mantine + React Router revalidations can occasionally take a couple
    // of seconds under load; give expects extra headroom so transient
    // server pauses don't fail assertions.
    timeout: 10_000,
  },
  reporter: process.env.CI ? "github" : "list",
  use: {
    // baseURL is set per worker by the `server` fixture, which spawns
    // its own Vite dev server. There is no global webServer; see
    // tests/fixtures.ts.
    trace: "on-first-retry",
  },
});

