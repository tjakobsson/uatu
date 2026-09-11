import { expect, test } from "bun:test";

const evidence = new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/", import.meta.url);
const reports = [
  ["folder-picker/browser-results.json", 10],
  ["preview-refinement/browser-results.json", 20],
  ["preview-refinement/boundary-results.json", 4],
  ["navigation-recovery/browser-results.json", 48],
  ["navigation-recovery/boundary-results.json", 4],
  ["navigation-recovery/production-results.json", 9],
] as const;

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

test("retained browser reports use portable paths without changing recorded outcomes", async () => {
  for (const [path, expected] of reports) {
    const report = await Bun.file(new URL(path, evidence)).json();
    expect(report.config.configFile.startsWith("<REPO_ROOT>/")).toBe(true);
    expect(report.config.rootDir.startsWith("<REPO_ROOT>/")).toBe(true);
    // Inspect all string fields, including command/config and attachment paths.
    // Fixture values below describe path shapes, never a real user's identity.
    const privatePath = /\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\Users\\/;
    expect(strings(report).some(value => privatePath.test(value))).toBe(false);
    expect(report.stats.expected).toBe(expected);
    expect(report.stats.unexpected).toBe(0);
    expect(report.stats.flaky).toBe(0);
    expect(report.stats.skipped).toBe(0);
    expect(report.suites.length).toBeGreaterThan(0);
  }
});

test("public access documentation does not contain concrete tailnet addresses", async () => {
  const paths = ["acceptance.md", "handoff.md", "ios-ux-correction.md", "navigation-recovery/verification.md", "page-based-settings.md", "preview-refinement/verification.md", "readability-update.md", "scenario-guide.md", "settings-refinement.md"];
  for (const path of paths) {
    const text = await Bun.file(new URL(path, evidence)).text();
    expect(/[a-z0-9*-]+\.[a-z0-9-]+\.ts\.net/i.test(text)).toBe(false);
  }
  expect(/[a-z0-9*-]+\.[a-z0-9-]+\.ts\.net/i.test(await Bun.file(new URL("./hosting.md", import.meta.url)).text())).toBe(false);
});
