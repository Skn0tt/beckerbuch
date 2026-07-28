/**
 * Duration-balanced packing of selected test ids into shard buckets.
 * Contiguous slices of the ordered list (solid color bands in the UI).
 */

function durationOf(durations: Record<string, number>, testId: string): number {
  const raw = durations[testId];
  if (typeof raw === "number" && raw > 0) return raw;
  return 1;
}

/**
 * Cut the ordered `testIds` list into `shardCount` contiguous slices with
 * roughly equal duration sums. Empty shards are dropped.
 */
export function packShards(
  testIds: string[],
  durations: Record<string, number>,
  shardCount: number,
): string[][] {
  const n = Math.max(1, Math.floor(shardCount));
  if (testIds.length === 0) return [];

  const shards: string[][] = Array.from({ length: n }, () => []);
  const sums = new Array<number>(n).fill(0);
  let cursor = 0;

  for (let s = 0; s < n; s++) {
    const shardsLeft = n - s;
    if (shardsLeft === 1) {
      while (cursor < testIds.length) {
        const id = testIds[cursor++]!;
        shards[s]!.push(id);
        sums[s]! += durationOf(durations, id);
      }
      break;
    }

    let remDur = 0;
    for (let i = cursor; i < testIds.length; i++) {
      remDur += durationOf(durations, testIds[i]!);
    }
    const target = remDur / shardsLeft;

    let take = 0;
    let acc = 0;
    // Leave at least one slot per remaining shard.
    while (cursor + take < testIds.length - (shardsLeft - 1)) {
      acc += durationOf(durations, testIds[cursor + take]!);
      take += 1;
      if (acc >= target) break;
    }
    if (take === 0 && cursor < testIds.length) take = 1;

    for (let k = 0; k < take; k++) {
      const id = testIds[cursor++]!;
      shards[s]!.push(id);
      sums[s]! += durationOf(durations, id);
    }
  }

  return shards.filter((s) => s.length > 0);
}
