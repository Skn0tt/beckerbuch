/**
 * Duration-balanced packing of selected tests into shard buckets.
 *
 * Groups by Playwright source file (file-locality), splits a file only when
 * it exceeds the per-shard duration target, then assigns groups with LPT
 * (longest-processing-time first) onto the lightest shard.
 */

function durationOf(durations: Record<string, number>, testId: string): number {
  const raw = durations[testId];
  if (typeof raw === "number" && raw > 0) return raw;
  return 1;
}

function groupKey(source: string | undefined, testId: string): string {
  const src = (source ?? "").trim();
  // Empty / synthetic seed rows are not real files — keep them atomic alone.
  if (!src || src === "seed") return `__solo:${testId}`;
  return src;
}

type Chunk = {
  /** Grouping key (file path or solo sentinel). */
  key: string;
  /** Source used for within-shard ordering. */
  sortSource: string;
  testIds: string[];
  duration: number;
};

/**
 * Pack `testIds` into up to `shardCount` shards.
 *
 * @param sources Optional map testId → Playwright file (`source`). Missing /
 *   empty / `"seed"` → each test is its own group.
 */
export function packShards(
  testIds: string[],
  durations: Record<string, number>,
  shardCount: number,
  sources?: Record<string, string>,
): string[][] {
  const n = Math.max(1, Math.floor(shardCount));
  if (testIds.length === 0) return [];

  const sourceById = sources ?? {};

  // Preserve selection order within each file group.
  const groupOrder: string[] = [];
  const groups = new Map<string, string[]>();
  for (const id of testIds) {
    const key = groupKey(sourceById[id], id);
    let list = groups.get(key);
    if (!list) {
      groupOrder.push(key);
      list = [];
      groups.set(key, list);
    }
    list.push(id);
  }

  let total = 0;
  for (const id of testIds) total += durationOf(durations, id);
  const target = total / n;

  const chunks: Chunk[] = [];
  for (const key of groupOrder) {
    const ids = groups.get(key)!;
    const sortSource = key.startsWith("__solo:")
      ? (sourceById[ids[0]!] ?? "").trim()
      : key;
    let groupDur = 0;
    for (const id of ids) groupDur += durationOf(durations, id);

    if (groupDur <= target || ids.length === 1) {
      chunks.push({ key, sortSource, testIds: [...ids], duration: groupDur });
      continue;
    }

    // Oversized file: contiguous chunks each ≤ target (single tests may exceed).
    let acc = 0;
    let cur: string[] = [];
    for (const id of ids) {
      const d = durationOf(durations, id);
      if (cur.length > 0 && acc + d > target) {
        chunks.push({ key, sortSource, testIds: cur, duration: acc });
        cur = [];
        acc = 0;
      }
      cur.push(id);
      acc += d;
    }
    if (cur.length > 0) {
      chunks.push({ key, sortSource, testIds: cur, duration: acc });
    }
  }

  // LPT: heaviest group first → lightest shard (tie → lowest index).
  chunks.sort(
    (a, b) =>
      b.duration - a.duration ||
      a.key.localeCompare(b.key) ||
      a.testIds[0]!.localeCompare(b.testIds[0]!),
  );

  const shardChunks: Chunk[][] = Array.from({ length: n }, () => []);
  const sums = new Array<number>(n).fill(0);
  for (const chunk of chunks) {
    let best = 0;
    for (let i = 1; i < n; i++) {
      if (sums[i]! < sums[best]!) best = i;
    }
    shardChunks[best]!.push(chunk);
    sums[best]! += chunk.duration;
  }

  const out: string[][] = [];
  for (let s = 0; s < n; s++) {
    const assigned = shardChunks[s]!;
    if (assigned.length === 0) continue;

    const ids = assigned.flatMap((c) => c.testIds);
    ids.sort((a, b) => {
      const sa = (sourceById[a] ?? "").trim();
      const sb = (sourceById[b] ?? "").trim();
      if (sa !== sb) return sa.localeCompare(sb);
      return a.localeCompare(b);
    });
    out.push(ids);
  }
  return out;
}

/** Unique non-empty Playwright file paths for a shard’s tests. */
export function shardSourceFiles(
  testIds: string[],
  sources: Record<string, string>,
): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const id of testIds) {
    const src = (sources[id] ?? "").trim();
    if (!src || src === "seed") continue;
    if (seen.has(src)) continue;
    seen.add(src);
    files.push(src);
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}
