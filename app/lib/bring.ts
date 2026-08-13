/**
 * Official no-JS Bring! import. Bring 307s this to an app deeplink, then
 * fetches `pageUrl` and scrapes schema.org Recipe JSON-LD. Quantity
 * params are omitted so Bring does not re-scale lines that are already
 * at target quantity.
 *
 * https://sites.google.com/getbring.com/bring-import-dev-guide/web-to-app-integration
 */
export function bringImportHref(pageUrl: string): string {
  const href = new URL("https://api.getbring.com/rest/bringrecipes/deeplink");
  href.searchParams.set("url", pageUrl);
  href.searchParams.set("source", "web");
  return href.toString();
}
