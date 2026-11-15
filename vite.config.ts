import { reactRouter } from "@react-router/dev/vite";
import netlify from "@netlify/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [netlify(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
});
