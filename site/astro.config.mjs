import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { assembleEdgeArtifacts } from "../scripts/assemble-api-site.ts";
import { base } from "./base.mjs";

export default defineConfig({
  site: "https://tjakobsson.github.io",
  base,
  output: "static",
  outDir: "./dist",
  integrations: [
    {
      name: "uatu-edge-artifacts",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          // fileURLToPath, not dir.pathname: URL.pathname yields /C:/... on
          // Windows and breaks the assemble step.
          await assembleEdgeArtifacts(fileURLToPath(dir));
        },
      },
    },
  ],
});
