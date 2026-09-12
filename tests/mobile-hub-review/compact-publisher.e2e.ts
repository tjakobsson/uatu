import { expect, test } from "@playwright/test";

test("compact publisher renders twenty real images and excludes raw/history paths", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/review/evidence");
  await expect(page.getByRole("heading", { name: "Current synthetic UI review" })).toBeVisible();
  await expect(page.locator("figure img")).toHaveCount(20);
  for (const image of await page.locator("figure img").all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 780 && el.naturalHeight === 1688)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const manifest = await (await request.get("/review/evidence/manifest.json")).json();
  expect(manifest.files).toHaveLength(22);
  expect(manifest.selection).toBe("compact-current-review-v1");
  const record = await request.get("/review/evidence/verification.md");
  expect(record.headers()["content-type"]).toContain("text/plain");
  for (const path of ["baseline.json", "visual/corrected/index.html", "navigation-recovery/browser-results.json", "../../tests/mobile-hub-review/results/artifacts/compact-gallery/results.json"]) {
    expect((await request.get(`/review/evidence/${path}`)).status()).toBeGreaterThanOrEqual(400);
  }
  expect(errors).toEqual([]);
});
