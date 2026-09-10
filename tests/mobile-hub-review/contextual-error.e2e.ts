import { expect, test, type Locator } from "@playwright/test";

async function insideScrollOwner(alert: Locator) {
  await expect(alert).not.toBeEmpty();
  expect(await alert.evaluate(el => {
    const error = el.getBoundingClientRect();
    const pane = el.closest(".mh-sheet-body, .mh-flow-content")!.getBoundingClientRect();
    return error.top >= pane.top - 1 && error.bottom <= pane.bottom + 1;
  })).toBe(true);
}
test.beforeEach(async ({ request }) => { await request.post("/review/reset", { data: { scenario: "mixed" } }); });

test("Settings catalog retry completes while typing without stealing native focus or resetting other reads", async ({ page }) => {
  let catalogs = 0, workspaces = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  page.on("request", request => { if (request.url().endsWith("/readWorkspaces")) workspaces++; });
  await page.route("**/review/backend/readCredentials", async route => {
    if (++catalogs === 1) { await route.fulfill({ json: { status: "unavailable", problem: { kind: "unavailable", message: "Catalog offline. Please retry." } } }); return; }
    const response = await route.fetch(); await held; await route.fulfill({ response });
  });
  await page.goto("/settings");
  await page.locator('[data-action="retry-credentials"]').click();
  const initialReads = workspaces;
  await page.locator('.mh-overview-toolbar [data-action="add-credential"]').click();
  await page.locator('[data-flow="token"]').click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Live draft"); release();
  await expect(page.locator("[data-credential-catalog] [data-credential-id]").first()).toBeAttached();
  await expect(name).toBeFocused();
  await page.keyboard.type(" continued");
  await expect(name).toHaveValue("Live draft continued");
  expect(workspaces).toBe(initialReads); expect(catalogs).toBe(2);
});

test("long import validation reveals its existing alert and preserves native keyboard input", async ({ page }) => {
  await page.goto("/settings?detail=add-credential");
  await page.locator('[data-flow="ssh"]').click();
  await page.locator('[data-flow="ssh-import"]').click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Preserved key name");
  await page.locator(".mh-sheet-error").evaluate(el => { const spacer = document.createElement("div"); spacer.style.height = "1000px"; el.before(spacer); });
  // Enter submits without transferring focus to the lower command.
  await name.press("Enter");
  await insideScrollOwner(page.locator(".mh-sheet-error"));
  await expect(name).toHaveValue("Preserved key name");
  await expect(name).toBeFocused();
  await expect(page.locator('.mh-sheet [role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Import", exact: true })).toHaveCount(1);
  await page.keyboard.type(" continued");
  await expect(name).toHaveValue("Preserved key name continued");
});

test("long Clone Review validation is visible without replacing its draft", async ({ page }) => {
  await page.goto("/?detail=clone");
  const name = page.getByLabel("Workspace display name");
  await name.fill("Clone draft");
  await page.locator(".mh-flow-error").evaluate(el => { const spacer = document.createElement("div"); spacer.style.height = "1000px"; el.before(spacer); });
  await page.locator('[data-flow="review"]').click();
  await insideScrollOwner(page.locator(".mh-flow-error"));
  await expect(name).toHaveValue("Clone draft");
  await expect(page.locator('.mh-flow-page [role="alert"]')).toHaveCount(1);
  await expect(page.locator('[data-flow="review"]')).toHaveCount(1);
});
