/**
 * Debounced recursive watch of the repo for uncommitted-diff reload.
 */

import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

const IGNORE =
  /(^|\/)(node_modules|\.git|\.playwright-data|\.playwright-cli|playwright-report|test-results|\.react-router|build|\.netlify|coverage|sieve\/node_modules|sieve\/\.database-url|sieve\/\.bootstrap-diff\.patch)(\/|$)/;

export function watchRepo(
  repoRoot: string,
  onChange: () => void,
  debounceMs = 400,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(repoRoot, { recursive: true }, (_event, filename) => {
      if (filename) {
        const rel = filename.split(path.sep).join("/");
        if (IGNORE.test(rel)) return;
      }
      schedule();
    });
  } catch (err) {
    console.warn(
      `[scheduler] fs.watch(recursive) unavailable for ${repoRoot}:`,
      err,
    );
    return () => undefined;
  }

  watcher.on("error", (err) => {
    console.warn("[scheduler] repo watch error", err);
  });

  console.log(`[scheduler] watching ${repoRoot} for diff changes`);
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
