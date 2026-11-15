import type { ServerBuild } from "react-router";

// TypeScript resolves `#server-build` here (the `types` condition).
// Node and the Netlify bundler follow `default` in package.json
// `imports` to `build/server/server-build.js`, which `react-router build`
// emits and which does not exist yet when `tsc` runs.
const build = {} as ServerBuild;

export const routes = build.routes;
export const entry = build.entry;
export const assets = build.assets;
export const basename = build.basename;
export const publicPath = build.publicPath;
export const assetsBuildDirectory = build.assetsBuildDirectory;
export const future = build.future;
export const ssr = build.ssr;
export const isSpaMode = build.isSpaMode;
export const prerender = build.prerender;
export const routeDiscovery = build.routeDiscovery;
export const allowedActionOrigins = build.allowedActionOrigins;
