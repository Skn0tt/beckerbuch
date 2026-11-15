import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // Tests boot this file with `react-router-serve`, and the Netlify
  // Server entry imports the same path. Pin it so the filename does
  // not depend on a Vite plugin's rollup `entryFileNames` override.
  serverBuildFile: "server-build.js",
} satisfies Config;
