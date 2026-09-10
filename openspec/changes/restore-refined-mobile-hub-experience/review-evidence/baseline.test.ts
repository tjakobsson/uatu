import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { approved } from "./baseline";

test("inventory excludes private and unrelated roots without reading them", () => {
  for (const path of [".local/session.json", "fix-chat-send-button/file", "src/../.local/secret", "src/.env", "docs/key.pem", "src/node_modules/pkg/index.ts", "/etc/passwd"])
    expect(approved(path)).toBe(false);
  for (const path of ["src/hub/pages.ts", "design/hub-mobile/refined.html", "openspec/changes/archive/2026-09-09-refine-mobile-hub-navigation/tasks.md"])
    expect(approved(path)).toBe(true);
});

test("all 49 measured images have exactly one state-index row", () => {
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
  const index = readFileSync(new URL("./index.md", import.meta.url), "utf8");
  expect(baseline.images).toHaveLength(49);
  expect(new Set(baseline.images.map((row: any[]) => row[0])).size).toBe(49);
  for (const [path, width, height] of baseline.images) {
    const name = path.split("/").pop();
    const rows = index.split("\n").filter(line => line.startsWith(`| \`${name}\` |`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`| ${width}×${height} |`);
    const normalization: Record<string, string> = {
      "780×1688": "390×844 / 2",
      "640×1480": "320×740 / 2",
      "1688×780": "844×390 / 2",
      "390×844": "390×844 / 1",
      "320×740": "320×740 / 1",
      "844×390": "844×390 / 1",
    };
    const expected = name.includes("interior") ? "crop" : normalization[`${width}×${height}`];
    expect(expected).toBeDefined();
    expect(rows[0]).toContain(`| ${expected} |`);
  }
});

test("baseline distinguishes original work from task evidence", () => {
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
  expect(baseline.status).toHaveLength(94);
  expect(baseline.status.filter((s: string) => s.startsWith(" M "))).toHaveLength(52);
  expect(baseline.status.filter((s: string) => s.startsWith(" D "))).toHaveLength(13);
  expect(baseline.status.filter((s: string) => s.startsWith("?? "))).toHaveLength(29);
  expect(baseline.status.some((s: string) => s.includes("review-evidence/"))).toBe(false);
  expect(baseline.groups.references.files).toBe(52);
  expect(baseline.groups.retainedArchive.files).toBe(25);
});
