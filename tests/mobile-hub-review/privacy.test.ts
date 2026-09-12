import { expect, test } from "bun:test";
import { buildEvidenceAssets, evidenceSelection } from "./hosting-evidence";

const evidence = new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/", import.meta.url);
test("compact public package contains no raw browser reports or personal path metadata", async () => {
  const assets = await buildEvidenceAssets();
  expect(evidenceSelection.filter(path => path.endsWith(".png"))).toHaveLength(20);
  expect(evidenceSelection.filter(path => !path.endsWith(".png"))).toEqual(["README.md", "verification.md"]);
  for (const [path, asset] of assets) {
    expect(path).not.toMatch(/browser-results|boundary-results|production-results|history\//);
    if (asset.type === "image/png") continue;
    const text = typeof asset.body === "string" ? asset.body : await asset.body.text();
    expect(/\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\Users\\/.test(text)).toBe(false);
    expect(/[a-z0-9*-]+\.[a-z0-9-]+\.ts\.net/i.test(text)).toBe(false);
  }
  const manifest = JSON.parse(assets.get("/review/evidence/manifest.json")!.body as string);
  expect(manifest.files).toHaveLength(22);
  expect(manifest.files.every((file: { path: string }) => evidenceSelection.includes(file.path))).toBe(true);
});

test("public access documentation does not contain concrete tailnet addresses", async () => {
  const paths = ["acceptance.md", "handoff.md", "ios-ux-correction.md", "navigation-recovery/verification.md", "page-based-settings.md", "preview-refinement/verification.md", "readability-update.md", "scenario-guide.md", "settings-refinement.md"];
  for (const path of paths) {
    const text = await Bun.file(new URL(path, evidence)).text();
    expect(/[a-z0-9*-]+\.[a-z0-9-]+\.ts\.net/i.test(text)).toBe(false);
  }
  expect(/[a-z0-9*-]+\.[a-z0-9-]+\.ts\.net/i.test(await Bun.file(new URL("./hosting.md", import.meta.url)).text())).toBe(false);
});
