// Environment control: identical strict tests, full Chromium rather than headless shell.
import { defineConfig } from "@playwright/test";
import regression from "./transition-regression.config";

export default defineConfig(regression, {
  outputDir: "./evidence/transition-full-chromium-results",
  projects: [{ name: "chromium", use: { browserName: "chromium", channel: "chromium", headless: true } }],
});
