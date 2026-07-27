// Remap Playwright JSCoverage + Node V8 coverage through source maps
// into a single Istanbul coverage map keyed by original `app/` paths.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import libCoverage from "istanbul-lib-coverage";
import type {
  CoverageMap,
  CoverageMapData,
} from "istanbul-lib-coverage";
import v8toIstanbul from "v8-to-istanbul";
import type { TestInfo } from "@playwright/test";

const { createCoverageMap } = libCoverage;

const PROJECT_ROOT = process.cwd();
const APP_ROOT = path.resolve(PROJECT_ROOT, "app");

export type PlaywrightJSCoverageEntry = {
  url: string;
  scriptId: string;
  source?: string;
  functions: Array<{
    functionName: string;
    isBlockCoverage: boolean;
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
};

function toAppRelativeKey(filePath: string): string | null {
  let resolved = filePath;
  if (filePath.startsWith("file://")) {
    try {
      resolved = fileURLToPath(filePath);
    } catch {
      return null;
    }
  }
  // Vite sometimes prefixes with `/@fs/` or query/hash suffixes.
  resolved = resolved.replace(/^\/@fs\//, "/").split("?")[0].split("#")[0];
  resolved = path.resolve(resolved);
  if (!resolved.startsWith(APP_ROOT + path.sep) && resolved !== APP_ROOT) {
    return null;
  }
  return path.relative(PROJECT_ROOT, resolved).split(path.sep).join("/");
}

// Source maps point at every original file the bundle pulled in
// (node_modules, Vite/RR virtual modules, etc.). We only keep project
// `app/` paths so the artifact stays small and about our code.
function filterToApp(istanbul: CoverageMapData): CoverageMapData {
  const out: CoverageMapData = {};
  for (const [key, value] of Object.entries(istanbul)) {
    const appKey = toAppRelativeKey(key);
    if (!appKey) continue;
    out[appKey] = {
      ...(typeof value === "object" && value !== null ? value : {}),
      path: appKey,
    } as CoverageMapData[string];
  }
  return out;
}

function mergeFiltered(into: CoverageMap, istanbul: CoverageMapData): void {
  into.merge(filterToApp(istanbul));
}

export async function remapFrontendCoverage(
  entries: PlaywrightJSCoverageEntry[],
): Promise<CoverageMap> {
  const merged = createCoverageMap({});
  for (const entry of entries) {
    if (!entry.source) continue;
    try {
      const converter = v8toIstanbul(entry.url || "", 0, {
        source: entry.source,
      });
      await converter.load();
      converter.applyCoverage(entry.functions);
      mergeFiltered(merged, converter.toIstanbul());
    } catch (err) {
      console.error(
        `[coverage] frontend remap failed for ${entry.url}:`,
        err,
      );
    }
  }
  return merged;
}

type V8CoverageFile = {
  result?: Array<{
    scriptId?: string;
    url: string;
    functions: PlaywrightJSCoverageEntry["functions"];
  }>;
};

export async function remapBackendCoverage(
  coverageFiles: string[],
): Promise<CoverageMap> {
  const merged = createCoverageMap({});
  for (const file of coverageFiles) {
    let parsed: V8CoverageFile;
    try {
      parsed = JSON.parse(await readFile(file, "utf8")) as V8CoverageFile;
    } catch (err) {
      console.error(`[coverage] failed to read V8 file ${file}:`, err);
      continue;
    }
    for (const script of parsed.result ?? []) {
      if (!script.url || script.url.startsWith("node:")) continue;
      if (script.url.includes("node_modules")) continue;
      let scriptPath = script.url;
      if (scriptPath.startsWith("file://")) {
        try {
          scriptPath = fileURLToPath(scriptPath);
        } catch {
          continue;
        }
      }
      // Only attempt remap for our server build (maps live beside it).
      if (!scriptPath.includes(`${path.sep}build${path.sep}server${path.sep}`)) {
        continue;
      }
      try {
        const converter = v8toIstanbul(scriptPath);
        await converter.load();
        converter.applyCoverage(script.functions);
        mergeFiltered(merged, converter.toIstanbul());
      } catch (err) {
        console.error(
          `[coverage] backend remap failed for ${script.url}:`,
          err,
        );
      }
    }
  }
  return merged;
}

export function coverageArtifactDir(testInfo: TestInfo): string {
  const worker = testInfo.parallelIndex;
  const safeId = testInfo.testId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  // Durable path outside Playwright's `test-results/` outputDir, which
  // is wiped at the start of every run (before reporter.preprocess).
  return path.join(
    PROJECT_ROOT,
    ".playwright-data",
    "coverage",
    `${worker}-${safeId}`,
  );
}

export async function writeCoverageArtifacts(opts: {
  testInfo: TestInfo;
  frontendEntries: PlaywrightJSCoverageEntry[];
  backendFiles: string[];
}): Promise<void> {
  const dir = coverageArtifactDir(opts.testInfo);
  await mkdir(dir, { recursive: true });

  const merged = createCoverageMap({});
  merged.merge(await remapFrontendCoverage(opts.frontendEntries));
  merged.merge(await remapBackendCoverage(opts.backendFiles));

  const coveragePath = path.join(dir, "coverage.json");
  await writeFile(coveragePath, JSON.stringify(merged.toJSON(), null, 2));

  // Attach so the HTML report / trace viewer surface it next to the test.
  await opts.testInfo.attach("coverage", {
    path: coveragePath,
    contentType: "application/json",
  });
}

/** List JSON files currently in a NODE_V8_COVERAGE directory. */
export async function listV8CoverageFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => path.join(dir, n))
      .sort();
  } catch {
    return [];
  }
}
