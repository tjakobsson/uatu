import { defineConfig } from "astro/config";
import { assembleEdgeArtifacts } from "../scripts/assemble-api-site.ts";

export default defineConfig({
  site: "https://tjakobsson.github.io",
  base: "/uatu",
  output: "static",
  outDir: "./dist",
  integrations: [
    {
      name: "uatu-edge-artifacts",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          await assembleEdgeArtifacts(dir.pathname);
        },
      },
    },
  ],
});
