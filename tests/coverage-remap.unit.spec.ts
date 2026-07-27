/**
 * Pure unit tests for coverage remapping helpers.
 * Imports @playwright/test directly so worker server / coverage fixtures
 * are not started.
 */
import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import v8toIstanbul from "v8-to-istanbul";
import {
  dropUntouchedFiles,
  remapBackendCoverage,
  resetCoverageLineCounts,
} from "./coverage-remap";

async function spawnNode(opts: {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, opts.args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (b) => {
      err += String(b);
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}: ${err}`));
    });
  });
}

async function serverBuildJs(): Promise<string | null> {
  try {
    const name = (await readdir("build/server/assets")).find(
      (n) => n.startsWith("server-build-") && n.endsWith(".js"),
    );
    return name ? path.resolve("build/server/assets", name) : null;
  } catch {
    return null;
  }
}

test.describe("coverage-remap", () => {
  test("resetCoverageLineCounts + empty apply leaves bodies uncovered", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cov-remap-"));
    try {
      const src = path.join(dir, "mod.mjs");
      await writeFile(
        src,
        [
          "export function target(to, fallback = '/') {",
          "  if (!to) return fallback;",
          "  if (to[0] !== '/') return fallback;",
          "  return to;",
          "}",
          "",
        ].join("\n"),
      );

      const converter = v8toIstanbul(src) as unknown as Parameters<
        typeof resetCoverageLineCounts
      >[0] & {
        load(): Promise<void>;
        applyCoverage(blocks: unknown[]): void;
        toIstanbul(): Record<string, { s: Record<string, number> }>;
      };
      await converter.load();
      // v8-to-istanbul default: everything starts covered.
      const before = converter.toIstanbul()[src];
      expect(Object.values(before.s).every((n) => n > 0)).toBe(true);

      resetCoverageLineCounts(converter);
      converter.applyCoverage([]);
      const after = converter.toIstanbul()[src];
      expect(Object.values(after.s).every((n) => n === 0)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dropUntouchedFiles removes all-zero entries", () => {
    const out = dropUntouchedFiles({
      "app/a.ts": {
        path: "app/a.ts",
        statementMap: {
          "0": {
            start: { line: 1, column: 0 },
            end: { line: 1, column: 1 },
          },
        },
        s: { "0": 0 },
      },
      "app/b.ts": {
        path: "app/b.ts",
        statementMap: {
          "0": {
            start: { line: 1, column: 0 },
            end: { line: 1, column: 1 },
          },
        },
        s: { "0": 2 },
      },
    } as never);
    expect(Object.keys(out)).toEqual(["app/b.ts"]);
  });

  test("import-only server build does not cover safeRedirectTarget body", async () => {
    const serverBuild = await serverBuildJs();
    test.skip(!serverBuild, "server build missing — run npm test once first");

    const covDir = await mkdtemp(path.join(os.tmpdir(), "v8-import-"));
    try {
      await spawnNode({
        args: [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(pathToFileURL(serverBuild!).href)});`,
        ],
        env: { ...process.env, NODE_V8_COVERAGE: covDir },
      });

      const files = (await readdir(covDir))
        .filter((n) => n.endsWith(".json"))
        .map((n) => path.join(covDir, n));
      expect(files.length).toBeGreaterThan(0);

      const map = (await remapBackendCoverage(files)).toJSON();
      const sr = map["app/auth/safe-redirect.ts"];
      // Absent (preferred) or present with body lines still at 0.
      if (sr) {
        for (const [id, meta] of Object.entries(sr.statementMap)) {
          const line = meta.start.line;
          if (line >= 8) {
            expect(sr.s[id], `L${line} should be uncovered on import`).toBe(0);
          }
        }
      }

      const appFiles = Object.keys(map).filter((k) => k.startsWith("app/"));
      expect(appFiles.length).toBeLessThan(67);
    } finally {
      await rm(covDir, { recursive: true, force: true });
    }
  });

  test("post-takeCoverage 404 dump does not paint safe-redirect body", async () => {
    test.skip(!(await serverBuildJs()), "server build missing");

    const covDir = await mkdtemp(path.join(os.tmpdir(), "v8-404-"));
    try {
      const script = `
        import v8 from 'node:v8';
        import { readdir, unlink } from 'node:fs/promises';
        import path from 'node:path';
        const dir = process.env.NODE_V8_COVERAGE;
        const server = await import('./build/server/server.js');
        v8.takeCoverage();
        for (const f of await readdir(dir)) {
          if (f.endsWith('.json')) await unlink(path.join(dir, f));
        }
        const res = await server.default(new Request('http://localhost/h/not-a-uuid'));
        if (res.status !== 404) throw new Error('expected 404, got ' + res.status);
        v8.takeCoverage();
      `;
      await spawnNode({
        args: ["--input-type=module", "-e", script],
        env: { ...process.env, NODE_V8_COVERAGE: covDir },
      });

      const files = (await readdir(covDir))
        .filter((n) => n.endsWith(".json"))
        .map((n) => path.join(covDir, n));
      const map = (await remapBackendCoverage(files)).toJSON();

      expect(
        map["app/auth/safe-redirect.ts"],
        "safe-redirect must not appear from a 404-only dump",
      ).toBeUndefined();

      const handoff = map["app/routes/h.$flatId.tsx"];
      expect(handoff).toBeTruthy();
      expect(Object.values(handoff.s).some((n) => n > 0)).toBe(true);

      const appFiles = Object.keys(map).filter((k) => k.startsWith("app/"));
      expect(appFiles.length).toBeLessThan(30);
    } finally {
      await rm(covDir, { recursive: true, force: true });
    }
  });
});
