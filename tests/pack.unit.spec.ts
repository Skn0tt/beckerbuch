/**
 * Unit tests for sieve file-aware shard packing.
 */
import { test, expect } from "@playwright/test";
import { packShards, shardSourceFiles } from "../sieve/src/pack.ts";

test.describe("packShards", () => {
  test("empty selection yields no shards", () => {
    expect(packShards([], { a: 1 }, 3)).toEqual([]);
  });

  test("shardCount 1 keeps all tests on one shard, ordered by source then id", () => {
    const packed = packShards(
      ["b", "a", "c"],
      { a: 5, b: 5, c: 5 },
      1,
      { a: "tests/z.spec.ts", b: "tests/a.spec.ts", c: "tests/z.spec.ts" },
    );
    expect(packed).toEqual([["b", "a", "c"]]);
  });

  test("same-file tests stay on one shard when under target", () => {
    const packed = packShards(
      ["f1a", "f1b", "f2a"],
      { f1a: 10, f1b: 10, f2a: 20 },
      2,
      {
        f1a: "tests/one.spec.ts",
        f1b: "tests/one.spec.ts",
        f2a: "tests/two.spec.ts",
      },
    );
    expect(packed).toHaveLength(2);
    const byFile = packed.map((shard) =>
      shard.filter((id) => id.startsWith("f1")),
    );
    // Both f1 tests together on exactly one shard.
    expect(byFile.filter((s) => s.length === 2)).toHaveLength(1);
    expect(byFile.filter((s) => s.length === 0)).toHaveLength(1);
  });

  test("LPT puts two heavy files on different shards", () => {
    const packed = packShards(
      ["heavyA", "heavyB", "tiny"],
      { heavyA: 100, heavyB: 100, tiny: 1 },
      2,
      {
        heavyA: "tests/a.spec.ts",
        heavyB: "tests/b.spec.ts",
        tiny: "tests/c.spec.ts",
      },
    );
    expect(packed).toHaveLength(2);
    const homes = new Map<string, number>();
    packed.forEach((shard, i) => {
      for (const id of shard) homes.set(id, i);
    });
    expect(homes.get("heavyA")).not.toBe(homes.get("heavyB"));
    // Tiny joins the lighter shard — after equal heavies, first gets tiny.
    expect(homes.get("tiny")).toBeDefined();
  });

  test("oversized file is split; small files stay intact", () => {
    // target = 90/2 = 45. big file = 30+30+30=90 → split; small=10 stays whole.
    const packed = packShards(
      ["b1", "b2", "b3", "s1", "s2"],
      { b1: 30, b2: 30, b3: 30, s1: 5, s2: 5 },
      2,
      {
        b1: "tests/big.spec.ts",
        b2: "tests/big.spec.ts",
        b3: "tests/big.spec.ts",
        s1: "tests/small.spec.ts",
        s2: "tests/small.spec.ts",
      },
    );
    expect(packed).toHaveLength(2);
    const smallHomes = new Set<number>();
    packed.forEach((shard, i) => {
      if (shard.includes("s1") || shard.includes("s2")) {
        if (shard.includes("s1")) smallHomes.add(i);
        if (shard.includes("s2")) smallHomes.add(i);
      }
    });
    // Small file intact on one shard.
    expect(smallHomes.size).toBe(1);
    const shardWithS = packed.find((s) => s.includes("s1"))!;
    expect(shardWithS).toContain("s2");

    // Big file appears on both shards (was split).
    const bigShardCount = packed.filter((s) =>
      s.some((id) => id.startsWith("b")),
    ).length;
    expect(bigShardCount).toBe(2);
  });

  test("missing sources treat each test as its own group", () => {
    const packed = packShards(
      ["a", "b", "c"],
      { a: 10, b: 10, c: 100 },
      2,
    );
    expect(packed).toHaveLength(2);
    // Heaviest alone; two light ones share the other shard.
    expect(packed.some((s) => JSON.stringify(s) === JSON.stringify(["c"]))).toBe(
      true,
    );
    expect(
      packed.some((s) => s.includes("a") && s.includes("b") && s.length === 2),
    ).toBe(true);
  });
});

test.describe("shardSourceFiles", () => {
  test("returns unique sorted real paths", () => {
    expect(
      shardSourceFiles(["a", "b", "c", "d"], {
        a: "tests/b.spec.ts",
        b: "tests/a.spec.ts",
        c: "seed",
        d: "tests/a.spec.ts",
      }),
    ).toEqual(["tests/a.spec.ts", "tests/b.spec.ts"]);
  });
});
