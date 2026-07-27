/**
 * Pure unit tests for coverage-select + sort-reporter helpers.
 * Imports @playwright/test directly so worker server / coverage fixtures
 * are not started.
 */
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildIndex,
  hitLinesFromIstanbul,
  orderAndFilterTestIds,
  parseDiffLines,
  selectTests,
  testIdFromCoverageDirName,
} from "./coverage-select";

function istanbulFile(
  filePath: string,
  statements: Array<{ id: string; start: number; end: number; hits: number }>,
) {
  const statementMap: Record<
    string,
    { start: { line: number; column: number }; end: { line: number; column: number } }
  > = {};
  const s: Record<string, number> = {};
  for (const stmt of statements) {
    statementMap[stmt.id] = {
      start: { line: stmt.start, column: 0 },
      end: { line: stmt.end, column: 10 },
    };
    s[stmt.id] = stmt.hits;
  }
  return { path: filePath, statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} };
}

test.describe("coverage-select", () => {
  test("testIdFromCoverageDirName strips worker prefix", () => {
    expect(testIdFromCoverageDirName("0-abc123")).toBe("abc123");
    expect(testIdFromCoverageDirName("12-foo_bar")).toBe("foo_bar");
    expect(testIdFromCoverageDirName("not-a-worker")).toBeNull();
    expect(testIdFromCoverageDirName("0-")).toBeNull();
  });

  test("hitLinesFromIstanbul expands hit statement ranges", () => {
    const lines = hitLinesFromIstanbul({
      "app/a.ts": istanbulFile("app/a.ts", [
        { id: "0", start: 2, end: 4, hits: 3 },
        { id: "1", start: 9, end: 9, hits: 0 },
      ]),
    });
    expect([...lines].sort()).toEqual([
      "app/a.ts:2",
      "app/a.ts:3",
      "app/a.ts:4",
    ]);
  });

  test("parseDiffLines collects app/ added lines only", () => {
    const diff = `
diff --git a/app/routes/login.tsx b/app/routes/login.tsx
--- a/app/routes/login.tsx
+++ b/app/routes/login.tsx
@@ -10,6 +10,8 @@ export function loader() {
   const x = 1;
+  const y = 2;
+  const z = 3;
   return x;
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # hi
+extra
`.trim();

    const lines = parseDiffLines(diff);
    expect(lines.has("app/routes/login.tsx:11")).toBe(true);
    expect(lines.has("app/routes/login.tsx:12")).toBe(true);
    expect(lines.has("README.md:2")).toBe(false);
  });

  test("buildIndex indexes lines per test from coverage dirs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cov-idx-"));
    try {
      const aDir = path.join(root, "0-testA");
      const bDir = path.join(root, "1-testB");
      await mkdir(aDir);
      await mkdir(bDir);
      await writeFile(
        path.join(aDir, "coverage.json"),
        JSON.stringify({
          "app/a.ts": istanbulFile("app/a.ts", [
            { id: "0", start: 1, end: 1, hits: 1 },
            { id: "1", start: 2, end: 2, hits: 1 },
          ]),
        }),
      );
      await writeFile(
        path.join(bDir, "coverage.json"),
        JSON.stringify({
          "app/a.ts": istanbulFile("app/a.ts", [
            { id: "0", start: 2, end: 2, hits: 1 },
          ]),
        }),
      );

      const index = await buildIndex(root);
      expect(index.testLines.get("testA")?.has("app/a.ts:1")).toBe(true);
      expect(index.lineTests.get("app/a.ts:2")?.has("testA")).toBe(true);
      expect(index.lineTests.get("app/a.ts:2")?.has("testB")).toBe(true);
      expect(index.lineTests.get("app/a.ts:1")?.has("testB")).toBeFalsy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selectTests prefers high density then reinforces under leftover budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cov-sel-"));
    try {
      const cases: Array<{
        id: string;
        stmts: Array<{ id: string; start: number; end: number; hits: number }>;
      }> = [
        {
          id: "cheap",
          stmts: [
            { id: "0", start: 1, end: 1, hits: 1 },
            { id: "1", start: 2, end: 2, hits: 1 },
          ],
        },
        {
          id: "expensive",
          stmts: [{ id: "0", start: 1, end: 1, hits: 1 }],
        },
        {
          id: "other",
          stmts: [{ id: "0", start: 2, end: 2, hits: 1 }],
        },
      ];
      for (const { id, stmts } of cases) {
        const dir = path.join(root, `0-${id}`);
        await mkdir(dir);
        await writeFile(
          path.join(dir, "coverage.json"),
          JSON.stringify({
            "app/x.ts": istanbulFile("app/x.ts", stmts),
          }),
        );
      }

      const index = await buildIndex(root);
      const diff = `
--- a/app/x.ts
+++ b/app/x.ts
@@ -1,2 +1,2 @@
+line1
+line2
`.trim();

      const durations = { cheap: 10, expensive: 100, other: 10 };

      // Budget only fits cheap → unique coverage of both lines.
      expect(
        selectTests({ index, durations, diff, budgetMs: 10 }),
      ).toEqual(["cheap"]);

      // Full unique coverage with cheap, then reinforce with other (same
      // density family) before expensive — budget 20 → cheap + other.
      expect(
        selectTests({ index, durations, diff, budgetMs: 20 }),
      ).toEqual(["cheap", "other"]);

      // Larger budget keeps spending after full unique coverage.
      const big = selectTests({
        index,
        durations,
        diff,
        budgetMs: 200,
      });
      expect(big[0]).toBe("cheap");
      expect(big).toContain("other");
      expect(big).toContain("expensive");
      expect(big.length).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selectTests IDF prefers rare-line specialists over cheap importers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cov-idf-"));
    try {
      // 8 cheap importers hit only the common line; specialist hits rare+common.
      const cases: Array<{
        id: string;
        stmts: Array<{ id: string; start: number; end: number; hits: number }>;
      }> = [];
      for (let i = 0; i < 8; i++) {
        cases.push({
          id: `cheap${i}`,
          stmts: [{ id: "0", start: 1, end: 1, hits: 1 }],
        });
      }
      cases.push({
        id: "specialist",
        stmts: [
          { id: "0", start: 1, end: 1, hits: 1 },
          { id: "1", start: 2, end: 2, hits: 1 },
        ],
      });
      for (const { id, stmts } of cases) {
        const dir = path.join(root, `0-${id}`);
        await mkdir(dir);
        await writeFile(
          path.join(dir, "coverage.json"),
          JSON.stringify({
            "app/feat.ts": istanbulFile("app/feat.ts", stmts),
          }),
        );
      }

      const index = await buildIndex(root);
      const diff = `
--- a/app/feat.ts
+++ b/app/feat.ts
@@ -1,2 +1,2 @@
+common
+rare
`.trim();
      const durations: Record<string, number> = { specialist: 50 };
      for (let i = 0; i < 8; i++) durations[`cheap${i}`] = 10;

      const selected = selectTests({
        index,
        durations,
        diff,
        budgetMs: 70,
      });
      // Must cover the rare line: specialist before burning budget on more cheaps.
      expect(selected).toContain("specialist");
      expect(selected[0]).toBe("specialist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orderAndFilterTestIds keeps order and lists excludes", () => {
    const { keep, exclude } = orderAndFilterTestIds(
      ["c", "a", "b"],
      ["b", "a", "missing"],
    );
    expect(keep).toEqual(["b", "a"]);
    expect(exclude.sort()).toEqual(["c"]);
  });
});
