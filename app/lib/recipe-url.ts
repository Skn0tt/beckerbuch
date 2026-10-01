/**
 * Share sheets copy a marketing sentence next to the recipe link.
 * KptnCook's wording varies ("Look at this great recipe I've just
 * discovered in the KptnCook app. https://share.kptncook.com/…"), so
 * we key off the URL rather than the sentence.
 *
 * When the text contains exactly one http(s) URL, return that URL.
 * Anything else (a bare kptncook id, a clean URL, several links, or
 * text with no link) is returned unchanged.
 */
function trimTrailingUrlPunctuation(raw: string): string {
  let url = raw.replace(/[.,;:!?]+$/g, "");
  // A wrapping ")" from "(https://…)" is not part of the link. A ")"
  // that closes a "(" inside the URL (Wikipedia-style) is.
  if (url.endsWith(")") && !url.includes("(")) {
    url = url.replace(/\)+$/g, "");
  }
  return url;
}

export function isolateRecipeUrl(value: string): string {
  const matches = value.match(/https?:\/\/[^\s<>"']+/gi);
  if (!matches || matches.length !== 1) return value;

  const raw = matches[0];
  const url = trimTrailingUrlPunctuation(raw);
  const leftover = value.replace(raw, "").trim();
  if (!leftover && url === value) return value;
  return url;
}
