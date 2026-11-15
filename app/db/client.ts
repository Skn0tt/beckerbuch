import { onHealthCheck, onShutdown, onStart } from "@netlify/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { getDatabaseUrl } from "./url";

// Vite inlines this module into the server build. The Netlify entry
// must not import it, or that file and this one each open a pool.

let pool: Pool | null = null;

/**
 * Idle clients are closed at 20s. Netlify Server drops an outbound
 * connection after 60s with no bytes in either direction, and TCP
 * keepalive does not count, so the pool has to retire them first.
 */
function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: getDatabaseUrl(),
    idleTimeoutMillis: 20_000,
  });
  return pool;
}

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (cached) return cached;
  cached = drizzle(getPool(), { schema });
  return cached;
}

onStart(async () => {
  await getPool().query("select 1");
});

onShutdown(async ({ drained }) => {
  await drained;
  if (!pool) return;
  const current = pool;
  pool = null;
  cached = null;
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
