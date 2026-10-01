/**
 * KptnCook's share sheet copies a sentence ("Look at this great recipe
 * I've just discovered in the KptnCook app.") with the recipe URL
 * attached as a hyperlink, not always as characters in the text.
 *
 * Plain-text targets differ: Signal and Telegram often expand that
 * link, so the paste includes the URL. Safari's text fields keep only
 * the sentence. When the URL is still on the clipboard (HTML href,
 * URI list, or another flavor) or the browser materializes an <a>,
 * we can recover it. Once a plain-text app has already dropped it,
 * there is nothing left to recover.
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

function uniqueHttpUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [...new Set(matches.map(trimTrailingUrlPunctuation))];
}

function decodeHtmlAttr(value: string): string {
  return value
    .replace(/&(?:amp|quot|#0*39|apos|lt|gt);/gi, (entity) => {
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&quot;":
          return '"';
        case "&apos;":
        case "&#39;":
          return "'";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        default:
          return "'";
      }
    });
}

function hrefsFromHtml(html: string): string[] {
  const urls: string[] = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of html.matchAll(re)) {
    const raw = decodeHtmlAttr(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (/^https?:\/\//i.test(raw)) urls.push(trimTrailingUrlPunctuation(raw));
  }
  return urls;
}

function urlsFromUriList(uriList: string): string[] {
  const urls: string[] = [];
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^https?:\/\//i.test(trimmed))
      urls.push(trimTrailingUrlPunctuation(trimmed));
  }
  return urls;
}

function isKptncookUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "kptncook.com" || host.endsWith(".kptncook.com");
  } catch {
    return false;
  }
}

function firstKptncook(urls: string[]): string | null {
  return urls.find(isKptncookUrl) ?? null;
}

function onlyUrl(urls: string[]): string | null {
  const distinct = [...new Set(urls)];
  return distinct.length === 1 ? distinct[0] : null;
}

export type ClipboardParts = {
  plain?: string;
  html?: string;
  uriList?: string;
  /** Other clipboard flavors (RTF, public.url, …) as raw text. */
  extra?: string[];
  /** hrefs the browser already inserted, when it pastes rich text. */
  hrefs?: string[];
};

/**
 * When `value` contains exactly one http(s) URL, return that URL.
 * A bare id, a clean URL, several links, or text with no link is
 * returned unchanged.
 */
export function isolateRecipeUrl(value: string): string {
  const matches = value.match(/https?:\/\/[^\s<>"']+/gi);
  if (!matches || matches.length !== 1) return value;

  const raw = matches[0];
  const url = trimTrailingUrlPunctuation(raw);
  const leftover = value.replace(raw, "").trim();
  if (!leftover && url === value) return value;
  return url;
}

/**
 * Pick the recipe link out of a paste. Prefers a URL the user can
 * see, then a kptncook URL hiding in the rich-text flavors, then a
 * single hyperlink. Returns null when nothing can be chosen.
 */
export function recipeUrlFromClipboard(parts: ClipboardParts): string | null {
  const plain = parts.plain ?? "";
  const plainUrls = uniqueHttpUrls(plain);
  if (plainUrls.length === 1) return plainUrls[0];

  const htmlHrefs = hrefsFromHtml(parts.html ?? "");
  const uriUrls = urlsFromUriList(parts.uriList ?? "");
  const domHrefs = (parts.hrefs ?? [])
    .map((href) => href.trim())
    .filter((href) => /^https?:\/\//i.test(href))
    .map(trimTrailingUrlPunctuation);
  const extraUrls = (parts.extra ?? []).flatMap(uniqueHttpUrls);

  const rich = [
    ...htmlHrefs,
    ...uriUrls,
    ...domHrefs,
    ...extraUrls,
    ...plainUrls,
  ];
  return (
    firstKptncook(rich) ?? onlyUrl([...htmlHrefs, ...uriUrls, ...domHrefs])
  );
}

type ClipboardReader = {
  types: Iterable<string> | ArrayLike<string>;
  getData: (type: string) => string;
};

function readType(data: ClipboardReader, type: string): string {
  try {
    return data.getData(type) ?? "";
  } catch {
    return "";
  }
}

/** Read every flavor a paste event exposes and pick a recipe URL. */
export function recipeUrlFromClipboardData(
  data: ClipboardReader,
): string | null {
  const types = Array.from(data.types as ArrayLike<string>);
  const extra = types.map((type) => readType(data, type));
  return recipeUrlFromClipboard({
    plain: readType(data, "text/plain"),
    html: readType(data, "text/html"),
    uriList: [
      readType(data, "text/uri-list"),
      readType(data, "public.url"),
      readType(data, "URL"),
    ]
      .filter(Boolean)
      .join("\n"),
    extra,
  });
}
