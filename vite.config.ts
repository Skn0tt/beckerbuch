import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type PluginOption } from "vite";

// Deployment target switch. Default (Netlify) keeps the build byte-identical
// to what the test rig and CI run. Vercel sets VERCEL=1 during its build,
// which auto-selects the vercel target; DEPLOY_TARGET overrides either way.
// On the vercel target the Netlify vite plugins are dropped and the Vercel
// preset (react-router.config.ts) wraps the SSR bundle instead.
const target =
  process.env.DEPLOY_TARGET ?? (process.env.VERCEL ? "vercel" : "netlify");
const vercel = target === "vercel";

async function targetPlugins(): Promise<PluginOption[]> {
  if (vercel) return [reactRouter()];
  // Lazy-load the Netlify plugins so a Vercel build never touches them.
  const [{ default: netlifyReactRouter }, { default: netlify }] =
    await Promise.all([
      import("@netlify/vite-plugin-react-router"),
      import("@netlify/vite-plugin"),
    ]);
  return [netlify(), reactRouter(), netlifyReactRouter()];
}

export default defineConfig(async () => ({
  plugins: await targetPlugins(),
  resolve: {
    tsconfigPaths: true,
  },
  define: {
    // Stable per build. On Netlify this is the deploy ID, on Vercel the
    // deployment ID — every deploy gets a fresh value → all clients
    // invalidate cached SWR entries the first time they load the new
    // bundle. Locally it's just "dev" (stable across reloads to avoid
    // noise).
    __SWR_VERSION__: JSON.stringify(
      process.env.DEPLOY_ID ?? process.env.VERCEL_DEPLOYMENT_ID ?? "dev",
    ),
  },
}));
