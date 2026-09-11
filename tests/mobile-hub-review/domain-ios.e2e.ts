import { expect, test, type Page } from "@playwright/test";
import { activeTask, settingsCommand } from './navigation';

const flow = (page: Page, key: string) => page.locator(`[data-flow="${key}"]`);
async function lower(page: Page, key: string) {
  const target = flow(page, key);
  await expect(target).toHaveCount(1);
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(page.viewportSize()!.height / 2);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}
test.beforeEach(async ({ request }) => { expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true); });

test("compact folder hierarchy has one command home and contextual management", async ({ page }) => {
  await page.goto("/?detail=add-workspace"); await flow(page, "existing").click();
  await expect(flow(page, "folder-0")).toBeVisible();
  const rows = page.locator(".mh-flow-page .mh-list-row");
  expect(await rows.count()).toBeGreaterThan(1);
  for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(88);
  await expect(page.getByRole("button", { name: "Browse folder", exact: true })).toHaveCount(0);
  await settingsCommand(page, "choose");
  await flow(page, "more-0").click(); await expect(activeTask(page)).toBeVisible();
  await expect(flow(page, "rename")).toBeVisible(); await expect(flow(page, "remove")).toBeVisible();
  await page.keyboard.press("Escape");
  await flow(page, "create").click();
  await page.getByRole("button", { name: "Create folder", exact: true }).click();
  await expect(page.locator(".mh-sheet-error")).not.toBeEmpty();
});

test("assignment and device lists disclose named secondary operations", async ({ page }) => {
  await page.goto("/settings?detail=assignments"); await flow(page, "workspace-atlas").click();
  await settingsCommand(page, "edit-atlas"); await flow(page, "new-atlas").click();
  await expect(page.getByRole('combobox', { name: 'Signing', exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Git authentication credential", exact: true }).selectOption("token-github");
  await page.getByLabel("Authentication host").fill("github.com");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to edit", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to edit", exact: true }).click();
  await expect(page.getByLabel("Authentication host")).toHaveValue("github.com");
  await page.goto("/settings?detail=devices"); await flow(page, "device-0").click();
  await expect(flow(page, 'more')).toHaveCount(0);
  await settingsCommand(page, 'revoke-0'); await flow(page, "revoke-0").click();
  await expect(activeTask(page, 'confirmation')).toContainText("does not stop workspaces");
});

test("clone review has one lower primary and one draft-preserving cancellation", async ({ page }) => {
  await page.goto("/?detail=clone"); await expect(flow(page, "review")).toBeVisible(); await settingsCommand(page, "review");
  await page.getByLabel("Remote URL", { exact: true }).fill("https://github.com/example/repo.git");
  await page.getByLabel("Checkout folder name").fill("checkout"); await page.getByLabel("Workspace display name").fill("Checkout");
  await flow(page, "review").click();
  await expect(page.getByRole("button", { name: "Back to edit", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape"); await expect(page.getByLabel("Checkout folder name")).toHaveValue("checkout");
  await settingsCommand(page, "review");
});

test("clone prompt and authoritative recovery retain distinct lower command homes", async ({ page, request }) => {
  await page.goto("/clone");
  await page.getByLabel("Remote URL", { exact: true }).fill("https://github.com/example/repo.git");
  await page.getByLabel("Checkout folder name").fill("checkout"); await page.getByLabel("Workspace display name").fill("Checkout");
  await flow(page, "review").click(); await page.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
  const id = (await (await request.get("/review/state")).json()).model.jobs[0].id;
  await request.post("/review/control/cloneOutput", { data: [id, "prompt"] });
  await expect(flow(page, "send")).toBeEnabled(); await lower(page, "send");
  await page.setViewportSize({ width: 390, height: 440 });
  await page.getByLabel("Response to any remote prompt (always masked)").fill("DISPOSABLE");
  await lower(page, "send"); await flow(page, "send").click();
  await expect(page.getByLabel("Response to any remote prompt (always masked)")).toHaveValue("");
  await request.post("/review/control/finishClone", { data: [id, "register-failed"] });
  await expect(page.locator("[data-clone-status]")).toContainText("could not be registered");
  await settingsCommand(page, "folder"); await expect(flow(page, "send")).toHaveCount(0);
  await expect(flow(page, "edit")).toBeVisible();
});
