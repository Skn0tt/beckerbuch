import { createRequestHandler } from "react-router";
import type { Config } from "@netlify/server";
import * as serverBuild from "../../build/server/server-build.js";

// Same file the tests boot with `react-router-serve`. Netlify also
// passes its own context; leave that out of React Router's loadContext.
const handleRequest = createRequestHandler(serverBuild, "production");

export default function handler(request: Request) {
  return handleRequest(request);
}

export const config: Config = {
  // Vite may emit extra chunks beside the server build. The static
  // import above is what the bundler traces; this keeps anything it misses.
  includedFiles: ["../../build/server/**"],
};
