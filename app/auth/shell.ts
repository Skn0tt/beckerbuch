/**
 * Build-time prerender hits the app with no Cookie and COOKBOOK_PRERENDER=1
 * (set by the `build` script). Those requests must not redirect to /login or
 * touch the DB — they only exist so skeleton shells can be baked into the
 * CDN HTML.
 *
 * At runtime, cookieless document requests still redirect to login as usual
 * when they hit the function. Logged-in users who receive a CDN shell paint
 * the skeleton immediately, then `_app` fetches `/data/app` and revalidates
 * child loaders (waking a cold function while the shell is already on screen).
 */
export function isPrerenderShellRequest(request: Request): boolean {
  return (
    process.env.COOKBOOK_PRERENDER === "1" &&
    !request.headers.get("cookie")
  );
}
