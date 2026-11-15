import { createRequestHandler } from "react-router";
import type { Config } from "@netlify/server";
import * as serverBuild from "../../build/server/server-build.js";

// Same file the tests boot with `react-router-serve`.
const handleRequest = createRequestHandler(serverBuild, "production");

const startedAt = new Date().toISOString();

export default async function handler(request: Request) {
  const response = await handleRequest(request);
  const headers = new Headers(response.headers);
  headers.set("x-cookbook-instance-started-at", startedAt);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const config: Config = {
  // Vite may emit extra chunks beside the server build. The static
  // import above is what the bundler traces; this keeps anything it misses.
  includedFiles: ["../../build/server/**"],
};
