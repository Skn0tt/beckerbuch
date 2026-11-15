import { onHealthCheck, onShutdown, onStart } from "@netlify/server";
import { Pool } from "pg";
import { getDatabaseUrl } from "./url";

// One module, one pool. Vite inlines this file into the server build,
// so the Netlify entry must not import it: that would be a second copy.
// Hooks are registered here, while that build is loaded, and close over
// this binding.

let pool: Pool | null = null;

/**
 * Idle clients are closed at 20s. Netlify Server drops an outbound
 * connection after 60s with no bytes in either direction, and TCP
 * keepalive does not count, so the pool has to retire them first.
 */
export function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: getDatabaseUrl(),
    idleTimeoutMillis: 20_000,
  });
  return pool;
}

onStart(async () => {
  await getPool().query("select 1");
});

onShutdown(async ({ drained }) => {
  await drained;
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
});

onHealthCheck(() => {
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
