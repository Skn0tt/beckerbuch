/**
 * Lightweight fixtures for pure unit specs that import `app/` into the
 * Playwright worker. Collects inspector precise coverage (no browser,
 * no react-router-serve) and writes the same per-test Istanbul artifacts
 * as the E2E `_coverage` fixture.
 */
import { Session } from "node:inspector/promises";
import { test as base, expect } from "@playwright/test";
import {
  writeCoverageArtifacts,
  type V8ScriptCoverage,
} from "./coverage-remap";

type WorkerCoverageFixtures = {
  _workerCoverage: void;
};

/** One inspector session per worker process. */
let coverageSession: Session | null = null;

async function getCoverageSession(): Promise<Session> {
  if (coverageSession) return coverageSession;
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  coverageSession = session;
  return session;
}

/**
 * CDP takePreciseCoverage → V8 script list for remapWorkerCoverage.
 * Drops scripts with no url (anonymous / eval).
 */
function scriptsFromPreciseCoverage(result: unknown): V8ScriptCoverage[] {
  const scripts = (result as { result?: V8ScriptCoverage[] })?.result ?? [];
  return scripts.filter((s) => typeof s.url === "string" && s.url.length > 0);
}

export const test = base.extend<WorkerCoverageFixtures>({
  _workerCoverage: [
    async ({}, use, testInfo) => {
      const session = await getCoverageSession();
      // Per-test start/stop so a worker that later runs E2E specs is not
      // left with Profiler precise coverage enabled.
      await session.post("Profiler.startPreciseCoverage", {
        callCount: true,
        detailed: true,
      });
      // Discard baseline so only execution during `use()` counts.
      await session.post("Profiler.takePreciseCoverage");

      await use();

      try {
        const taken = await session.post("Profiler.takePreciseCoverage");
        await writeCoverageArtifacts({
          testInfo,
          workerScripts: scriptsFromPreciseCoverage(taken),
        });
      } catch (err) {
        console.error("[coverage] worker precise coverage failed:", err);
        testInfo.annotations.push({
          type: "coverage",
          description: `worker coverage failed: ${String(err)}`,
        });
      } finally {
        try {
          await session.post("Profiler.stopPreciseCoverage");
        } catch {
          // ignore — session may already be stopped after an error
        }
      }
    },
    { auto: true },
  ],
});

export { expect };
