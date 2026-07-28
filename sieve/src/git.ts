/**
 * Git helpers for the scheduler UI bootstrap.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseDiffLines } from "../../tests/coverage-select.ts";

const execFileAsync = promisify(execFile);

export function repoRootFromEnv(): string {
  if (process.env.SIEVE_REPO_ROOT) {
    return path.resolve(process.env.SIEVE_REPO_ROOT);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export async function loadGitDiff(repoRoot: string): Promise<{
  diffText: string;
  diffLineCount: number;
  refLabel: string;
}> {
  if (process.env.SIEVE_BOOTSTRAP_DIFF_FILE) {
    try {
      const { readFile } = await import("node:fs/promises");
      const diffText = await readFile(process.env.SIEVE_BOOTSTRAP_DIFF_FILE, "utf8");
      return {
        diffText,
        diffLineCount: parseDiffLines(diffText).size,
        refLabel: "SIEVE_BOOTSTRAP_DIFF_FILE",
      };
    } catch {
      // fall through to other sources
    }
  }

  if (process.env.SIEVE_BOOTSTRAP_DIFF) {
    const diffText = process.env.SIEVE_BOOTSTRAP_DIFF;
    return {
      diffText,
      diffLineCount: parseDiffLines(diffText).size,
      refLabel: "SIEVE_BOOTSTRAP_DIFF",
    };
  }

  const tryDiff = async (args: string[], refLabel: string) => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { diffText: stdout, diffLineCount: parseDiffLines(stdout).size, refLabel };
  };

  try {
    return await tryDiff(["diff", "main...HEAD"], "main…HEAD");
  } catch {
    try {
      return await tryDiff(["diff", "master...HEAD"], "master…HEAD");
    } catch {
      const fallback = await tryDiff(["diff", "HEAD"], "HEAD (working tree)");
      return fallback;
    }
  }
}

export function repoLabel(repoRoot: string): string {
  const home = process.env.HOME ?? "";
  if (home && repoRoot.startsWith(home)) {
    return "~" + repoRoot.slice(home.length);
  }
  return repoRoot;
}
