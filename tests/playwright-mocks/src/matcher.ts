// URL matcher used by `route()` (registration) and the waiters
// (waitForRequest / waitForResponse). Single source of truth so a
// `route(pattern, …)` and `waitForRequest(pattern)` never disagree.

export type RoutePattern = string | RegExp | ((url: URL) => boolean);

export function matchPattern(pattern: RoutePattern, urlStr: string): boolean {
  if (typeof pattern === "function") {
    try {
      return pattern(new URL(urlStr));
    } catch {
      return false;
    }
  }
  if (pattern instanceof RegExp) return pattern.test(urlStr);
  return globMatch(pattern, urlStr);
}

/**
 * Playwright-ish glob. Supports:
 *   `*`     — any chars except `/`
 *   `**`    — any chars including `/`
 *   `?`     — any single char except `/`
 *   `[abc]` — character class (passed through to regex)
 *   `{a,b}` — alternation
 * Anchors at start + end. Plain strings without globs match exactly.
 */
export function globMatch(pattern: string, urlStr: string): boolean {
  let re = "^";
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
      } else {
        // regex char-class syntax is a strict subset of glob char-class
        // syntax, so we can pass the bracketed slice through verbatim.
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (ch === "{") {
      re += "(?:";
      braceDepth++;
    } else if (ch === "}" && braceDepth > 0) {
      re += ")";
      braceDepth--;
    } else if (ch === "," && braceDepth > 0) {
      re += "|";
    } else if ("\\^$.|+()".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re).test(urlStr);
}
