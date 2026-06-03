import { reactRouter } from "@react-router/dev/vite";
import netlifyReactRouter from "@netlify/vite-plugin-react-router";
import netlify from "@netlify/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [netlify(), reactRouter(), netlifyReactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  define: {
    // Stable per build. On Netlify this is the deploy ID, so every
    // deploy gets a fresh value → all clients invalidate cached SWR
    // entries the first time they load the new bundle. Locally it's
    // just "dev" (stable across reloads to avoid noise).
    __SWR_VERSION__: JSON.stringify(process.env.DEPLOY_ID ?? "dev"),
  },
});
