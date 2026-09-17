import { test, expect } from "./worktree-demo-fixtures";

for (const touch of [false, true]) test.describe(touch ? "touch UX review" : "desktop UX review", () => {
  test.use({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch, colorScheme: "dark" });

  test("fresh journey and keyboard focus after cancel", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "mixed-lifecycle" } });
    await page.goto("/");
    await page.screenshot({ path: info.outputPath("01-dashboard-dark.png"), fullPage: true });
    const fork = page.getByRole("button", { name: "Add worktree to Atlas", exact: true });
    await fork.click();
    await page.screenshot({ path: info.outputPath("02-fork-menu.png"), fullPage: true });
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("feature/ux-review");
    await page.screenshot({ path: info.outputPath("03-new-dialog.png"), fullPage: true });
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("04-created.png"), fullPage: true });
    const notice = page.locator("[data-worktree-confirmation]");
    if (touch) {
      const label = await notice.locator("span").first().boundingBox();
      expect.soft(label!.height).toBeLessThanOrEqual(40);
      const bounds = await notice.boundingBox();
      expect.soft(bounds!.x).toBeGreaterThanOrEqual(16);
      expect.soft(bounds!.x + bounds!.width).toBeLessThanOrEqual(374);
    }
    await expect(page).toHaveURL(/\/$/);
    await page.locator("[data-worktree-confirmation]").getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForURL(/\/s\/atlas-created-1\//);
    if (touch) await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.locator("#hub-toggle").click();
    await page.screenshot({ path: info.outputPath("05-created-workspace-selector.png"), fullPage: true });
    await page.getByRole("button", { name: "Add worktree to Beacon", exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    await expect(page.getByRole("option", { name: "origin/feature/search Remote", exact: true })).toBeVisible();
    await expect.soft(page.getByRole("dialog").getByRole("heading")).toHaveText("Existing branch · Beacon", { timeout: 1000 });
    await page.screenshot({ path: info.outputPath("06-other-parent-branches.png"), fullPage: true });
    await page.getByRole("option", { name: "origin/feature/search Remote", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Branch", exact: true })).toHaveValue("origin/feature/search");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("07-cancel-focus.png"), fullPage: true });
    // The selector is dismissed when launching the dialog, so its persistent
    // toggle is the remaining logical return point (not the now-hidden fork).
    await expect(page.locator("#hub-toggle")).toBeFocused({ timeout: 1000 });
  });

  test("dashboard disclosure and focus survive periodic refresh", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "mixed-lifecycle" } });
    await page.goto("/");
    const disclosure = page.locator('[data-disclosure="beacon-inactive"]');
    await disclosure.locator("summary").first().focus();
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(disclosure.locator("summary").first()).toBeFocused();
    await page.waitForTimeout(6200);
    await page.screenshot({ path: info.outputPath("refresh-disclosure.png"), fullPage: true });
    await expect.soft(disclosure).toHaveAttribute("open", "", { timeout: 1000 });
    await expect(disclosure.locator("summary").first()).toBeFocused({ timeout: 1000 });
  });

  test("focused stopped disclosure survives its count changing", async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario: "mixed-lifecycle" } });
    await page.goto("/");
    const summary = page.locator('[data-disclosure="atlas-stopped"] > summary');
    await summary.focus();
    await page.request.post("/worktrees/create", { form: { source: "atlas", mode: "new", selection: "local:main", branch: "feature/background-created" } });
    await expect(summary).toHaveText("2 stopped worktrees");
    await expect(summary).toBeFocused({ timeout: 1000 });
  });

  test("creation dialog keeps keyboard focus inside", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "mixed-lifecycle" } });
    await page.goto("/");
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("feature/tab-test");
    await page.getByRole("button", { name: "Cancel", exact: true }).focus();
    await page.keyboard.press("Tab");
    await page.screenshot({ path: info.outputPath("dialog-tab-focus.png"), fullPage: true });
    expect(await page.getByRole("dialog").evaluate(el => el.contains(document.activeElement))).toBe(true);
  });

  for (const entry of ["dashboard", "selector"]) test(`${entry}: first Cancel click dismisses the expanded existing-branch list`, async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.goto(entry === "dashboard" ? "/" : "/s/atlas/");
    if (entry === "selector") {
      if (touch) await page.getByRole("tab", { name: "Files", exact: true }).click();
      await page.locator("#hub-toggle").click();
    }
    await page.getByRole("button", { name: "Add worktree to Beacon", exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Branches", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 1000 });
  });

  test("first Create click works after reopening a committed branch list", async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.goto("/");
    await page.getByRole("button", { name: "Add worktree to Beacon", exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    await page.getByRole("option", { name: "fix/navigation Local", exact: true }).click();
    await page.getByRole("combobox", { name: "Branch", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Branches", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-worktree-confirmation]")).toContainText("Created fix/navigation");
  });

  test("fork menu supports keyboard arrow navigation", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "mixed-lifecycle" } });
    await page.goto("/");
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "New branch / worktree", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.screenshot({ path: info.outputPath("fork-arrow-navigation.png"), fullPage: true });
    await expect(page.getByRole("menuitem", { name: "Existing branch", exact: true })).toBeFocused({ timeout: 1000 });
  });

  test("refresh retains row action and scroll but leaves outside and modal focus alone", async ({ page }) => {
    test.setTimeout(40_000);
    await page.request.post("/__demo/reset", { form: { scenario: "mixed-lifecycle" } });
    await page.goto("/");
    const action = page.locator('[data-workspace="atlas-sidebar"]').getByRole("button", { name: "Stop", exact: true });
    await action.focus();
    const scroll = await page.evaluate(() => scrollY);
    await page.waitForTimeout(6200);
    await expect(action).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    const outside = page.getByRole("link", { name: "Settings", exact: true });
    await outside.focus();
    await page.waitForTimeout(6200);
    await expect(outside).toBeFocused();
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).focus();
    await page.waitForTimeout(6200);
    await expect(page.getByRole("menuitem", { name: "Existing branch", exact: true })).toBeFocused();
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("feature/still-editing");
    await page.waitForTimeout(6200);
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("feature/still-editing");
  });

  test("cross-parent long-name creation uses named target and readable safe toast", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.goto("/s/atlas/");
    if (touch) await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.locator("#hub-toggle").click();
    await page.getByRole("button", { name: "Add worktree to Beacon", exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading")).toHaveText("New branch / worktree · Beacon");
    const branch = "feature/long-branch-name-for-accessibility-and-layout-review";
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(branch);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/s\/atlas\//);
    const ledger = await page.request.get("/__demo/ledger").then(r => r.json());
    expect(ledger.rows.at(-1)).toMatchObject({ parentId: "beacon", branch, running: false });
    const notice = page.locator("[data-worktree-confirmation]");
    await expect(notice).toContainText(branch);
    const bounds = (await notice.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(16);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
    expect(bounds.height).toBeLessThanOrEqual(145);
    for (const button of await notice.getByRole("button").all()) {
      const b = (await button.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44);
    }
    if (touch) {
      const tab = (await page.getByRole("tab", { name: "Files", exact: true }).boundingBox())!;
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(tab.y);
    }
    await page.screenshot({ path: info.outputPath("long-branch-confirmation.png"), fullPage: true });
  });

  test("fresh dashboard deletion and retained-checkout recovery journeys", async ({ page }, info) => {
    test.setTimeout(60_000);
    for (const scenario of ["populated", "mixed-lifecycle", "dirty", "locked", "in-use", "stop-failure"]) {
      await page.goto("/");
      await page.request.post("/__demo/reset", { form: { scenario } });
      await page.reload();
      if (!["mixed-lifecycle", "stop-failure"].includes(scenario)) await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
      const child = page.locator('[data-workspace="atlas-sidebar"]');
      const trigger = child.getByRole("button", { name: "Delete worktree", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("Atlas / feature/sidebar");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(trigger).toBeFocused();
      await expect(child).toBeVisible();
      await trigger.click();
      if (["dirty", "locked", "in-use"].includes(scenario)) {
        await expect(dialog.getByRole("alert")).toBeVisible();
        await expect(dialog.getByRole("button", { name: /^(Delete|Stop and delete)$/ })).toHaveCount(0);
      } else {
        await dialog.getByRole("button", { name: scenario === "populated" ? "Delete" : "Stop and delete", exact: true }).click();
        if (scenario === "stop-failure") await expect(dialog.getByRole("alert")).toContainText(/retained/i);
        else { await expect(dialog).toHaveCount(0); await expect(child).toHaveCount(0); }
      }
      await page.screenshot({ path: info.outputPath(`delete-${scenario}.png`), fullPage: true });
      const ledger = await page.request.get("/__demo/ledger").then(r => r.json());
      const retained = !["populated", "mixed-lifecycle"].includes(scenario);
      expect(ledger.rows.some((r: { id: string }) => r.id === "atlas-sidebar")).toBe(retained);
      if (await dialog.count()) await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    for (const scenario of ["registration-failure", "start-failure"]) {
      await page.request.post("/__demo/reset", { form: { scenario } });
      await page.goto("/");
      await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
      await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("feature/recovery-review");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      if (scenario === "registration-failure") {
        await expect(page.getByRole("button", { name: "Retry registration", exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath("registration-retained.png"), fullPage: true });
        const before = await page.request.get("/__demo/ledger").then(r => r.json());
        await page.getByRole("button", { name: "Retry registration", exact: true }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const after = await page.request.get("/__demo/ledger").then(r => r.json());
        expect(after.rows.at(-1).checkout).toBe(before.rows.at(-1).checkout);
        expect(after.rows.length).toBe(before.rows.length);
      }
      await page.locator("[data-worktree-confirmation]").getByRole("button", { name: "Open", exact: true }).click();
      if (scenario === "start-failure") {
        await expect(page.getByRole("button", { name: "Retry Open", exact: true })).toBeVisible();
        await expect(page).toHaveURL(/\/$/);
        await page.screenshot({ path: info.outputPath("start-retry.png"), fullPage: true });
        await page.getByRole("button", { name: "Retry Open", exact: true }).click();
      }
      await page.waitForURL(/\/s\/atlas-created-1\//);
      await page.goto("/");
    }
  });

  test("duplicate checkout opens existing child; missing path retry never starts or recreates", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.goto("/");
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("feature/sidebar");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("Branch already checked out");
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("feature/sidebar");
    await page.screenshot({ path: info.outputPath("duplicate-existing-checkout.png"), fullPage: true });
    const before = await page.request.get("/__demo/ledger").then(r => r.json());
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForURL(/\/s\/atlas-sidebar\//);
    const after = await page.request.get("/__demo/ledger").then(r => r.json());
    expect(after.rows.length).toBe(before.rows.length);
    await page.goto("/");
    page.on("dialog", prompt => prompt.accept());
    await page.locator('[data-workspace="atlas"]').getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator('[data-workspace="atlas-sidebar"]').getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.request.post("/__demo/reset", { form: { scenario: "missing" } });
    await page.reload();
    await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
    const missing = page.locator('[data-workspace="atlas-review"]');
    await expect(missing.getByRole("alert")).toContainText("Missing checkout");
    await expect(missing.getByRole("button", { name: /^Start/ })).toHaveCount(0);
    const retained = await page.request.get("/__demo/ledger").then(r => r.json());
    await missing.getByRole("button", { name: "Retry refresh", exact: true }).click();
    await expect(missing.getByRole("alert")).toContainText("Nothing will be recreated");
    const refreshed = await page.request.get("/__demo/ledger").then(r => r.json());
    expect(refreshed.rows).toEqual(retained.rows);
    await page.screenshot({ path: info.outputPath("missing-path-after-retry.png"), fullPage: true });
  });
});
