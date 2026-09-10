import { expect, test, type Page } from "@playwright/test";
import { activeTask } from './navigation';

async function hub(page: Page) {
  await expect.poll(() => page.locator("#mobile-workspace-root").evaluate(el => el.getBoundingClientRect().x)).toBe(0);
  if (await page.locator("#navigation-handle").isVisible()) await page.locator("#navigation-handle").click();
  await page.locator("#navigation-hub").click();
  await expect(page.locator("#mobile-hub-root h1")).toHaveText("Workspaces");
}
const mark = (page: Page) => page.evaluate(() => { (window as any).documentMarker = document; (window as any).stateMarker = window.__mobileHubReview!.state; });
const retained = (page: Page) => page.evaluate(() => (window as any).documentMarker === document && (window as any).stateMarker === window.__mobileHubReview?.state);
test.beforeEach(async ({ request }) => { await request.post("/review/reset", { data: { scenario: "mixed" } }); });

test("A Hub Return retains document; Open B replaces it and B Return/reload use B context", async ({ page, request }) => {
  await request.post("/review/backend/startWorkspace", { data: [{ workspaceId: "notes", unassigned: "confirmed-without-credentials" }] });
  await page.goto("/s/atlas/");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await expect.poll(() => page.locator("#mobile-workspace-root").evaluate(el => el.getBoundingClientRect().x)).toBe(0);
  await page.locator('[data-tab="chat"]').click();
  await page.getByRole("textbox", { name: "Message Synthetic agent" }).fill("Atlas-only unsent intent");
  await mark(page);
  await hub(page);
  await page.locator('[data-action="return"]').click();
  expect(await retained(page)).toBe(true);
  await hub(page);
  await expect(page.locator('[data-action="open:notes"]')).toBeVisible();
  await page.locator('[data-action="open:notes"]').click();
  await expect(page).toHaveURL(/\/s\/notes\/README.md$/);
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  expect(await retained(page)).toBe(false);
  expect(await page.evaluate(() => window.__mobileHubReview?.bootCount)).toBe(1);
  await expect.poll(() => page.locator("#mobile-workspace-root").evaluate(el => el.getBoundingClientRect().x)).toBe(0);
  await page.locator('[data-tab="chat"]').click();
  await expect(page.getByRole("textbox", { name: "Message Synthetic agent" })).toHaveValue("");
  await mark(page);
  await hub(page);
  await expect(page.locator('[data-action="return"]')).toContainText("Notes");
  await page.locator('[data-action="return"]').click();
  expect(await retained(page)).toBe(true);
  await expect(page).toHaveURL(/\/s\/notes\/README.md$/);
  await page.reload();
  await expect.poll(() => page.locator("#mobile-workspace-root").evaluate(el => el.getBoundingClientRect().x)).toBe(0);
  await page.locator('[data-tab="preview"]').click();
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  expect(await retained(page)).toBe(false);
  expect(await page.locator('meta[name="uatu-review-workspace"]').getAttribute("content")).toBe("notes");
  expect((await (await request.get("/review/state")).json()).missing).toEqual([]);
});

test("stopped and missing canonical entries recover without Start; newly registered workspace opens normally", async ({ page, request }) => {
  for (const id of ["notes", "unregistered"]) {
    await page.goto(`/s/${id}/`);
    await expect(page.locator("#mobile-hub-root h1")).toHaveText("Workspaces");
    expect(await page.evaluate(() => window.__mobileHubReview)).toBeUndefined();
  }
  const before = await (await request.get("/review/state")).json();
  expect(before.log.filter((entry: { method: string }) => entry.method === "startWorkspace")).toHaveLength(0);
  await request.post("/review/backend/createWorkspace", { data: [{ parent: "/synthetic", folderName: "fresh", displayName: "Fresh", authentication: [], signing: null, start: false, gitInitConsent: "confirmed" }] });
  const state = await (await request.get("/review/state")).json();
  const id = state.model.workspaces.find((w: { displayName: string }) => w.displayName === "Fresh").id;
  await page.goto("/");
  await page.locator(`[data-action="start:${id}"]`).click();
  await activeTask(page, 'confirmation').getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  expect(await page.locator('meta[name="uatu-review-workspace"]').getAttribute("content")).toBe(id);
  expect((await request.patch("/s/atlas/api/personal-state", { data: { follow: false } })).ok()).toBe(true);
  expect(await (await request.get("/s/atlas/api/personal-state")).json()).toHaveProperty("follow", false);
  expect(await (await request.get(`/s/${id}/api/personal-state`)).json()).not.toHaveProperty("follow", false);
});
