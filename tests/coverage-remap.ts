// Remap Playwright JSCoverage + Node V8 coverage through source maps
// into Istanbul-style maps keyed by original `app/` paths.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8toIstanbul from "v8-to-istanbul";
import type { TestInfo } from "@playwright/test";

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

type IstanbulMap = Record<string, unknown>;

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

function filterToApp(istanbul: IstanbulMap): IstanbulMap {
  const out: IstanbulMap = {};
  for (const [key, value] of Object.entries(istanbul)) {
    const appKey = toAppRelativeKey(key);
    if (!appKey) continue;
    out[appKey] = value && typeof value === "object"
      ? { ...(value as object), path: appKey }
      : value;
  }
  return out;
}

function mergeIstanbul(into: IstanbulMap, from: IstanbulMap): void {
  for (const [key, value] of Object.entries(from)) {
    if (!(key in into)) {
      into[key] = value;
      continue;
    }
    // Prefer first write; per-test artifacts don't need a full merge of
    // statement maps across scripts that alias the same source.
  }
}

export async function remapFrontendCoverage(
  entries: PlaywrightJSCoverageEntry[],
): Promise<IstanbulMap> {
  const merged: IstanbulMap = {};
  for (const entry of entries) {
    if (!entry.source) continue;
    try {
      const converter = v8toIstanbul(entry.url || "", 0, {
        source: entry.source,
      });
      await converter.load();
      converter.applyCoverage(entry.functions);
      mergeIstanbul(merged, filterToApp(converter.toIstanbul() as IstanbulMap));
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
): Promise<IstanbulMap> {
  const merged: IstanbulMap = {};
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
        mergeIstanbul(
          merged,
          filterToApp(converter.toIstanbul() as IstanbulMap),
        );
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
  return path.join(
    PROJECT_ROOT,
    "test-results",
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
  const frontend = await remapFrontendCoverage(opts.frontendEntries);
  const backend = await remapBackendCoverage(opts.backendFiles);
  const frontendPath = path.join(dir, "frontend.json");
  const backendPath = path.join(dir, "backend.json");
  await writeFile(frontendPath, JSON.stringify(frontend, null, 2));
  await writeFile(backendPath, JSON.stringify(backend, null, 2));

  // Attach so the HTML report / trace viewer surface them next to the test.
  await opts.testInfo.attach("coverage-frontend", {
    path: frontendPath,
    contentType: "application/json",
  });
  await opts.testInfo.attach("coverage-backend", {
    path: backendPath,
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
