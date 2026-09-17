import { test, expect } from "./worktree-demo-fixtures";
import { captureScreenshot, saveEvidence } from "./evidence";
import type { Page } from "@playwright/test";

async function picker(page: Page) {
  if (await page.locator('html').getAttribute('data-ui-mode') === 'touch') await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByText("SIMULATION · scenarios and reset", { exact: true }).click();
  await page.getByRole("button", { name: "Review simulated inventory / recovery / folder safety" }).click();
  await expect(page.getByRole("heading", { name: "Repository worktrees", exact: true })).toBeVisible();
}
async function reset(page: Page, scenario = "populated", latency = "0") {
  const mounted = /\/s\/[^/]+\//.test(page.url());
  await page.request.post("/__demo/reset", { form: { scenario, latency } });
  if (mounted) {
    const { generation } = await page.request.get("/__demo/generation").then(response => response.json());
    // An already mounted page retires itself when its stream learns that the
    // scenario changed. Do not race that navigation with a second page.goto.
    await page.waitForURL(url => url.pathname.startsWith("/s/atlas/") && url.searchParams.get("demoGeneration") === String(generation));
  } else await page.goto("/s/atlas/");
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator('html').getAttribute('data-ui-mode') === 'touch') await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(page.locator("#preview")).toContainText("Atlas workspace");
  await picker(page);
}
async function create(page: Page, mode = "new") {
  await page.getByRole("link", { name: "Create worktree", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("feature/checkout");
  await page.getByRole("button", { name: "Create", exact: true }).click();
}
const ledger = async (page: Page) => (await page.request.get("/__demo/ledger")).json();
const row = (page: Page, id = "atlas-sidebar") => page.locator(`[data-workspace="${id}"]`);
async function created(page: Page) {
  await expect(page.locator('[data-worktree-confirmation]')).toContainText("Created ");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Worktree ready|Details/ })).toHaveCount(0);
  await expect(page.locator('[data-worktree-confirmation]').getByRole("button", { name: "Open", exact: true })).toBeVisible();
}

for (const narrow of [false, true]) test.describe(narrow ? "narrow touch" : "desktop", () => {
  test.use({ viewport: narrow ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: narrow, isMobile: narrow });

  test("branch provenance stays secondary and truthful on both nested row surfaces", async ({ page }, info) => {
    // Exercise the same mock mutations used by compact forms, then both actual renderers.
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    const creations: Record<string, string>[] = [
      { mode: "new", branch: "feature/provenance" },
      { mode: "existing", selection: "remote:origin/feature/search" },
      { mode: "existing", selection: "local:fix/navigation" },
    ];
    for (const form of creations) {
      const response = await page.request.post("/worktrees/create", { form });
      expect(response.ok()).toBe(true);
    }
    await page.request.post("/worktrees/settings", { form: { id: "atlas", authentication: "none", signing: "demo-signing", configuration: "review" } });
    const origins = [
      ["atlas-sidebar", "feature/sidebar", "from main"],
      ["atlas-created-1", "feature/provenance", "from main"],
      ["atlas-created-2", "feature/search", "from origin/feature/search"],
      ["atlas-created-3", "fix/navigation", "origin unknown"],
      ["atlas-review", "review/accessibility", "origin unknown"],
    ];
    for (const surface of ["selector", "dashboard"]) {
      await page.goto(surface === "selector" ? "/s/atlas/" : "/");
      if (surface === "dashboard") await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
      if (surface === "selector") {
        await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
        if (narrow) await page.getByRole("tab", { name: "Files", exact: true }).click();
        await page.locator("#hub-toggle").click();
      }
      const label = surface === "selector" ? ".hub-menu-provenance" : ".worktree-provenance";
      for (const [id, branch, origin] of origins) {
        const row = page.locator(surface === "selector" ? `[data-workspace-id="${id}"]` : `[data-workspace="${id}"]`);
        await expect(row.locator(label)).toHaveText(origin!);
        await expect(row).toContainText(branch!);
        await expect.poll(() => row.locator(label).evaluate(node => getComputedStyle(node).fontWeight)).toBe("400");
        if (surface === "selector") {
          const menuBounds = await page.locator("#hub-menu").boundingBox();
          const rowBounds = await row.boundingBox();
          expect(rowBounds!.x + rowBounds!.width).toBeLessThanOrEqual(menuBounds!.x + menuBounds!.width);
        }
      }
      const parent = page.locator(surface === "selector" ? '[data-workspace-id="atlas"]' : '[data-workspace="atlas"]');
      await expect(parent.locator(label)).toHaveCount(0);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await captureScreenshot(page, info, `provenance-${surface}-${colorScheme}`);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await saveEvidence(info, "provenance.json", JSON.stringify({ simulation: true, narrowTouchEmulation: narrow, origins, state: await ledger(page) }, null, 2));
  });

  test("grouped picker and real dashboard fork the selected parent; live parent policy and collision paths", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await reset(page);
    await page.getByRole("button", { name: "Close worktrees" }).click();
    await page.locator("#hub-toggle").click();
    await expect(page.getByRole("button", { name: "Add worktree to Atlas", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add worktree to Beacon", exact: true })).toBeVisible();
    await expect(page.locator('#hub-menu button[aria-label^="Add worktree"]')).toHaveCount(2);
    const ids = await page.locator("#hub-menu [data-workspace-id]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.workspaceId));
    expect(ids.indexOf("atlas-sidebar")).toBeGreaterThan(ids.indexOf("atlas"));
    expect(ids.indexOf("atlas-sidebar")).toBeLessThan(ids.indexOf("beacon"));
    await captureScreenshot(page, info, "grouped-workspace-selector");
    await page.getByRole("button", { name: "Add worktree to Beacon", exact: true }).click();
    await captureScreenshot(page, info, "compact-fork-menu");
    await page.getByRole("menuitem", { name: "New branch / worktree" }).click();
    await expect(page.getByLabel("Workspace display name")).toHaveCount(0);
    await page.getByLabel("Name", { exact: true }).fill("feature/login");
    await captureScreenshot(page, info, "compact-new-branch-popup");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await created(page);
    expect((await ledger(page)).rows.at(-1)).toMatchObject({ parentId: "beacon", path: "/demo/workspaces/beacon.worktrees/feature-login", name: "feature/login" });
    await page.goto("/");
    await expect(page.locator('[data-hub-page="dashboard"]')).toBeVisible();
    await expect(page.locator('[data-workspace="beacon-created-1"]')).toHaveAttribute("data-parent", "beacon");
    await expect(page.getByRole("button", { name: /^Add worktree to/ })).toHaveCount(2);
    await captureScreenshot(page, info, "real-hub-grouped-dashboard");
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree" }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature/login");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await created(page);
    await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
    await expect(page.locator('[data-workspace="atlas-created-2"]')).toBeVisible();
    await page.locator('[data-repository="atlas"] .dashboard-group-heading').getByRole("button", { name: "Configure", exact: true }).click();
    await page.getByLabel("Parent authentication").selectOption("none");
    await page.getByLabel("Parent signing").selectOption("demo-signing");
    await page.getByRole("combobox", { name: "Shared workspace configuration", exact: true }).selectOption("review");
    await page.getByRole("button", { name: "Save parent settings" }).click();
    await expect(page.getByText("Parent policy updated.", { exact: false })).toBeVisible();
    await page.goto("/");
    await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
    await expect(page.locator('[data-workspace="atlas-created-2"]')).toContainText("demo-signing");
    await expect(page.getByLabel("Parent authentication")).toHaveCount(0);
    await captureScreenshot(page, info, "child-inherits-parent-policy");
    await page.goto("/");
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree" }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature-login");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await created(page);
    const state = await ledger(page);
    expect(state.rows.at(-1).path).toMatch(/atlas.worktrees\/feature-login-[a-f0-9]{8}$/);
    expect(errors).toEqual([]);
    await saveEvidence(info, "grouping-inheritance-and-paths.json", JSON.stringify({ simulation: true, narrowTouchEmulation: narrow, pickerOrder: ids, state }, null, 2));
  });

  test("real dashboard keeps ordinary no-capability and empty-state behavior", async ({ page }) => {
    await page.route("**/api/hub/state", route => route.fulfill({ json: { workspaces: [] } }));
    await page.goto("/");
    await expect(page.getByText("No sessions running — start a workspace below.")).toBeVisible();
    await expect(page.getByText("No stopped workspaces — use Add workspace to configure one.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add worktree to/ })).toHaveCount(0);
  });

  for (const mode of ["new", "local", "remote"]) test(`dashboard ${mode}: completion refreshes rows and Open alone switches context`, async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.goto("/");
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: mode === "new" ? "New branch / worktree" : "Existing branch", exact: true }).click();
    if (mode === "new") await page.getByLabel("Name", { exact: true }).fill("feature/checkout");
    else await page.getByRole("option", { name: mode === "local" ? "fix/navigation Local" : "origin/feature/search Remote", exact: true }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await created(page);
    await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
    await expect(page.locator('[data-workspace="atlas-created-1"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    expect((await ledger(page)).rows.at(-1).running).toBe(false);
    await captureScreenshot(page, info, `dashboard-${mode}-closed-created-confirmation`);
    await page.locator('[data-worktree-confirmation]').getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/s\/atlas-created-1\//);
  });

  test("running deletion explicitly stops Uatu; active removal navigates safely", async ({ page }, info) => {
    await page.request.post("/__demo/reset", { form: { scenario: "populated" } });
    await page.request.post("/api/hub/sessions/atlas-sidebar/start");
    await page.goto("/s/atlas-sidebar/");
    await picker(page);
    await row(page).getByRole("link", { name: "Delete worktree", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete worktree?", exact: true });
    await expect(dialog).toContainText("Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept.");
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    expect(await dialog.evaluate(node => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth)).toBe(true);
    const bounds = await dialog.boundingBox(); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(narrow ? 844 : 1000);
    await captureScreenshot(page, info, "running-compact-delete");
    await dialog.getByRole("button", { name: "Stop and delete", exact: true }).click();
    await expect(page).toHaveURL(/\/s\/atlas\//);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const state = await ledger(page);
    expect(state.rows.some((row: { id: string }) => row.id === "atlas-sidebar")).toBe(false);
    expect(state.branches).toContain("feature/sidebar");
  });

  for (const entry of ["dashboard", "selector"]) test(`${entry}: compact menus, fuzzy keyboard selection and cancellation are mutation-free`, async ({ page }, info) => {
    await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--titlebar-inset", "52px")));
    await reset(page);
    await page.getByRole("button", { name: "Close worktrees" }).click();
    if (entry === "dashboard") await page.goto("/");
    else await page.locator("#hub-toggle").click();
    await expect(page.getByRole("button", { name: "Worktrees · create and discover" })).toHaveCount(0);
    const fork = page.getByRole("button", { name: "Add worktree to Atlas", exact: true });
    await fork.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem")).toHaveCount(2);
    await expect(page.getByRole("menuitem", { name: "New branch / worktree" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Existing branch", exact: true })).toBeFocused();
    await captureScreenshot(page, info, `${entry}-two-option-menu`);
    await page.emulateMedia({ colorScheme: "dark" });
    await captureScreenshot(page, info, `${entry}-two-option-menu-dark`);
    await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Escape"); await expect(fork).toBeFocused();
    await page.keyboard.press("Enter"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Existing branch", exact: true });
    const search = dialog.getByRole("combobox", { name: "Branch" });
    await expect(search).toBeFocused();
    await expect(dialog.getByRole("option")).toHaveCount(8);
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
    await search.fill("rls");
    await expect(dialog.getByRole("option")).toHaveCount(3);
    await expect(dialog.getByRole("option", { name: "release Local", exact: true })).toBeVisible();
    await expect(dialog.getByRole("option", { name: "origin/release Remote", exact: true })).toBeVisible();
    await expect(dialog.getByRole("option", { name: "upstream/release Remote", exact: true })).toBeVisible();
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await expect(search).toHaveValue("origin/release");
    await search.click();
    await expect(dialog.getByRole("option", { name: "origin/release Remote", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await captureScreenshot(page, info, `${entry}-fuzzy-branch-selector`);
    await page.emulateMedia({ colorScheme: "dark" });
    await captureScreenshot(page, info, `${entry}-fuzzy-branch-selector-dark`);
    await page.emulateMedia({ colorScheme: "light" });
    const rect = await dialog.boundingBox(); expect(rect!.width).toBeLessThanOrEqual(422); expect(rect!.height).toBeLessThan(520);
    expect(rect!.y).toBeGreaterThanOrEqual(52);
    await search.fill("no-such-branch"); await expect(dialog.getByText("No matching branches")).toBeVisible();
    await page.keyboard.press("Enter");
    await search.fill("fnav"); await expect(dialog.getByRole("option")).toHaveCount(1);
    await dialog.getByRole("option", { name: "fix/navigation Local", exact: true }).click();
    await expect(search).toHaveValue("fix/navigation");
    await expect(dialog.locator('[data-value="local:fix/navigation"]')).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    if (entry === "selector") await page.locator("#hub-toggle").click();
    await fork.click(); await page.getByRole("menuitem", { name: "New branch / worktree" }).click();
    const newDialog = page.getByRole("dialog", { name: "New branch / worktree", exact: true });
    await expect(newDialog.locator("input:not([type=hidden])")).toHaveCount(1);
    await expect(newDialog.getByRole("button")).toHaveCount(2);
    await newDialog.getByLabel("Name", { exact: true }).fill("feature/cancelled");
    await captureScreenshot(page, info, `${entry}-one-field-popup`);
    await page.keyboard.press("Escape");
    const state = await ledger(page);
    expect(state.rows).toHaveLength(5);
    expect(state.ledger.filter((request: { method: string; path: string }) => request.method === "POST" && /worktrees\//.test(request.path))).toHaveLength(0);
    await saveEvidence(info, `${entry}-compact-cancellation.json`, JSON.stringify({ simulation: true, touchEmulation: narrow, dialog: rect, mutationRequests: 0, localAndRemote: "same-name options disambiguated", keyboard: "arrows, Enter selection, Escape cancellation", fuzzy: "rls and fnav", state }, null, 2));
  });

  test("dashboard preserves original running and stopped row actions", async ({ page }) => {
    await reset(page); await page.goto("/");
    const parent = page.locator('[data-workspace="atlas"]');
    const group = page.locator('[data-repository="atlas"] .dashboard-group-heading');
    await expect(parent.locator(".indicator-dot.is-live")).toBeVisible();
    await expect(group.getByRole("button", { name: "Rename workspace Atlas" })).toBeVisible();
    await expect(parent.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(parent.locator(".row-title")).toHaveText("mainMain checkout");
    const child = page.locator('[data-workspace="atlas-sidebar"]');
    await page.locator('[data-disclosure="atlas-stopped"] > summary').click();
    await expect(child.getByRole("button", { name: "Start feature/sidebar" })).toBeVisible();
    await expect(child.getByRole("button", { name: "Remove feature/sidebar from Uatu" })).toBeVisible();
    await expect(group.getByRole("button", { name: "Configure", exact: true })).toBeVisible();
    await expect(child.getByRole("button", { name: "Configure", exact: true })).toHaveCount(0);
    await expect(child.getByRole("button", { name: "Delete worktree", exact: true })).toBeVisible();
    await expect(page.locator('[data-workspace="atlas-review"]').getByRole("button", { name: "Delete worktree" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Details|Fetch remote/ })).toHaveCount(0);
    page.once("dialog", dialog => dialog.accept());
    await parent.getByRole("button", { name: "Stop", exact: true }).click();
    await page.locator('[data-disclosure="atlas-inactive"] > summary').click();
    await expect(parent.getByRole("button", { name: "Start Atlas" })).toBeVisible();
    page.once("dialog", dialog => dialog.accept("Atlas renamed"));
    await group.getByRole("button", { name: "Rename workspace Atlas" }).click();
    await expect(group.getByText("Atlas renamed", { exact: true })).toBeVisible();
  });

  test("editable branch choice, explicit fetch and disappeared selection never submit a stale ref", async ({ page }, info) => {
    await reset(page);
    await page.getByRole("button", { name: "Close worktrees" }).click();
    const open = async () => {
      await page.locator("#hub-toggle").click();
      await expect(page.getByRole("button", { name: /^Details for/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Add worktree to Beacon", exact: true }).click();
      await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    };
    await open();
    const search = page.getByRole("combobox", { name: "Branch", exact: true });
    const createButton = page.getByRole("button", { name: "Create", exact: true });
    const fetchButton = page.getByRole("button", { name: "Fetch remote branches", exact: true });
    expect((await ledger(page)).ledger.filter((entry: { path: string }) => entry.path.endsWith("/fetch"))).toHaveLength(0);
    await search.fill("fnav"); await page.keyboard.press("Enter");
    await expect(search).toHaveValue("fix/navigation"); await expect(createButton).toBeEnabled();
    await search.fill("fix/navigation "); await expect(createButton).toBeDisabled();
    await search.fill("rls"); await fetchButton.click();
    await expect(search).toHaveValue("rls"); await expect(createButton).toBeDisabled();
    await search.click(); await expect(page.getByRole("dialog").getByRole("option")).toHaveCount(3);
    await search.fill("origin/feature/search"); await page.getByRole("option", { name: "origin/feature/search Remote", exact: true }).click();
    await fetchButton.click();
    await expect(search).toHaveValue("origin/feature/search"); await expect(createButton).toBeEnabled();
    await search.click(); await expect(page.getByRole("dialog").getByRole("option")).toHaveCount(8);
    await expect(page.getByRole("option", { name: "origin/feature/search Remote", exact: true })).toHaveAttribute("aria-selected", "true");
    await captureScreenshot(page, info, "editable-combobox-fetch-preserved");
    await search.press("Escape"); await expect(search).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("dialog", { name: "Existing branch" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await open(); await expect(search).toHaveValue(""); await expect(createButton).toBeDisabled();
    await page.getByRole("option", { name: "origin/feature/search Remote", exact: true }).click();
    await createButton.click();
    await created(page);
    expect((await ledger(page)).rows.at(-1)).toMatchObject({ parentId:"beacon", branch:"feature/search", upstream:"origin/feature/search" });
    await reset(page, "fetch-disappearance");
    await page.getByRole("button", { name: "Close worktrees" }).click();
    await open();
    await page.getByRole("option", { name: "origin/feature/search Remote", exact: true }).click();
    await fetchButton.click();
    await expect(page.getByRole("alert")).toContainText("no longer available");
    await expect(search).toHaveValue("origin/feature/search"); await expect(createButton).toBeDisabled();
    await captureScreenshot(page, info, "editable-combobox-disappeared");
    await search.fill("fnav"); await page.keyboard.press("Enter");
    await expect(search).toHaveValue("fix/navigation");
    await createButton.click(); await created(page);
    expect((await ledger(page)).rows.at(-1)).toMatchObject({ parentId:"beacon", branch:"fix/navigation" });
    await saveEvidence(info, "editable-combobox.json", JSON.stringify({ simulation:true, touchEmulation:narrow, state:await ledger(page) }, null, 2));
  });

  test("secondary branch page preserves disabled Create after a transport failure", async ({ page }) => {
    await page.request.post("/__demo/reset", { form: { scenario:"populated" } });
    await page.goto("/hub-worktrees?view=create&source=atlas&mode=existing");
    const createButton = page.getByRole("button", { name:"Create", exact:true });
    await expect(createButton).toBeDisabled();
    await page.getByRole("combobox", { name:"Branch", exact:true }).fill("rls");
    await page.route("**/hub-worktrees/fetch", route => route.abort());
    await page.getByRole("button", { name:"Fetch remote branches" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(createButton).toBeDisabled();
    expect((await ledger(page)).rows).toHaveLength(5);
  });

  for (const mode of ["new", "local", "remote"]) test(`${mode}: create in the actual picker, stopped result and explicit open`, async ({ page }, info) => {
    await reset(page);
    const original = page.url();
    await page.getByRole("button", { name: "Close worktrees" }).click();
    await page.locator("#hub-toggle").click();
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: mode === "new" ? "New branch / worktree" : "Existing branch", exact: true }).click();
    await expect(page.getByText("Credentials and shared workspace configuration", { exact: false })).toHaveCount(0);
    await expect(page.getByLabel("Authentication assignment")).toHaveCount(0);
    if (mode === "new") await page.getByLabel("Name", { exact: true }).fill("feature/checkout");
    else await page.getByRole("option", { name: mode === "local" ? "fix/navigation Local" : "origin/feature/search Remote", exact: true }).click();
    await captureScreenshot(page, info, `actual-picker-create-${mode}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await created(page);
    expect(page.url()).toBe(original);
    await expect(page.locator("#preview")).toContainText("Atlas workspace");
    const before = await ledger(page);
    const branch = mode === "local" ? "fix/navigation" : mode === "remote" ? "feature/search" : "feature/checkout";
    expect(before.rows.at(-1)).toMatchObject({ id: "atlas-created-1", running: false, parentId: "atlas", branch });
    if (mode === "remote") expect(before.rows.at(-1).upstream).toBe("origin/feature/search");
    await page.locator("#hub-toggle").click();
    await expect(page.locator('#hub-menu [data-workspace-id="atlas-created-1"]')).toContainText(branch);
    await expect(page.locator('#hub-menu [data-workspace-id="atlas-created-1"]')).toContainText("stopped");
    await page.locator("#hub-toggle").click();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/s\/atlas-created-1\//);
    await expect(page.locator("#preview")).toContainText(`${branch} workspace`);
    await saveEvidence(info, `${mode}-stopped-result.json`, JSON.stringify(before, null, 2));
  });

  test("asynchronous create transport failure remains compact and retryable in the source flow", async ({ page }) => {
    await reset(page);
    const original = page.url();
    await page.route("**/worktrees/create", route => route.abort());
    await create(page);
    const dialog = page.getByRole("dialog", { name: "New branch / worktree", exact: true });
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("feature/checkout");
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await expect(dialog.locator("dd")).toHaveCount(0);
    expect((await ledger(page)).rows).toHaveLength(5);
    expect(page.url()).toBe(original);
    await page.unroute("**/worktrees/create");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await created(page);
    expect((await ledger(page)).rows).toHaveLength(6);
    expect(page.url()).toBe(original);
  });

  for (const scenario of ["branch-conflict", "path-conflict", "checked-out"]) test(`${scenario}: conflict, focus and no force`, async ({ page }) => {
    await reset(page, scenario); await create(page);
    await expect(page.getByRole("alert")).toBeFocused();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("feature/checkout");
    expect((await ledger(page)).rows).toHaveLength(5);
    await expect(page.getByRole("button", { name: /force/i })).toHaveCount(0);
    if (scenario === "checked-out") {
      await page.getByRole("link", { name: "Open", exact: true }).click();
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      if (narrow) await page.getByRole("tab", { name: "Preview", exact: true }).click();
      await expect(page.locator("#preview")).toContainText("Atlas workspace");
    }
  });

  test("invalid input, stale refs, fetch pending/auth/network failure and explicit retry", async ({ page }) => {
    await reset(page, "fetch-auth", "1200");
    await page.getByRole("link", { name: "Create worktree", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("--bad");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Invalid branch");
    await page.getByLabel("Name", { exact: true }).fill("feature/checkout");
    await expect(page.getByLabel("Destination parent")).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    if (narrow) await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.locator("#hub-toggle").click();
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    await page.getByRole("button", { name: "Fetch remote branches" }).click();
    await expect(page.locator("#operation-status")).toContainText("Fetching");
    await expect(page.getByRole("button", { name: "Fetch remote branches" })).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("authentication failed");
    await page.getByRole("button", { name: "Fetch remote branches" }).click();
    await expect(page.getByRole("option", { name: "origin/fetched Remote" })).toBeVisible();
    await expect(page.getByLabel("Authentication assignment")).toHaveCount(0);
    await reset(page, "fetch-network");
    await page.getByRole("button", { name: "Close worktrees" }).click();
    if (narrow) await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.locator("#hub-toggle").click();
    await page.getByRole("button", { name: "Add worktree to Atlas", exact: true }).click();
    await page.getByRole("menuitem", { name: "Existing branch", exact: true }).click();
    await page.getByRole("button", { name: "Fetch remote branches" }).click();
    await expect(page.getByRole("alert")).toContainText("network failure");
    await page.getByRole("button", { name: "Fetch remote branches" }).click();
    await expect(page.getByRole("option", { name: "origin/fetched Remote" })).toBeVisible();
    expect((await ledger(page)).rows).toHaveLength(5);
  });

  test("retained checkout retry and failed start preserve identity and explicit assignments", async ({ page }, info) => {
    await reset(page, "registration-failure"); await create(page);
    await expect(page.getByRole("alert")).toContainText("checkout and branch are retained");
    await expect(page.getByRole("dialog").locator("dd")).toHaveCount(0);
    const before = await ledger(page);
    await captureScreenshot(page, info, "actual-picker-retained-checkout");
    await page.getByRole("button", { name: "Retry registration" }).click();
    await created(page);
    const after = await ledger(page);
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows.at(-1).checkout).toBe(before.rows.at(-1).checkout);
    await reset(page, "start-failure");
    await create(page);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("remains stopped");
    expect((await ledger(page)).rows.at(-1)).toMatchObject({ running: false, parentId: "atlas" });
    await page.route("**/worktrees/start", route => route.abort());
    await page.getByRole("button", { name: "Retry Open", exact: true }).click();
    await expect(page.locator("#operation-status")).toHaveAttribute("role", "alert");
    await expect(page.getByRole("button", { name: "Retry Open", exact: true })).toBeEnabled();
    await page.unroute("**/worktrees/start");
    await page.getByRole("button", { name: "Retry Open", exact: true }).click();
    await expect(page.locator("#preview")).toContainText("feature/checkout workspace");
  });

  test("discovery/reconnect leave source intact; external configuration and unavailable paths", async ({ page }, info) => {
    await reset(page, "discovery"); const original = page.url();
    await page.getByRole("button", { name: "Refresh inventory" }).click();
    await expect(page.locator('[data-workspace="atlas-agent"]')).toBeVisible();
    expect(page.url()).toBe(original);
    await expect(page.locator("#preview")).toContainText("Atlas workspace");
    await page.locator('[data-workspace="atlas-agent"]').getByRole("link", { name: "Register workspace" }).click();
    await expect(page.getByLabel("Authentication assignment")).toHaveCount(0);
    await page.getByRole("button", { name: "Register workspace", exact: true }).click();
    await expect(page.getByRole("link", { name: "Delete worktree", exact: true })).toHaveCount(0);
    await reset(page);
    await page.request.post("/__demo/discover");
    await expect(page.locator('[data-workspace="atlas-agent"]')).toBeVisible();
    await reset(page);
    await page.request.post("/__demo/reconnect");
    await expect(page.locator('[data-workspace="atlas-agent"]')).toBeVisible();
    await captureScreenshot(page, info, "actual-picker-reconnected-discovery");
    for (const scenario of ["missing", "replaced"]) {
      await reset(page, scenario);
      await expect(row(page, "atlas-review").getByRole("alert")).toContainText("Nothing will be recreated");
      await expect(row(page, "atlas-review").getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
      await captureScreenshot(page, info, `actual-picker-${scenario}`);
    }
  });

  test("checked-out external branch requires configuration; secondary Hub entry reuses lifecycle presentation", async ({ page }) => {
    await reset(page);
    await page.request.post("/__demo/discover");
    await expect(page.locator('[data-workspace="atlas-agent"]')).toBeVisible();
    await page.getByRole("link", { name: "Create worktree", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("agent/exploration");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("already checked out");
    await page.getByRole("link", { name: "Register workspace" }).click();
    await expect(page.getByLabel("Authentication assignment")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Close worktrees" }).click();
    await page.goto("/clone");
    await expect(page.getByText("SIMULATION · secondary Hub entry.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Create worktree", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("feature/secondary");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await created(page);
    await page.goto("/hub-worktrees?view=inventory");
    await row(page, "atlas-created-1").getByRole("link", { name: "Rename folder", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Stopping does not make this move safe");
    await page.getByRole("link", { name: "Back to worktrees" }).click();
    await page.locator('[data-workspace="atlas-created-1"]').getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).toHaveURL(/\/s\/atlas-created-1\//);
    await expect(page.locator("#preview")).toContainText("feature/secondary workspace");
  });

  for (const scenario of ["dirty", "untracked", "ignored", "locked", "in-use", "nested", "stop-failure"]) test(`${scenario}: guarded deletion retains checkout`, async ({ page }, info) => {
    await reset(page, scenario);
    await row(page).getByRole("link", { name: "Delete worktree", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete worktree?", exact: true });
    await expect(dialog).toContainText("Atlas / feature/sidebar");
    await expect(dialog.locator("dd, input[type=checkbox]")).toHaveCount(0);
    await expect(dialog).not.toContainText("/demo/");
    await expect(dialog).not.toContainText("SIMULATION");
    await expect(page.getByLabel("Also request safe branch deletion")).toHaveCount(0);
    if (scenario === "stop-failure") await dialog.getByRole("button", { name: "Stop and delete", exact: true }).click();
    await expect(dialog.getByRole("button", { name: /^(Delete|Stop and delete)$/ })).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText(/retained|retain/i);
    expect((await ledger(page)).rows).toHaveLength(5);
    expect(await dialog.evaluate(node => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth)).toBe(true);
    await captureScreenshot(page, info, `actual-picker-delete-${scenario}`);
  });

  test("clean removal always preserves branch; unregister and rename guard", async ({ page }) => {
    await reset(page);
    await row(page).getByRole("link", { name: "Delete worktree", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("The worktree’s files will be removed. The Git branch will be kept.");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator('[data-worktree-confirmation]')).toContainText("Branch kept");
    expect((await ledger(page)).rows).toHaveLength(4);
    await reset(page);
    await expect(row(page, "atlas-review").getByRole("link", { name: "Delete worktree", exact: true })).toHaveCount(0);
    await row(page, "atlas-review").getByRole("link", { name: "Rename folder", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Stopping does not make this move safe");
    await expect(page.getByRole("link", { name: "Rename workspace instead" })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to worktrees" }).click();
    await row(page, "atlas-review").getByRole("link", { name: "Remove from Uatu", exact: true }).click();
    await page.getByLabel("Stop Uatu activity and remove").check();
    await page.getByRole("button", { name: "Remove from Uatu", exact: true }).click();
    expect((await ledger(page)).rows.find((row: { id: string }) => row.id === "atlas-review")).toMatchObject({ registered: false, checkout: "checkout-review", path: "/demo/workspaces/atlas-review" });
    expect((await ledger(page)).branches).toContain("feature/sidebar");
  });

  for (const colorScheme of ["light", "dark"] as const) test(`${colorScheme}: keyboard, titlebar inset, loading/empty/error, slow operation and visible reset`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.classList.add("uatu-desktop-host");
      document.documentElement.style.setProperty("--titlebar-inset", "52px");
    }));
    await reset(page, "empty"); await expect(page.getByRole("heading", { name: "No linked worktrees yet" })).toBeVisible();
    await captureScreenshot(page, info, `${colorScheme}-actual-picker-empty`);
    await reset(page, "loading"); await expect(page.getByText("Loading worktree inventory…")).toBeVisible();
    await page.getByRole("button", { name: "Refresh inventory" }).click(); await expect(page.locator("[data-workspace]")).toHaveCount(3);
    await reset(page, "inventory-error"); await expect(page.getByRole("alert")).toBeFocused();
    await page.getByRole("button", { name: "Refresh inventory" }).click(); await expect(page.getByRole("alert")).toHaveCount(0);
    await reset(page, "populated", "1200");
    await page.getByRole("link", { name: "Create worktree", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("feature/checkout");
    await captureScreenshot(page, info, `${colorScheme}-actual-picker-create`);
    const rect = await page.getByRole("dialog").boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.width).toBeLessThanOrEqual(narrow ? 390 : 1440);
    expect(rect!.y).toBeGreaterThanOrEqual(52);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.locator("#operation-status")).toBeFocused();
    await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
    await created(page);
    const state = await ledger(page);
    expect(state.ledger.filter((entry: { path: string }) => entry.path === "/worktrees/create")).toHaveLength(1);
    await expect(page.locator("#hub-toggle")).toBeFocused();
    await page.getByText("SIMULATION · scenarios and reset", { exact: true }).click();
    await page.getByLabel("Scenario", { exact: true }).selectOption("populated");
    await page.getByRole("button", { name: "Reset scenario" }).click();
    await page.waitForURL(url => url.searchParams.get("demoGeneration") === String(state.generation + 1));
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(page.locator("#preview")).toContainText("Atlas workspace"); await picker(page);
    await expect(page.locator("[data-workspace]")).toHaveCount(3);
    expect((await ledger(page)).rows.some((row: { id: string }) => row.id === "atlas-created-1")).toBe(false);
    await saveEvidence(info, `${colorScheme}-behavior.json`, JSON.stringify({ simulation: true, narrowTouchEmulation: narrow, nativeMacOS: "not tested", dialog: rect, creationRequests: 1, reset: "initial inventory restored" }, null, 2));
  });
});
