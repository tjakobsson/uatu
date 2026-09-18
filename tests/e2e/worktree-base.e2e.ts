import { test, expect } from "./worktree-demo-fixtures";
import type { Page } from "@playwright/test";
import { captureScreenshot } from "./evidence";

async function open(page: Page, surface = "dashboard", touch = false) {
  await page.goto(surface === "dashboard" ? "/" : "/s/atlas/");
  if (surface === "selector") {
    if (touch) await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.locator("#hub-toggle").click();
  }
  await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
  await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
}

for (const touch of [false, true]) test.describe(touch ? "touch create from" : "desktop create from", () => {
  test.use({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch });
  for (const surface of ["dashboard", "selector"]) test(`${surface}: current checkout differs from main default and explicit base`, async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "non-main" } });
    await open(page, surface, touch);
    const dialog = page.getByRole("dialog"), base = dialog.getByRole("combobox", { name: "Create from", exact: true });
    const create = dialog.getByRole("button", { name: "Create", exact: true });
    await expect(base).toHaveValue("main"); await expect(create).toBeDisabled();
    await dialog.getByLabel("Name", { exact: true }).fill("feature/chosen");
    await expect(create).toBeEnabled();
    await base.click();
    await expect(dialog.getByRole("option", { name: "main Local", exact: true })).toBeVisible();
    await captureScreenshot(page, info, "create-from-expanded");
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(touch ? 390 : 1440);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(touch ? 844 : 1000);
    await dialog.getByRole("option", { name: "upstream/release Remote", exact: true }).click();
    await base.fill("upstream/release"); await expect(create).toBeDisabled();
    await base.press("ArrowDown"); await base.press("Enter");
    await expect(base).toHaveValue("upstream/release"); await expect(dialog).toBeVisible();
    await create.click(); await expect(dialog).toHaveCount(0);
    const ledger = await page.request.get("/__demo/ledger").then(r => r.json());
    expect(ledger.rows.at(-1)).toMatchObject({ sourceRef: "upstream/release", base: "upstream/release", running: false });
    await page.goto(surface === "dashboard" ? "/" : "/s/atlas/");
    if (surface === "selector") {
      if (touch) await page.getByRole("tab", { name: "Files", exact: true }).click();
      await page.locator("#hub-toggle").click();
      await expect(page.locator('[data-workspace-id="atlas"] .hub-menu-branch')).toHaveText("feature/current");
      await expect(page.locator('[data-workspace-id="atlas-created-1"] .hub-menu-provenance')).toHaveText("from upstream/release");
    } else {
      await expect(page.locator('[data-workspace="atlas"] .row-title')).toHaveText("feature/currentMain checkout");
      await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
      await expect(page.locator('[data-workspace="atlas-created-1"] .worktree-provenance')).toHaveText("from upstream/release");
    }
    await captureScreenshot(page, info, "current-branch-and-origin");
    // A fixture checkout update is live state, not a rewrite of branch history.
    await page.route("**/api/hub/state", async route => {
      const response = await route.fetch(); const state = await response.json();
      state.workspaces.find((row: { id: string }) => row.id === "atlas").branch = "feature/foo";
      await route.fulfill({ response, json: state });
    });
    await page.reload();
    if (surface === "selector") {
      if (touch) await page.getByRole("tab", { name: "Files", exact: true }).click();
      await page.locator("#hub-toggle").click();
      await expect(page.locator('[data-workspace-id="atlas"] .hub-menu-branch')).toHaveText("feature/foo");
      await expect(page.locator('[data-workspace-id="atlas-created-1"] .hub-menu-provenance')).toHaveText("from upstream/release");
    } else {
      await expect(page.locator('[data-workspace="atlas"] .row-title')).toHaveText("feature/fooMain checkout");
      await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
      await expect(page.locator('[data-workspace="atlas-created-1"] .worktree-provenance')).toHaveText("from upstream/release");
    }
  });

  for (const [scenario, value] of [["remote-main", "origin/main"], ["ambiguous-main", ""], ["no-main", ""]]) test(`${scenario}: initial default only`, async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario: scenario! } }); await open(page);
    const base = page.getByRole("combobox", { name: "Create from", exact: true });
    await expect(base).toHaveValue(value!);
    await page.getByLabel("Name", { exact: true }).fill("feature/base");
    const create = page.getByRole("button", { name: "Create", exact: true });
    if (!value) await expect(create).toBeDisabled(); else await expect(create).toBeEnabled();
    await base.click(); await page.getByRole("option", { name: "release Local", exact: true }).click();
    await page.getByRole("button", { name: "Fetch remote branches", exact: true }).click();
    await expect(base).toHaveValue("release"); await expect(create).toBeEnabled();
    await create.click();
    expect((await page.request.get("/__demo/ledger").then(r => r.json())).rows.at(-1).sourceRef).toBe("release");
  });

  for (const scenario of ["stale", "fetch-auth", "fetch-network", "fetch-disappearance"]) test(`${scenario}: fetch retains name/query and never resets explicit base`, async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario, latency: "400" } }); await open(page);
    const base = page.getByRole("combobox", { name: "Create from", exact: true });
    const create = page.getByRole("button", { name: "Create", exact: true });
    await page.getByLabel("Name", { exact: true }).fill("feature/fetch");
    await base.click(); await page.getByRole("option", { name: "origin/feature/search Remote", exact: true }).click();
    await page.getByRole("button", { name: "Fetch remote branches", exact: true }).click();
    await expect(page.locator("#operation-status")).toContainText("Fetching"); await expect(create).toBeDisabled();
    await expect(page.locator("#operation-status")).toBeHidden();
    await expect(base).toHaveValue("origin/feature/search"); await expect(page.getByLabel("Name", { exact: true })).toHaveValue("feature/fetch");
    if (scenario === "fetch-disappearance") await expect(create).toBeDisabled(); else await expect(create).toBeEnabled();
    if (scenario !== "stale") await expect(page.getByRole("alert")).toBeVisible();
    await base.fill("rls"); await expect(create).toBeDisabled();
    await page.getByRole("button", { name: "Fetch remote branches", exact: true }).click();
    await expect(page.locator("#operation-status")).toBeHidden(); await expect(base).toHaveValue("rls"); await expect(create).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  for (const [scenario, label] of [["detached", "Detached HEAD"], ["unknown-branch", "Branch unknown"]]) test(`${scenario}: truthful on both surfaces`, async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario: scenario! } });
    await page.goto("/"); await expect(page.locator('[data-workspace="atlas"] .row-title')).toContainText(label!);
    await page.goto("/s/atlas/"); if (touch) await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.locator("#hub-toggle").click(); await expect(page.locator('[data-workspace-id="atlas"] .hub-menu-branch')).toHaveText(label!);
    await expect(page.locator('[data-workspace-id="atlas-review"] .hub-menu-provenance')).toHaveText("origin unknown");
  });
});
