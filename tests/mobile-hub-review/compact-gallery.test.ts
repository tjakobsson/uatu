import { expect, test } from "bun:test";
import { galleryImages, galleryScenes, galleryViewport } from "./compact-gallery";
import { buildEvidenceAssets, evidenceSelection } from "./hosting-evidence";

test("compact gallery is exactly ten named scenes in two engines at the documented size", async () => {
  expect(galleryScenes).toHaveLength(10);
  expect(galleryImages).toHaveLength(20);
  expect(new Set(galleryImages.map(image => image.path)).size).toBe(20);
  for (const image of galleryImages) {
    expect(image.path).toMatch(/^gallery\/(chromium|webkit)-[a-z-]+\.png$/);
    const bytes = Buffer.from(await Bun.file(new URL(`../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/${image.path}`, import.meta.url)).arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.readUInt32BE(16)).toBe(galleryViewport.width * galleryViewport.deviceScaleFactor);
    expect(bytes.readUInt32BE(20)).toBe(galleryViewport.height * galleryViewport.deviceScaleFactor);
  }
});

test("publisher renders only the compact selection and keeps approval boundaries explicit", async () => {
  const assets = await buildEvidenceAssets();
  expect(assets.size).toBe(evidenceSelection.length + 3);
  const html = assets.get("/review/evidence")!.body as string;
  expect((html.match(/<figure>/g) ?? [])).toHaveLength(20);
  expect(html).toContain("not approved goldens");
  expect(html).toContain("Awaiting user");
  for (const image of galleryImages) expect(html).toContain(`/review/evidence/${image.path}`);
  expect(html).not.toContain("visual/corrected/");
  expect(html).not.toContain("browser-results.json");
  expect(assets.get("/review/evidence/")!.body).toBe(html);
});
