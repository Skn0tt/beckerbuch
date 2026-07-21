import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Bake skeleton shells into the CDN publish dir so a cold Netlify
  // Function isn't on the critical path for first paint. Matched loaders
  // return a no-Cookie "shell" payload at build time; after hydrate, `_app`
  // fetches `/data/app` and revalidates for real data.
  prerender: ["/", "/login", "/kitchen"],
} satisfies Config;
