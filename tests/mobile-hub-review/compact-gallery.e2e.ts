import { expect, test, type Page } from "@playwright/test";
import { galleryScenes, galleryEngines } from "./compact-gallery";
import { namedButton } from "./navigation";

test.beforeEach(async ({ request, baseURL }) => {
  expect(new URL(baseURL!).port).toBe("4732");
  expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true);
});

async function createEditor(page: Page) {
  await page.goto("/?detail=add-workspace");
  await namedButton(page, "Create workspace").click();
  await expect(page.getByRole("region", { name: "Create Workspace", exact: true })).toBeVisible();
  await expect(page.getByLabel("New folder name", { exact: true })).toHaveValue("");
}

for (const [scene, label] of galleryScenes) test(`compact gallery: ${label}`, async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  switch (scene) {
    case "hub":
      await page.goto("/");
      await expect(page.locator('[data-action="open:atlas"]')).toBeVisible();
      break;
    case "settings":
      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
      await expect(page.locator('[data-action^="credential:"]').first()).toBeVisible();
      await expect(page.locator('[data-action="devices"]')).toHaveCount(0);
      break;
    case "create-editor":
      await createEditor(page);
      await expect(page.getByRole("region", { name: "Create Workspace", exact: true }).locator("h1")).toBeFocused();
      break;
    case "creation-cancel":
      await createEditor(page);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Add Workspace", exact: true })).toBeVisible();
      await expect(page.getByText("Configure new workspace", { exact: true })).toHaveCount(0);
      break;
    case "security":
      await page.goto("/settings?detail=security");
      await expect(page.locator('[data-flow="devices"]')).toContainText("2 device sessions");
      await page.locator('[data-flow="devices"]').scrollIntoViewIfNeeded();
      break;
    case "devices":
      await page.goto("/settings?detail=devices");
      await expect(page.locator('[data-flow^="device-"]')).toHaveCount(2);
      await expect(page.getByRole("button", { name: "Back to Session Security", exact: true })).toBeVisible();
      break;
    case "folder-list":
    case "folder-empty":
      await page.goto("/settings?detail=default-folder");
      await page.locator('[data-flow="edit"]').click();
      await page.getByLabel("Folder path").fill(scene === "folder-empty" ? "/synthetic/atlas/examples/guides" : "/synthetic");
      await namedButton(page, "Choose folder").click();
      await expect(page.locator('.mh-folder-picker [data-action="commit-sheet"]')).toBeEnabled();
      if (scene === "folder-empty") await expect(page.getByRole("heading", { name: "No subfolders", exact: true })).toBeVisible();
      else await expect(page.locator(".mh-folder-list .mh-list-row").first()).toBeVisible();
      break;
    case "preview-markdown": {
      await page.goto("/s/atlas/examples/START-HERE.md");
      await expect(page.locator("#preview h1")).toHaveText("Preview field guide");
      const image = page.locator('#preview img[src$="coast.svg"]');
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
      break;
    }
    case "preview-siblings":
      await page.goto("/s/atlas/examples/operations/reference.adoc");
      await expect(page.locator("#preview h1")).toHaveText("Observation reference");
      await expect(page.getByRole("button", { name: "Previous file", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Next file", exact: true })).toBeEnabled();
      break;
  }
  await page.evaluate(() => document.fonts.ready);
  expect(errors).toEqual([]);
  expect((await (await request.get("/review/state")).json()).log).toEqual([]);
  const health = await (await request.get("/review/health")).json();
  await info.attach("capture-context", { body: JSON.stringify({ scene, engine: info.project.name, frontend: health.version.fingerprint, synthetic: true }), contentType: "application/json" });
  expect(galleryEngines.includes(info.project.name as typeof galleryEngines[number])).toBe(true);
  const filename = `${info.project.name}-${scene}.png`;
  // Only an explicit promotion invocation writes the fixed 20 names to the
  // curated tree. Normal test/capture runs stay in ignored local output.
  const path = process.env.UATU_PROMOTE_COMPACT_GALLERY === "1"
    ? new URL(`../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/gallery/${filename}`, import.meta.url).pathname
    : info.outputPath(filename);
  await page.screenshot({ path });
});
