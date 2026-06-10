import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { getDatabaseUrl } from "./url";
import {
  PERF_ENABLED,
  noteConnect,
  perfFingerprint,
  recordQuery,
} from "../perf";

let pool: Pool | null = null;
let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (cached) return cached;
  const url = getDatabaseUrl();
  pool = new Pool({ connectionString: url });
  if (PERF_ENABLED) instrumentPool(pool, url);
  cached = drizzle(pool, { schema });
  return cached;
}

// Times every query and counts physical connections, gated behind PERF_LOG.
// We patch each physical client's `query` (rather than `pool.query`) so that
// both pooled queries and transaction queries are timed exactly once — no
// double counting. Connection establishment / Neon wake cost shows up as the
// gap between the request start and the first query, plus the pg-connect event.
function instrumentPool(p: Pool, url: string): void {
  let host = "unknown";
  let database = "unknown";
  try {
    const u = new URL(url);
    host = u.host;
    database = u.pathname.replace(/^\//, "") || "unknown";
  } catch {
    // ignore unparseable URLs — fingerprint just stays "unknown"
  }
  perfFingerprint({ host, database });

  p.on("connect", (client: PoolClient) => {
    noteConnect();
    const original = client.query.bind(client);
    // @ts-expect-error - node-postgres has many query() overloads; we wrap
    // them generically. Pool.query drives clients in *callback* form, so we
    // must time around a trailing callback as well as the promise form.
    client.query = (...args: unknown[]) => {
      const first = args[0] as string | { text?: string } | undefined;
      const sql =
        typeof first === "string" ? first : (first?.text ?? "<query>");
      const start = performance.now();

      const last = args[args.length - 1];
      if (typeof last === "function") {
        const cb = last as (...cbArgs: unknown[]) => void;
        args[args.length - 1] = (...cbArgs: unknown[]) => {
          recordQuery(performance.now() - start, sql);
          cb(...cbArgs);
        };
        return original(...(args as Parameters<typeof original>));
      }

      let result: unknown;
      try {
        result = original(...(args as Parameters<typeof original>));
      } catch (err) {
        recordQuery(performance.now() - start, sql);
        throw err;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (result as Promise<unknown>).finally(() =>
          recordQuery(performance.now() - start, sql),
        );
      }
      recordQuery(performance.now() - start, sql);
      return result;
    };
  });
}
