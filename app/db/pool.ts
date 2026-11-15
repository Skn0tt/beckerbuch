import { Pool } from "pg";
import { getDatabaseUrl } from "./url";

// The Netlify Server entry and the React Router server build are
// separate module graphs in one process. A module-level variable
// would give each graph its own pool; globalThis is the one they share.
const POOL_KEY = "cookbook.pgPool";

type Host = typeof globalThis & { [POOL_KEY]?: Pool };

function host(): Host {
  return globalThis as Host;
}

/**
 * Idle clients are closed at 20s. Netlify Server drops an outbound
 * connection after 60s with no bytes in either direction, and TCP
 * keepalive does not count, so the pool has to retire them first.
 */
export function getPool(): Pool {
  const current = host()[POOL_KEY];
  if (current) return current;
  const pool = new Pool({
    connectionString: getDatabaseUrl(),
    idleTimeoutMillis: 20_000,
  });
  host()[POOL_KEY] = pool;
  return pool;
}

export function peekPool(): Pool | undefined {
  return host()[POOL_KEY];
}

export async function closePool(): Promise<void> {
  const pool = peekPool();
  if (!pool) return;
  delete host()[POOL_KEY];
  await pool.end();
}
