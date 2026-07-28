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

async function gitDiff(
  repoRoot: string,
  args: string[],
  refLabel: string,
): Promise<{
  diffText: string;
  diffLineCount: number;
  refLabel: string;
}> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    diffText: stdout,
    diffLineCount: parseDiffLines(stdout).size,
    refLabel,
  };
}

/**
 * Diff used for plan preview / Run.
 *
 * Default: uncommitted changes (`git diff HEAD` = staged + unstaged vs HEAD).
 * Optional overrides: SIEVE_BOOTSTRAP_DIFF_FILE / SIEVE_BOOTSTRAP_DIFF.
 */
export async function loadGitDiff(repoRoot: string): Promise<{
  diffText: string;
  diffLineCount: number;
  refLabel: string;
}> {
  if (process.env.SIEVE_BOOTSTRAP_DIFF_FILE) {
    try {
      const { readFile } = await import("node:fs/promises");
      const diffText = await readFile(
        process.env.SIEVE_BOOTSTRAP_DIFF_FILE,
        "utf8",
      );
      return {
        diffText,
        diffLineCount: parseDiffLines(diffText).size,
        refLabel: "SIEVE_BOOTSTRAP_DIFF_FILE",
      };
    } catch {
      // fall through
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

  return gitDiff(repoRoot, ["diff", "HEAD"], "uncommitted");
}

export function repoLabel(repoRoot: string): string {
  const home = process.env.HOME ?? "";
  if (home && repoRoot.startsWith(home)) {
    return "~" + repoRoot.slice(home.length);
  }
  return repoRoot;
}
