import { reactRouter } from "@react-router/dev/vite";
import netlifyReactRouter from "@netlify/vite-plugin-react-router";
import netlify from "@netlify/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [netlify(), reactRouter(), netlifyReactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    // Playwright/sieve can run multiple `react-router build` processes in
    // parallel (one globalSetup per shard). Default emptyOutDir races on
    // rmdir(build/client/assets). Test builds set VITE_EMPTY_OUT_DIR=0.
    emptyOutDir: process.env.VITE_EMPTY_OUT_DIR !== "0",
  },
});

