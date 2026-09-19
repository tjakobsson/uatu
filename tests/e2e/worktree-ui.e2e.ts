// The migrated worktree dialog on a REAL Hub with real temporary Git
// repositories, real workspace children and real PTYs.
//
// worktree-integration.e2e.ts proves the independence of two checkouts'
// contexts (files, preview, terminal, chat) across a create → open → return
// round trip. This file proves the dialog itself: that one client module,
// embedded in both the in-workspace picker and the Hub dashboard, renders
// every view from the published JSON family and performs every guarded
// operation — creation in both modes, an explicit fetch, registration of a
// tree Git already lists, guarded deletion with its blocker, Remove from
// Uatu, a missing path that is never recreated, and live invalidation that
// leaves the page's own selection alone.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { test, expect } from "./hub-fixtures";
import { captureScreenshot, saveEvidence } from "./evidence";

const exec = promisify(execFile);
test.use({ hubWorktrees: true, hubWorkspaces: ["orbit-desktop", "orbit-touch"] });

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Uatu Test", "-c", "user.email=uatu@example.test", ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout.trim();
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
}

// The Files surface, in whichever UI mode this viewport booted into.
async function files(page: Page): Promise<void> {
  await ready(page);
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") {
    await page.getByRole("tab", { name: "Files", exact: true }).click();
  }
}

async function picker(page: Page): Promise<void> {
  await files(page);
  if (!await page.locator("#hub-menu").isVisible()) await page.locator("#hub-toggle").click();
}

async function fork(
  page: Page,
  parentId: string,
  mode: "New branch / worktree" | "Existing branch" | "Register worktree…",
): Promise<void> {
  await picker(page);
  await page.getByRole("button", { name: `Add worktree to ${parentId}`, exact: true }).click();
  await page.getByRole("menuitem", { name: mode, exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function inventoryOf(page: Page, sourceWorkspaceId: string) {
  const response = await page.request.get(`/api/hub/worktrees?source=${encodeURIComponent(sourceWorkspaceId)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).inventory as {
    checkouts: { checkoutId: string; workspaceId?: string; path: string; branch: string; ownership: string; registered: boolean; running: boolean; availability: string }[];
    refs: { local: string[]; remote: string[] };
  };
}

// The Active-groups dashboard folds stopped children behind
// `N stopped worktrees` disclosures; open every one so their rows are in the
// accessibility tree.
async function dashboard(page: Page): Promise<void> {
  await expect.poll(async () => page.locator("[data-disclosure]").count()).toBeGreaterThan(0);
  // The dashboard re-renders on its own poll, so a collapsed disclosure can
  // detach between the query and the click; each pass takes the first one
  // still collapsed. The open state itself survives those re-renders.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const collapsed = page.locator("[data-disclosure]:not([open])");
    if (await collapsed.count() === 0) return;
    await collapsed.first().locator("summary").click({ timeout: 5_000 }).catch(() => undefined);
  }
}

const rowFor = async (page: Page, source: string, branch: string) =>
  (await inventoryOf(page, source)).checkouts.find(checkout => checkout.branch === branch)!;

for (const touch of [false, true]) test.describe(touch ? "worktree dialog on touch" : "worktree dialog on desktop", () => {
  const parentId = touch ? "orbit-touch" : "orbit-desktop";
  const label = touch ? "touch" : "desktop";
  test.use({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch });

  test("creation in both modes, explicit Open, and the way back", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parent = hub.workspaces.find(workspace => workspace.id === parentId)!;
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${hub.origin}/s/${parentId}/`);
    await files(page);
    await page.locator('[data-item-path="NOTES.md"]').click();

    // --- New branch / worktree -------------------------------------------
    await fork(page, parentId, "New branch / worktree");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`New branch / worktree · ${parentId}`);
    // The initial base is local main, committed without typing.
    await expect(dialog.locator("[name=selection]")).toHaveValue("local:main");
    // The option list is collapsed once a ref is committed, so it is read by
    // attribute rather than by role here.
    await expect(dialog.locator('[role="option"][data-value="local:main"]')).toHaveAttribute("aria-selected", "true");
    const create = dialog.getByRole("button", { name: "Create", exact: true });
    // An invalid name cannot be submitted.
    await dialog.getByLabel("Name", { exact: true }).fill("--force");
    await expect(create).toBeDisabled();
    await dialog.getByLabel("Name", { exact: true }).fill("feature/dialog");
    await expect(create).toBeEnabled();
    await captureScreenshot(page, info, `worktree-ui-${label}-create-new`);
    await create.click();

    // Closes, confirms, and leaves the source selected and stopped. The
    // confirmation is at the TOP of the viewport (decision D), in the app's
    // success colour, above the app header.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const toast = page.locator("[data-worktree-confirmation]");
    await expect(toast).toContainText("Created feature/dialog");
    await expect(toast).toHaveAttribute("data-tone", "success");
    const toastBox = (await toast.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(toastBox.y).toBeLessThan(viewport.height / 3);
    // Centered, within a pixel of the viewport's middle.
    expect(Math.abs((toastBox.x + toastBox.width / 2) - viewport.width / 2)).toBeLessThan(2);
    expect(new URL(page.url()).pathname.startsWith(`/s/${parentId}/`)).toBe(true);
    const child = await rowFor(page, parentId, "feature/dialog");
    expect(child.running).toBe(false);
    expect(child.ownership).toBe("uatu");
    const toastColours = async () => page.evaluate(() => {
      const node = document.querySelector("[data-worktree-confirmation]") as HTMLElement;
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, text: style.color, border: style.borderTopColor };
    });
    await page.emulateMedia({ colorScheme: "light" });
    const light = await toastColours();
    await captureScreenshot(page, info, `worktree-ui-${label}-created-toast`);
    await page.emulateMedia({ colorScheme: "dark" });
    const dark = await toastColours();
    await captureScreenshot(page, info, `worktree-ui-${label}-created-toast-dark`);
    await page.emulateMedia({ colorScheme: "light" });
    // The success tint and its text follow the colour scheme in both
    // directions — a notice that stayed light in dark mode would be the
    // brightest thing on the screen.
    expect(light.background).not.toBe(dark.background);
    expect(light.text).not.toBe(dark.text);
    expect(light.background).toBe("rgb(218, 251, 225)");
    expect(dark.background).toBe("rgb(18, 38, 30)");

    // Only explicit Open starts it and navigates to its own session URL.
    await writeFile(path.join(child.path, "CHILD.md"), "# dialog-child-marker\n");
    await toast.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${child.workspaceId}/`));
    await files(page);
    await page.locator('[data-item-path="CHILD.md"]').click();
    await expect(page.locator("#preview")).toContainText("dialog-child-marker");

    // Back through the picker, then through browser history. The picker
    // groups the menu by repository and labels each child (decisions A and
    // E), and the second-round decisions F1–F4 shape the chip, the header
    // and the rows.
    await picker(page);
    // F1: the chip reads `<repository> <branch>` for this CHILD checkout,
    // exactly as it reads for a main checkout — and is the only place the
    // repository is named, the separate title line above it being gone.
    await expect(page.locator("#hub-repository")).toHaveCount(0);
    await expect(page.locator("#hub-current")).toContainText(parentId);
    await expect(page.locator("#hub-current .hub-toggle-branch")).toHaveText("feature/dialog");
    const group = page.locator(`#hub-menu .hub-menu-group[data-repository="${parentId}"]`);
    await expect(group).toContainText(parentId);
    const forkControl = group.getByRole("button", { name: `Add worktree to ${parentId}`, exact: true });
    await expect(forkControl).toBeVisible();
    // F2: the fork control sits at the group header's trailing edge, the
    // same edge a row's status text ends on — not beside the name.
    const groupBox = (await group.boundingBox())!;
    const forkBox = (await forkControl.boundingBox())!;
    expect(forkBox.x).toBeGreaterThan(groupBox.x + groupBox.width / 2);
    expect((groupBox.x + groupBox.width) - (forkBox.x + forkBox.width)).toBeLessThan(10);
    const mainRow = page.locator(`#hub-menu .hub-menu-item[data-workspace-id="${parentId}"]`);
    await expect(mainRow).toContainText("main checkout");
    const childRow = page.locator(`#hub-menu .hub-menu-item[data-workspace-id="${child.workspaceId}"]`);
    await expect(childRow.locator(".hub-menu-provenance")).toHaveText("from main");
    // F4: the child shares the main checkout's left edge — the group header
    // above does the grouping, so nothing is indented.
    const mainLabelBox = (await mainRow.locator(".hub-menu-label").boundingBox())!;
    const childLabelBox = (await childRow.locator(".hub-menu-label").boundingBox())!;
    expect(Math.abs(childLabelBox.x - mainLabelBox.x)).toBeLessThan(1);
    // F3: consecutive repository groups are divided from one another; the
    // first carries no divider of its own (the menu's dashboard divider is
    // already above it).
    const separation = await page.evaluate(() => {
      const menu = document.querySelector("#hub-menu")!;
      const headers = [...menu.querySelectorAll(".hub-menu-group")];
      return {
        groups: headers.length,
        dividers: menu.querySelectorAll(".hub-menu-divider.is-group").length,
        firstIsDivided: headers[0]?.previousElementSibling?.classList.contains("is-group") ?? false,
        laterAllDivided: headers.slice(1).every(header => header.previousElementSibling?.classList.contains("is-group") === true),
      };
    });
    expect(separation.groups).toBeGreaterThan(1);
    expect(separation.dividers).toBe(separation.groups - 1);
    expect(separation.firstIsDivided).toBe(false);
    expect(separation.laterAllDivided).toBe(true);
    // The open picker never pushes the viewport sideways — it is the 390 px
    // touch run that this protects.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureScreenshot(page, info, `worktree-ui-${label}-selector`);
    await page.emulateMedia({ colorScheme: "dark" });
    await captureScreenshot(page, info, `worktree-ui-${label}-selector-dark`);
    // The repository band has to separate from the menu it sits in under
    // BOTH schemes: the dark palette collapses several surface tiers onto
    // one value, so a band painted with the wrong token vanishes there.
    const bandColours = async () => page.evaluate(() => {
      const menu = document.querySelector("#hub-menu") as HTMLElement;
      const header = menu.querySelector(".hub-menu-group") as HTMLElement;
      return { band: getComputedStyle(header).backgroundColor, menu: getComputedStyle(menu).backgroundColor };
    });
    const darkBand = await bandColours();
    expect(darkBand.band).not.toBe(darkBand.menu);
    await page.emulateMedia({ colorScheme: "light" });
    const lightBand = await bandColours();
    expect(lightBand.band).not.toBe(lightBand.menu);
    expect(lightBand.band).not.toBe(darkBand.band);
    await page.locator(`#hub-menu a[href="/s/${parentId}/"]`).click();
    await files(page);
    await expect(page.locator('[data-item-path="NOTES.md"]')).toHaveAttribute("aria-selected", "true");
    await page.goBack();
    await files(page);
    await expect(page.locator('[data-item-path="CHILD.md"]')).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await files(page);
    await expect(page.locator('[data-item-path="NOTES.md"]')).toHaveAttribute("aria-selected", "true");

    // --- Existing branch --------------------------------------------------
    await git(parent.path, ["branch", "existing/dialog"]);
    await fork(page, parentId, "Existing branch");
    await expect(dialog).toContainText(`Existing branch · ${parentId}`);
    await expect(dialog.locator("[name=branch]")).toHaveCount(0);
    // Nothing is committed for the user in existing mode.
    await expect(dialog.locator("[name=selection]")).toHaveValue("");
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
    // Decision C: the full local+remote list is there, expanded, the moment
    // the view opens — nothing has to be typed to see a branch.
    await expect(dialog.getByRole("option")).not.toHaveCount(0);
    await expect(dialog.locator('[role="listbox"]')).toBeVisible();
    // Decision F7: a branch another checkout already holds is not offered at
    // all, so the Hub's "already checked out" refusal (kept as the backstop)
    // is unreachable from here. `main` belongs to the main checkout and
    // `feature/dialog` to the worktree created above; `existing/dialog` has
    // no checkout and is offered.
    await expect(dialog.locator('[role="option"][data-value="local:main"]')).toHaveCount(0);
    await expect(dialog.locator('[role="option"][data-value="local:feature/dialog"]')).toHaveCount(0);
    await expect(dialog.locator('[role="option"][data-value="local:existing/dialog"]')).toHaveCount(1);
    await captureScreenshot(page, info, `worktree-ui-${label}-existing-list`);
    // Choosing one — by tap in touch mode — commits it and enables Create.
    const chosen = dialog.getByRole("option", { name: "existing/dialog Local", exact: true });
    if (touch) await chosen.tap(); else await chosen.click();
    await expect(dialog.locator("[name=selection]")).toHaveValue("local:existing/dialog");
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-worktree-confirmation]")).toContainText("Created existing/dialog");
    expect((await rowFor(page, parentId, "existing/dialog")).ownership).toBe("uatu");

    // F7's boundary: the very branches Existing refuses to list are still
    // perfectly good BASES in New branch / worktree, whose Create from list
    // is deliberately unfiltered.
    await fork(page, parentId, "New branch / worktree");
    // Read by attribute: New mode commits its initial base, which collapses
    // the list, so a role query would find nothing either way.
    await expect(dialog.locator('[role="option"][data-value="local:main"]')).toHaveCount(1);
    await expect(dialog.locator('[role="option"][data-value="local:feature/dialog"]')).toHaveCount(1);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  test("explicit fetch, registering a tree Git already lists, and a missing path", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parent = hub.workspaces.find(workspace => workspace.id === parentId)!;
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));

    // A real remote: a local bare repository, so a fetch is a real fetch
    // with no network and no credential.
    const remote = path.join(path.dirname(parent.path), `${parentId}-remote.git`);
    await rm(remote, { recursive: true, force: true });
    await git(path.dirname(parent.path), ["init", "--bare", "--initial-branch=main", remote]);
    await git(parent.path, ["remote", "add", "origin", remote]);
    await git(parent.path, ["push", "-q", "origin", "main"]);

    await page.goto(`${hub.origin}/s/${parentId}/`);
    await fork(page, parentId, "New branch / worktree");
    const dialog = page.getByRole("dialog");
    // Opening never fetches: the remote branch pushed above is not listed yet.
    await expect(dialog.locator('[role="option"][data-value="remote:origin/main"]')).toHaveCount(0);
    await dialog.getByLabel("Name", { exact: true }).fill("feature/fetched");
    await dialog.getByRole("button", { name: "Fetch remote branches", exact: true }).click();
    // The draft survives the fetch exactly: name and the committed choice.
    await expect(dialog.locator('[role="option"][data-value="remote:origin/main"]')).toHaveCount(1);
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("feature/fetched");
    await expect(dialog.locator("[name=selection]")).toHaveValue("local:main");
    await captureScreenshot(page, info, `worktree-ui-${label}-fetched`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Cancelling mutates nothing.
    expect((await inventoryOf(page, parentId)).checkouts.some(checkout => checkout.branch === "feature/fetched")).toBe(false);

    // --- an external tree, created outside Uatu ---------------------------
    const external = path.join(path.dirname(parent.path), `${parentId}-agent`);
    await git(parent.path, ["worktree", "add", "-b", "agent/outside", external, "main"]);
    await expect.poll(async () => (await inventoryOf(page, parentId)).checkouts.some(checkout => checkout.branch === "agent/outside")).toBe(true);
    const discovered = await rowFor(page, parentId, "agent/outside");
    // Discovery never registers or opens anything by itself.
    expect(discovered.registered).toBe(false);
    expect(discovered.ownership).toBe("external");

    // F7: the occupied branch is not offered at all — searching for it finds
    // nothing, so the dialog can no longer reach the occupancy refusal.
    await fork(page, parentId, "Existing branch");
    await dialog.getByRole("combobox").fill("agent/outside");
    await expect(dialog.locator('[role="option"][data-value="local:agent/outside"]')).toHaveCount(0);
    await expect(dialog.locator("[data-branch-empty]")).toBeVisible();
    await captureScreenshot(page, info, `worktree-ui-${label}-conflict`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The Hub's own occupancy refusal is untouched behind it — the backstop
    // any non-dialog caller still meets: a 200 carrying the actionable
    // reason and the conflicting checkout, having changed nothing.
    const refusal = await page.evaluate(async (source: string) => {
      const response = await fetch("/api/hub/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceWorkspaceId: source, mode: "existing-local", base: { kind: "local", ref: "agent/outside" } }),
      });
      return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: { message?: string; conflictCheckoutId?: string } } };
    }, parentId);
    expect(refusal.status).toBe(200);
    expect(refusal.body.ok).toBe(false);
    expect(refusal.body.error?.message ?? "").toContain("already checked out");
    expect((await rowFor(page, parentId, "agent/outside")).registered).toBe(false);

    // Registration is reached where it belongs: the fork menu's register
    // list, which is the one place an unregistered checkout is acted on.
    await fork(page, parentId, "Register worktree…");
    await dialog.locator(".wt-card").filter({ hasText: "agent/outside" })
      .getByRole("button", { name: "Register workspace", exact: true }).click();
    await expect(dialog).toContainText("Registration does not move files, transfer cleanup ownership or copy conversations.");
    await expect(dialog).toContainText("inherited live");
    await dialog.getByRole("button", { name: "Register workspace", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-worktree-confirmation]")).toContainText("Registered agent/outside");
    const registered = await rowFor(page, parentId, "agent/outside");
    expect(registered.registered).toBe(true);
    // Registration moved nothing and claimed no cleanup ownership.
    expect(registered.path).toBe(external);
    expect(registered.ownership).toBe("external");

    // --- the path disappears ---------------------------------------------
    await git(parent.path, ["worktree", "remove", external]);
    await expect.poll(async () => (await rowFor(page, parentId, "agent/outside")).availability).toBe("missing");
    await page.reload();
    await picker(page);
    const missing = page.locator(`#hub-menu a[data-workspace-id="${registered.workspaceId}"]`);
    await expect(missing).toContainText("Missing checkout");
    await expect(missing).toHaveAttribute("aria-disabled", "true");

    // The dashboard's own row offers a re-read and no rebuild.
    const before = (await inventoryOf(page, parentId)).checkouts.length;
    await page.goto(`${hub.origin}/`);
    await dashboard(page);
    const missingRow = page.locator(`[data-workspace="${registered.workspaceId}"]`);
    await expect(missingRow).toContainText("Nothing will be recreated.");
    await missingRow.getByRole("button", { name: "Retry refresh", exact: true }).click();
    await expect(missingRow).toContainText("Nothing will be recreated.");
    expect(existsSync(external)).toBe(false);
    expect((await inventoryOf(page, parentId)).checkouts).toHaveLength(before);
    await captureScreenshot(page, info, `worktree-ui-${label}-missing`);
    expect(errors).toEqual([]);
    await page.close();
  });

  test("guarded deletion, its blocker, and Remove from Uatu, from the dashboard", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parent = hub.workspaces.find(workspace => workspace.id === parentId)!;
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${hub.origin}/s/${parentId}/`);

    for (const branch of ["delete/clean", "delete/dirty", "delete/forget"]) {
      await fork(page, parentId, "New branch / worktree");
      await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill(branch);
      await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("[data-worktree-confirmation]")).toContainText(`Created ${branch}`);
    }
    const clean = await rowFor(page, parentId, "delete/clean");
    const dirty = await rowFor(page, parentId, "delete/dirty");
    const forgotten = await rowFor(page, parentId, "delete/forget");

    // The SAME dialog module, from the Hub dashboard this time.
    await page.goto(`${hub.origin}/`);
    await dashboard(page);
    const dialog = page.getByRole("dialog");
    const row = (id: string) => page.locator(`[data-workspace="${id}"]`);

    // --- a stopped, clean checkout ---------------------------------------
    await row(clean.workspaceId!).getByRole("button", { name: "Delete worktree", exact: true }).click();
    await expect(dialog).toContainText("Delete worktree?");
    await expect(dialog).toContainText(`${parentId} / delete/clean`);
    await expect(dialog).toContainText("The worktree’s files will be removed. The Git branch will be kept.");
    await expect(dialog).not.toContainText(clean.path);
    await captureScreenshot(page, info, `worktree-ui-${label}-delete-stopped`);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-worktree-confirmation]")).toContainText("Worktree deleted. Branch kept.");
    expect(existsSync(clean.path)).toBe(false);
    // The branch always survives.
    expect(await git(parent.path, ["branch", "--list", "delete/clean"])).toContain("delete/clean");

    // --- a running checkout asks to stop first ----------------------------
    const startResponse = await page.request.post(`/api/hub/sessions/${encodeURIComponent(forgotten.workspaceId!)}/start`);
    expect(startResponse.ok()).toBe(true);
    await page.reload();
    await dashboard(page);

    // F8: on the dashboard too, a child shares the main checkout row's left
    // edge — the Active-groups repository heading and the `Main checkout`
    // chip above already place it, so nothing is inset or drawn as a tree.
    // Both rows are siblings inside the same repository section, so any
    // wrapper offset applies to both and only the inset can differ.
    const mainTitleBox = (await row(parentId).locator(".row-title").first().boundingBox())!;
    const childTitleBox = (await row(forgotten.workspaceId!).locator(".row-title").first().boundingBox())!;
    expect(Math.abs(childTitleBox.x - mainTitleBox.x)).toBeLessThan(1);
    // F9: no per-repository Configure button. It only navigated to the Hub's
    // own Settings page, which the site navigation already reaches; the
    // heading keeps Rename workspace and the fork control.
    await expect(page.getByRole("button", { name: /^Configure / })).toHaveCount(0);
    const heading = page.locator(`.dashboard-group-heading[data-repository="${parentId}"], section[data-repository="${parentId}"] .dashboard-group-heading`).first();
    const headingFork = heading.locator(`[aria-label="Add worktree to ${parentId}"]`);
    await expect(headingFork).toBeVisible();
    // F10: the heading's actions end where the rows' own actions end — the
    // fork is last, on the row's trailing edge, like Open/Stop beneath it.
    await expect(heading.locator("button").last()).toHaveAttribute("aria-label", `Add worktree to ${parentId}`);
    const forkBox = (await headingFork.boundingBox())!;
    const rowActionBox = (await row(parentId).locator(".row-actions button").last().boundingBox())!;
    expect(Math.abs((forkBox.x + forkBox.width) - (rowActionBox.x + rowActionBox.width))).toBeLessThan(2);
    // F11: both surfaces draw the one sideways fork glyph.
    expect(await headingFork.locator("svg").getAttribute("viewBox")).toBe("0 0 32 20");
    // Nothing about the heading overflows a narrow viewport.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureScreenshot(page, info, `worktree-ui-${label}-dashboard-groups`);

    await row(forgotten.workspaceId!).getByRole("button", { name: "Delete worktree", exact: true }).click();
    await expect(dialog).toContainText("Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept.");
    await expect(dialog.getByRole("button", { name: "Stop and delete", exact: true })).toBeVisible();
    // No extra checkbox authorizes the stop; the destructive button does.
    await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
    await captureScreenshot(page, info, `worktree-ui-${label}-delete-running`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // --- a blocker replaces the consequences ------------------------------
    await writeFile(path.join(dirty.path, "draft.txt"), "work in progress\n");
    await row(dirty.workspaceId!).getByRole("button", { name: "Delete worktree", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("untracked files");
    await expect(dialog).not.toContainText("The Git branch will be kept.");
    await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await captureScreenshot(page, info, `worktree-ui-${label}-delete-blocked`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(existsSync(path.join(dirty.path, "draft.txt"))).toBe(true);
    expect((await rowFor(page, parentId, "delete/dirty")).registered).toBe(true);

    // --- Remove from Uatu keeps everything on disk ------------------------
    // Unregistering is a stopped-workspace action on the dashboard, exactly
    // as Remove from Hub is for an ordinary workspace.
    expect((await page.request.post(`/api/hub/sessions/${encodeURIComponent(forgotten.workspaceId!)}/stop`)).ok()).toBe(true);
    await page.reload();
    await dashboard(page);
    await row(forgotten.workspaceId!).getByRole("button", { name: `Remove ${forgotten.branch} from Uatu`, exact: true }).click();
    await expect(dialog).toContainText("Checkout, branch, files and creation provenance remain.");
    await dialog.getByRole("checkbox").check();
    await captureScreenshot(page, info, `worktree-ui-${label}-forget`);
    await dialog.getByRole("button", { name: "Remove from Uatu", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-worktree-confirmation]")).toContainText("Removed from Uatu. Checkout, branch and files were kept.");
    expect(existsSync(forgotten.path)).toBe(true);
    expect(await git(parent.path, ["branch", "--list", "delete/forget"])).toContain("delete/forget");
    const afterForget = await rowFor(page, parentId, "delete/forget");
    expect(afterForget.registered).toBe(false);
    // Deletion is never offered for a tree Uatu no longer owns a registration
    // for — and the inventory it is now discovered in is reachable.
    await expect(page.locator(`[data-workspace="${forgotten.workspaceId}"]`)).toHaveCount(0);

    // --- W10: a linked worktree registered on its own through Add
    // workspace (its .git is a FILE, so the Hub never sets createWorktree)
    // must never be chipped this repository's main checkout, and its own
    // collapsed group summary must not promise a fork it does not have. ---
    const standaloneExternal = path.join(path.dirname(parent.path), `${parentId}-standalone`);
    await rm(standaloneExternal, { recursive: true, force: true });
    await git(parent.path, ["worktree", "add", "-b", `${parentId}/standalone`, standaloneExternal, "main"]);
    const configured = await page.request.post("/api/hub/workspaces/configure", {
      data: { path: standaloneExternal, displayName: `${parentId}-standalone` },
    });
    expect(configured.ok()).toBe(true);
    const standaloneId = ((await configured.json()) as { workspace: { id: string } }).workspace.id;
    await page.reload();
    await dashboard(page);
    const standaloneRow = page.locator(`[data-workspace="${standaloneId}"]`);
    await expect(standaloneRow).toContainText("Linked checkout");
    await expect(standaloneRow.locator(".chip")).not.toContainText("Main checkout");
    const standaloneSummary = page.locator(`[data-disclosure="${standaloneId}-inactive"] summary`);
    await expect(standaloneSummary).toContainText("expand to Start");
    await expect(standaloneSummary).not.toContainText("or fork");
    await captureScreenshot(page, info, `worktree-ui-${label}-standalone-linked`);

    expect(errors).toEqual([]);
    await page.close();
  });

  test("a committed operation elsewhere refreshes the open register list without touching this page's context", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parent = hub.workspaces.find(workspace => workspace.id === parentId)!;
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${hub.origin}/s/${parentId}/`);
    await files(page);
    await page.locator('[data-item-path="NOTES.md"]').click();

    // A tree Git lists and Uatu does not: the only state the picker and the
    // dashboard cannot show, and the whole content of the fork menu's third
    // item, "Register worktree…".
    const external = path.join(path.dirname(parent.path), `${parentId}-live-agent`);
    await rm(external, { recursive: true, force: true });
    await git(parent.path, ["worktree", "add", "-b", "live/outside", external, "main"]);
    await expect.poll(async () => (await inventoryOf(page, parentId)).checkouts.some(checkout => checkout.branch === "live/outside")).toBe(true);

    await fork(page, parentId, "Register worktree…");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Register worktree", exact: true })).toHaveCount(1);
    await expect(dialog).toContainText("live/outside");
    // Decision A: a tree Uatu did not create is labelled for what it is.
    await expect(dialog).toContainText("External worktree");
    await expect(dialog).not.toContainText("origin unknown");
    // Decision B: no general inventory — no Refresh/Create toolbar, no main
    // checkout row, no already-registered child.
    await expect(dialog.getByRole("button", { name: "Refresh inventory" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Create worktree" })).toHaveCount(0);
    await expect(dialog).not.toContainText("Main checkout");
    const registeredChild = await page.request.post("/api/hub/worktrees/create", {
      data: { sourceWorkspaceId: parentId, mode: "new-branch", branch: "live/registered", baseRef: "main" },
    });
    expect((await registeredChild.json()).ok).toBe(true);
    await expect(dialog).not.toContainText("live/registered");
    // An externally created tree is listed with Register workspace — never
    // opened or registered automatically.
    const externalCard = dialog.locator("[data-workspace]", { hasText: "live/outside" });
    await expect(externalCard.getByRole("button", { name: "Register workspace", exact: true })).toBeVisible();
    // Card layout: branch first, with the path truncated to a titled, muted
    // monospace line.
    await expect(externalCard.locator(".wt-card-path")).toHaveAttribute("title", external);
    await captureScreenshot(page, info, `worktree-ui-${label}-register-list`);

    // Something outside Uatu adds another checkout: the open list picks it up
    // on this page's own live stream, with no reload and no navigation.
    const second = path.join(path.dirname(parent.path), `${parentId}-live-agent-2`);
    await rm(second, { recursive: true, force: true });
    await git(parent.path, ["worktree", "add", "-b", "live/second", second, "main"]);
    await expect(dialog).toContainText("live/second", { timeout: 15_000 });
    // No navigation: the page is still this workspace's own session URL.
    expect(new URL(page.url()).pathname.startsWith(`/s/${parentId}/`)).toBe(true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The document this page was showing, and the picker's own rows, are
    // exactly what they were.
    await files(page);
    await expect(page.locator('[data-item-path="NOTES.md"]')).toHaveAttribute("aria-selected", "true");
    await picker(page);
    await expect(page.locator("#hub-menu")).toContainText("live/registered");
    await captureScreenshot(page, info, `worktree-ui-${label}-live`);
    await saveEvidence(info, `worktree-ui-${label}.json`, JSON.stringify({
      realHub: true, realGit: true, viewport: touch ? "390x844 touch" : "1440x1000 desktop",
      dialogEntryPoints: ["in-workspace picker", "Hub dashboard"],
      liveInvalidationRefreshedOpenRegisterList: true, contextPreserved: true,
    }, null, 2));
    expect(errors).toEqual([]);
    await page.close();
  });
});


// Decision F6 (2026-09-19, second round): the user's phone showed a picker
// taller than the screen — beacon's children and Sign out below the fold,
// with nothing to scroll. In touch mode the menu lives inside a fullscreen
// `overflow: hidden` Files pane pinned above the tab bar, so the overflow was
// not merely off-screen, it was unreachable. The menu is bounded to what is
// visible and scrolls itself.
test.describe("the workspace picker on a phone-sized viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a picker taller than the screen scrolls, and Sign out stays reachable", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parentId = "orbit-touch";
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${hub.origin}/s/${parentId}/`);
    await ready(page);

    // Enough checkouts that the menu cannot fit, created through the same
    // published family the UI uses — from the page, so the request carries
    // the hub cookie and its own Origin.
    const created = await page.evaluate(async (source: string) => {
      const results: boolean[] = [];
      for (const branch of Array.from({ length: 14 }, (_, index) => `overflow/${String(index + 1).padStart(2, "0")}`)) {
        const response = await fetch("/api/hub/worktrees/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceWorkspaceId: source, mode: "new-branch", branch, base: { kind: "local", ref: "main" }, start: false }),
        });
        results.push(((await response.json()) as { ok?: boolean }).ok === true);
      }
      return results;
    }, parentId);
    expect(created.every(Boolean)).toBe(true);

    await page.reload();
    await picker(page);
    const menu = page.locator("#hub-menu");
    const viewport = page.viewportSize()!;
    const metrics = await menu.evaluate(node => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      top: node.getBoundingClientRect().top,
      overflowY: getComputedStyle(node).overflowY,
    }));
    // The fixture really does overflow — otherwise this proves nothing.
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflowY).toBe("auto");
    // …and what is shown fits on the screen, above the tab bar.
    expect(metrics.clientHeight).toBeLessThanOrEqual(viewport.height);
    const tabBarTop = await page.locator(".touch-tab-bar").evaluate(node => node.getBoundingClientRect().top);
    expect(metrics.top + metrics.clientHeight).toBeLessThanOrEqual(tabBarTop + 1);

    // The group bands, the dividers and both fixed entries survive.
    await expect(menu.locator(".hub-menu-group")).not.toHaveCount(0);
    await expect(menu.getByText("Hub dashboard", { exact: true })).toHaveCount(1);

    // Scrolling the menu to its end brings Sign out into view, on screen and
    // actually hittable rather than merely painted under something else.
    await menu.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const signOut = menu.getByText("Sign out", { exact: true });
    await expect(signOut).toBeInViewport();
    const hittable = await signOut.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return at !== null && (node === at || node.contains(at) || at.contains(node));
    });
    expect(hittable).toBe(true);
    // Nothing about the bounded menu pushes the 390 px viewport sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureScreenshot(page, info, "worktree-ui-touch-selector-scrolled");

    expect(errors).toEqual([]);
    await page.close();
  });
});
