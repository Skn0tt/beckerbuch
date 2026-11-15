import { createRequestHandler, type ServerBuild } from "react-router";
import {
  onHealthCheck,
  onShutdown,
  onStart,
  type Config,
} from "@netlify/server";
import { closePool, getPool, peekPool } from "../../app/db/pool";
import * as serverBuildNs from "#server-build";

// `@netlify/vite-plugin-react-router` publishes a function on `/*`.
// Functions run before the server, so that adapter has to stay out of
// the deploy or this process never receives a request. The handler
// below serves the same `build/server/server-build.js` the tests boot
// with `react-router-serve`.
const handleRequest = createRequestHandler(
  serverBuildNs as unknown as ServerBuild,
  "production",
);

const startedAt = new Date().toISOString();

onStart(async () => {
  await getPool().query("select 1");
});

onShutdown(async ({ drained }) => {
  await drained;
  await closePool();
});

onHealthCheck(() => {
  const pool = peekPool();
  if (!pool) return;
  const max = pool.options.max || 10;
  const inUse = pool.totalCount - pool.idleCount;
  return {
    utilization: { db_pool: inUse / max },
    namedMetrics: {
      db_pool_waiting: pool.waitingCount,
      db_pool_total: pool.totalCount,
    },
  };
});

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
