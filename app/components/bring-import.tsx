import { useEffect, useRef } from "react";

const SCRIPT_SRC = "https://platform.getbring.com/widgets/import.js";

type BringImportRenderConfig = {
  url: string;
  language?: string;
  theme?: string;
  // Documented as the HTML attr `data-bring-requires-consent`; the
  // late-render config object doesn't list it, but we pass it anyway
  // so a render() that copies config → data-* still gates GA.
  requiresConsent?: string;
};

declare global {
  interface Window {
    bringwidgets?: {
      import?: {
        render: (el: HTMLElement, config: BringImportRenderConfig) => void;
      };
    };
  }
}

/**
 * Official Bring! import button. The widget does not take ingredients —
 * it tells Bring! to fetch `url` and scrape schema.org Recipe JSON-LD.
 *
 * Rendered after mount via `bringwidgets.import.render` so the script
 * cannot mutate SSR HTML before React hydrates (which would wipe the
 * button on the next render). The host div stays empty from React's
 * point of view for the same reason: a Split/Regenerate re-render
 * must not reset innerHTML the widget owns.
 *
 * Quantity attrs are intentionally omitted — JSON-LD already emits
 * scaled, deduped lines, and Bring would multiply again if
 * baseQuantity ≠ requestedQuantity.
 *
 * `data-bring-requires-consent` is set so the widget does not inject
 * Google Analytics (cookbook has no cookie banner).
 */
export function BringImport({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;

    const render = () => {
      if (cancelled || !ref.current) return;
      window.bringwidgets?.import?.render(ref.current, {
        url,
        language: "en",
        theme: "dark",
        requiresConsent: "true",
      });
    };

    el.setAttribute("data-bring-requires-consent", "true");

    if (window.bringwidgets?.import?.render) {
      render();
      return () => {
        cancelled = true;
      };
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.async = true;
      script.src = SCRIPT_SRC;
      document.head.appendChild(script);
    }
    script.addEventListener("load", render);
    return () => {
      cancelled = true;
      script.removeEventListener("load", render);
    };
  }, [url]);

  return (
    <>
      <div ref={ref} data-testid="bring-import" />
      <noscript>
        <a href="https://www.getbring.com">
          Bring! Einkaufsliste App für iPhone und Android
        </a>
      </noscript>
    </>
  );
}
