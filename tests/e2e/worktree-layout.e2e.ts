import { test, expect } from "./worktree-demo-fixtures";
import { captureScreenshot } from "./evidence";

for (const touch of [false, true]) test.describe(touch ? "touch Active groups" : "desktop Active groups", () => {
  test.use({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch });
  test("same state, independent lifecycles, retained layout and keyboard disclosures", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "mixed-lifecycle" } });
    await page.goto("/");
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const atlas = page.locator('[data-repository="atlas"]');
    const main = page.locator('[data-workspace="atlas"]');
    const child = page.locator('[data-workspace="atlas-sidebar"]');
    await expect(page.locator('#sessions [data-repository="atlas"]')).toBeVisible();
    await expect(main).toContainText("Main checkout");
    await expect(main.getByRole("button", { name: "Start Atlas", exact: true })).toBeVisible();
    await expect(child.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    const folded = page.locator('[data-disclosure="beacon-inactive"]');
    await folded.locator("summary").first().focus(); await page.keyboard.press("Enter");
    await expect(folded).toHaveAttribute("open", "");
    await page.keyboard.press("Enter"); await expect(folded).not.toHaveAttribute("open", "");
    const before = await page.request.get("/__demo/ledger").then(r => r.json());
    await captureScreenshot(page, info, "active-groups-mixed-lifecycle");
    await page.goto("/?layout=running-shortcuts");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("combobox", { name: "Demo layout", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
    await expect(atlas).toBeVisible();
    expect((await page.request.get("/__demo/ledger").then(r => r.json())).rows).toEqual(before.rows);
    await page.reload(); await expect(page.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
    // Start through the real row, then return: parent is not a runtime prerequisite.
    await page.request.post("/api/hub/sessions/atlas/start"); await page.reload();
    page.on("dialog", dialog => dialog.accept());
    await main.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(main.getByRole("button", { name: "Start Atlas", exact: true })).toBeVisible();
    await expect(child.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await child.getByRole("button", { name: "Stop", exact: true }).click();
    await page.locator('[data-disclosure="atlas-inactive"] > summary').click();
    await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
    await expect(child.getByRole("button", { name: "Start feature/sidebar", exact: true })).toBeVisible();
    await child.getByRole("button", { name: "Start feature/sidebar", exact: true }).click();
    await page.waitForURL(/\/s\/atlas-sidebar\//);
    await page.goto("/"); await expect(page.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "Start Atlas", exact: true })).toBeVisible();
    await expect(page.locator('#sessions [data-repository="atlas"]')).toBeVisible();
    await child.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator('[data-disclosure="atlas-inactive"]')).toBeVisible();
    await expect(page.locator('#sessions [data-repository="atlas"]')).toHaveCount(0);
    await captureScreenshot(page, info, "active-groups-all-stopped");
    await expect(page.locator("#sessions")).toContainText("No checkouts running");
    expect(errors).toEqual([]);
  });

  for (const entry of ["dashboard", "selector"]) for (const mode of ["local", "remote"]) test(`${entry}: initial ${mode} branch row click commits without typing`, async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.goto("/?layout=active-groups");
    if (entry === "selector") { await page.goto("/s/atlas/"); if (touch) await page.getByRole("tab", { name: "Files", exact: true }).click(); await page.locator("#hub-toggle").click(); }
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    const ref = mode === "local" ? "fix/navigation" : "origin/feature/search";
    await page.getByRole("option", { name: `${ref} ${mode === "local" ? "Local" : "Remote"}`, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Branch", exact: true })).toHaveValue(ref);
    await expect(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-worktree-confirmation]")).toContainText(`Created ${ref.replace(/^origin\//, "")}`);
    if (entry === "dashboard") await expect(page.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
  });

  test("create/delete preserve Active groups and classification", async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario: "mixed-lifecycle" } });
    await page.goto("/");
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("feature/layout-check");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const created = page.locator('[data-workspace="atlas-created-1"]');
    {
      const disclosure = page.locator('[data-disclosure="atlas-stopped"]');
      await expect(disclosure.locator("summary")).toHaveText("2 stopped worktrees");
      await disclosure.locator("summary").focus(); await page.keyboard.press("Space");
    }
    await expect(created).toBeVisible();
    await created.getByRole("button", { name: "Delete worktree", exact: true }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(created).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^(Sessions|Workspaces)$/ })).toHaveCount(0);
    await expect(page.locator('#sessions [data-repository="atlas"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('#sessions [data-repository="atlas"]')).toBeVisible();
  });
});
