import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: ["hub-mobile-navigation.e2e.ts", "hub-mobile-forms.e2e.ts", "hub-mobile-lifecycle.e2e.ts"],
  workers: 1,
  projects: [
    { name: "hub-chromium", use: { browserName: "chromium" } },
    { name: "hub-webkit", use: { browserName: "webkit" } },
  ],
});
