import type { Config } from "@react-router/dev/config";
import type { Preset } from "@react-router/dev/config";

// Deployment target. Defaults to Netlify (the build the test rig and CI
// exercise). On Vercel the platform sets VERCEL=1, which auto-selects the
// vercel target; DEPLOY_TARGET overrides either way. The Vercel preset and
// the Netlify vite plugins are mutually exclusive ways of wrapping the SSR
// bundle.
const target =
  process.env.DEPLOY_TARGET ?? (process.env.VERCEL ? "vercel" : "netlify");

const presets: Preset[] = [];
if (target === "vercel") {
  const { vercelPreset } = await import("@vercel/react-router/vite");
  presets.push(vercelPreset());
}

export default {
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  presets,
} satisfies Config;
