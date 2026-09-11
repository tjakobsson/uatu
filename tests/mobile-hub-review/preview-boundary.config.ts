import { defineConfig } from "@playwright/test";
import refinement from "./preview-refinement.config";

export default defineConfig({
  ...refinement,
  testMatch: ["continuity.e2e.ts"],
  grep: /one actual workspace survives|Chat retains draft and exact uploading File/,
  outputDir: "./evidence/preview-boundary-results",
  reporter: [["list"], ["json", { outputFile: new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/preview-refinement/boundary-results.json", import.meta.url).pathname }]],
});
