import { reactRouter } from "@react-router/dev/vite";
import netlifyReactRouter from "@netlify/vite-plugin-react-router";
import netlify from "@netlify/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [netlify(), reactRouter(), netlifyReactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
});
