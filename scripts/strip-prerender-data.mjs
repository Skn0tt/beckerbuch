#!/usr/bin/env node
/**
 * React Router prerender writes both HTML and `.data` payloads. The HTML
 * shells are what we want on the CDN (instant first paint). The `.data`
 * files bake `shell: true` forever — if left in `build/client`, client
 * revalidations / soft navigations would keep serving the empty shell
 * instead of hitting the Netlify Function with the session cookie.
 *
 * Strip those `.data` files so document requests still get static HTML
 * while loader revalidation always reaches the runtime server.
 */
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

const clientDir = path.resolve("build/client");

async function stripDataFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await stripDataFiles(full);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".data")) {
        await unlink(full);
        console.log(`stripped prerender data: ${path.relative(process.cwd(), full)}`);
      }
    }),
  );
}

await stripDataFiles(clientDir);
