import { expect, test } from "@playwright/test";
import { activeTask, namedButton } from "./navigation";

test.beforeEach(async ({ request }) => { await request.post("/review/reset", { data: { scenario: "mixed" } }); });

for (const dismissal of ["Cancel", "browser Back"] as const) test(`creation ${dismissal} returns to Add Workspace; Forward never replays a draft`, async ({ page, request }) => {
  await page.goto("/"); await page.locator('[data-action="add-workspace"]').click();
  await namedButton(page, "Create workspace").click();
  await page.getByLabel("New folder name", { exact: true }).fill("abandoned-draft");
  if (dismissal === "Cancel") {
    const popped = page.evaluate(() => new Promise(resolve => window.addEventListener("popstate", () => resolve(true), { once: true })));
    await activeTask(page, "editor", "Create Workspace").getByRole("button", { name: "Cancel", exact: true }).click(); await popped;
  }
  else await page.goBack();
  await expect(page.getByRole("heading", { name: "Add Workspace", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!history.state?.mobileHub?.task)).toBe(false);
  await expect(page).toHaveURL(/\/\?detail=add-workspace$/);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Add Workspace", exact: true })).toBeVisible();
  await expect(page.locator(".mh-task")).toHaveCount(0);
  await expect(page.getByText("Configure new workspace", { exact: true })).toHaveCount(0);
  expect((await (await request.get("/review/state")).json()).log).toEqual([]);
});

for (const nested of ["picker", "review"] as const) for (const dismissal of ["visible", "history"] as const) test(`${nested} ${dismissal} Back preserves the creation draft and its final exit`, async ({ page, request }) => {
  await page.goto("/"); await page.locator('[data-action="add-workspace"]').click();
  await namedButton(page, "Create workspace").click();
  await page.getByLabel("Parent folder", { exact: true }).fill("/synthetic");
  await page.getByLabel("New folder name", { exact: true }).fill("draft-folder");
  await page.getByLabel("Workspace display name", { exact: true }).fill("Draft workspace");
  await page.getByLabel("Create the folder and initialize Git", { exact: true }).check();
  if (nested === "picker") { await namedButton(page, "Browse elsewhere").click(); await expect(activeTask(page, "editor", "Choose Folder")).toBeVisible(); }
  else { await page.getByRole("button", { name: "Review", exact: true }).click(); await expect(activeTask(page, "editor", "Review Create Workspace")).toBeVisible(); }
  if (dismissal === "history") await page.goBack();
  else await activeTask(page).getByRole("button", { name: nested === "picker" ? "Cancel" : "Back to edit", exact: true }).click();
  await expect(page.getByLabel("New folder name", { exact: true })).toHaveValue("draft-folder");
  await expect(page.getByLabel("Workspace display name", { exact: true })).toHaveValue("Draft workspace");
  await expect(page.getByLabel("Parent folder", { exact: true })).toHaveValue("/synthetic");
  await expect(page.getByLabel("Create the folder and initialize Git", { exact: true })).toBeChecked();
  await expect.poll(() => page.evaluate(() => !!history.state?.mobileHub?.task)).toBe(true);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Add Workspace", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/\?detail=add-workspace$/);
  await page.goForward(); await expect(page.locator(".mh-task")).toHaveCount(0);
  expect((await (await request.get("/review/state")).json()).log).toEqual([]);
});

for (const dismissal of ["Cancel", "browser Back"] as const) test(`loading creation ${dismissal} invalidates a late response`, async ({ page, request }) => {
  await page.goto("/?detail=add-workspace"); await expect(namedButton(page, "Create workspace")).toBeVisible();
  let release!: () => void, arrived = false, finished = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/review/backend/readDefaultFolder", async route => {
    const response = await route.fetch(); arrived = true; await gate; await route.fulfill({ response }); finished = true;
  });
  await namedButton(page, "Create workspace").click(); await expect.poll(() => arrived).toBe(true);
  await expect(activeTask(page)).toContainText("Loading default folder and credentials");
  if (dismissal === "Cancel") {
    const popped = page.evaluate(() => new Promise(resolve => window.addEventListener("popstate", () => resolve(true), { once: true })));
    await activeTask(page).getByRole("button", { name: "Cancel", exact: true }).click(); await popped;
  }
  else await page.goBack();
  await expect(page.getByRole("heading", { name: "Add Workspace", exact: true })).toBeVisible();
  release(); await expect.poll(() => finished).toBe(true);
  // Allow the released client continuation to run before checking absence.
  await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  await expect(page.locator(".mh-task")).toHaveCount(0);
  await expect(page).toHaveURL(/\/\?detail=add-workspace$/);
  await page.goForward(); await expect(page.locator(".mh-task")).toHaveCount(0);
  expect((await (await request.get("/review/state")).json()).log).toEqual([]);
});

test("Devices has one Security entry, truthful count, safe direct routes and contextual Back without mutations", async ({ page, request }, info) => {
  await page.goto("/settings");
  await expect(page.locator('[data-action="devices"]')).toHaveCount(0);
  await page.locator('[data-action="security"]').click();
  const devices = page.locator('[data-flow="devices"]');
  await expect(devices).toHaveCount(1);
  const state = await (await request.get("/review/state")).json();
  await expect(devices).toContainText(`${state.model.devices.length} device session`);
  await devices.scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL(`./results/artifacts/navigation-recovery/${info.project.name}-security.png`, import.meta.url).pathname });
  await devices.click(); await expect(page).toHaveURL(/\/settings\?detail=devices$/);
  await page.screenshot({ path: new URL(`./results/artifacts/navigation-recovery/${info.project.name}-devices.png`, import.meta.url).pathname });
  await page.goBack(); await expect(page).toHaveURL(/\/settings\?detail=security$/);
  await expect(page.getByRole("heading", { name: "Session Security", exact: true })).toBeVisible();
  await page.goForward(); await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to Session Security", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?detail=security$/);
  await expect(devices).toHaveCount(1);
  await page.goto("/settings?detail=devices");
  await page.locator('[data-flow^="device-"]').first().click();
  await expect(activeTask(page, "confirmation", "Revoke session?")).toBeVisible();
  const revokedBack = page.evaluate(() => new Promise(resolve => window.addEventListener("popstate", () => resolve(true), { once: true })));
  await activeTask(page, "confirmation", "Revoke session?").getByRole("button", { name: "Cancel", exact: true }).click(); await revokedBack;
  await page.getByRole("button", { name: "Back to Session Security", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?detail=security$/);
  await expect(page.locator('[data-flow="signout"]')).toHaveCount(1);
  await page.locator('[data-flow="signout"]').click();
  await expect(activeTask(page, "confirmation", "Sign out?")).toBeVisible();
  const signedBack = page.evaluate(() => new Promise(resolve => window.addEventListener("popstate", () => resolve(true), { once: true })));
  await activeTask(page, "confirmation", "Sign out?").getByRole("button", { name: "Cancel", exact: true }).click(); await signedBack;
  await expect(devices).toHaveCount(1);
  expect((await (await request.get("/review/state")).json()).log).toEqual([]);
});
