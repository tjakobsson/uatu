// The workspace switcher through a real Hub (add-workspace-switcher; the
// ux-loop probes round2-checks, r8-picker, r9-probe items 9 and 12, r3-hits'
// landscape switcher and sw-shots, ported): the desktop chip and touch
// mode's fifth button, the status card, Viewing and Back with the Viewing
// strip, one search over both lists, Checkouts grouped by repository,
// `Pull requests · octo-org/uatu` with its filter menu and Show all, the
// view-or-check-out choice and Go to its worktree, the keyboard (the
// combobox, Escape's steps, focus return), and touch and landscape layouts.
//
// Two workspaces, each its own Git repository (atlas and beacon), with
// stopped linked worktrees made through the Hub's worktree API; the
// children serve the in-memory GitHub fake (src/github/fake.ts), whose #636
// is on branch fix/pane-heights. Creating a pull request's worktree is
// pull-request-worktree.e2e.ts's. Nothing reaches GitHub.

import type { Locator, Page } from "@playwright/test";

import { captureScreenshot } from "./evidence";
import { expect, openHubMenu, test, type HubE2EInfo } from "./hub-fixtures";
import { centreMiss, expectTouchTarget, focusedElement, tapCentre } from "./pull-request-helpers";

test.use({ hubWorktrees: true, hubGithubFake: true, hubWorkspaces: ["atlas", "beacon"] });

const WORKTREES = [["atlas", "feature/alpha"], ["atlas", "fix/pane-heights"], ["beacon", "feat/search"]] as const;

// The linked worktrees the lists show, made once per worker (the Hub's
// registry outlives a test's reset), stopped.
async function ensureWorktrees(page: Page): Promise<void> {
  for (const [source, branch] of WORKTREES) {
    const inventory = await page.request.get(`/api/hub/worktrees?source=${source}`).then(answer => answer.json()) as { inventory: { checkouts: { branch: string | null }[] } };
    if (inventory.inventory.checkouts.some(checkout => checkout.branch === branch)) continue;
    const created = await page.evaluate(async ({ source, branch }) => {
      const response = await fetch("/api/hub/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceWorkspaceId: source, mode: "new-branch", branch, base: { kind: "local", ref: "main" }, start: false }),
      });
      return (await response.json() as { ok?: boolean }).ok === true;
    }, { source, branch });
    expect(created, `worktree ${branch} in ${source}`).toBe(true);
  }
}

// atlas's session, connected, with the worktrees listed.
async function openAtlas(hub: HubE2EInfo, page: Page): Promise<void> {
  await page.goto(`${hub.origin}/s/atlas/`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await ensureWorktrees(page);
}

const menu = (page: Page) => page.locator("#hub-menu");
const search = (page: Page) => page.locator("#switcher-search");
const step = (page: Page) => page.locator("#switcher-step");
const checkoutRows = (page: Page) => page.locator("#switcher-checkouts [role=option]");
const prRows = (page: Page) => page.locator("#switcher-pull-requests [role=option]");
const lineOne = (rows: Locator) => rows.locator(".switcher-row-line1").allInnerTexts().then(texts => texts.map(text => text.replace(/\s+/g, " ").trim()));

async function openSwitcher(page: Page): Promise<void> {
  await openHubMenu(page);
  await expect(prRows(page).first()).toBeVisible();
}

async function choosePullRequest(page: Page, number: number): Promise<void> {
  await search(page).fill(String(number));
  await page.locator(`#switcher-pull-requests [data-pr-row="${number}"]`).click();
  await expect(step(page)).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("the chip names where you work; the dialog holds the status card, Checkouts by repository, and Pull requests · octo-org/uatu", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    await page.reload();
    const chip = page.locator("#hub-toggle");
    await expect(chip).toHaveAccessibleName("Switch. Working in atlas, main.");
    await expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    await openSwitcher(page);
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(menu(page)).toHaveAttribute("role", "dialog");
    await expect(page.locator("#switcher-status")).toHaveText(/Working in\s*atlas\s*·\s*main/);

    // Checkouts: one labelled group per repository, this one first; the
    // checkout you are in is the status card, not a row.
    const groups = page.locator("#switcher-checkouts > .switcher-repo-group");
    await expect(groups).toHaveCount(2);
    await expect(groups.locator(".switcher-repo-heading")).toHaveText(["atlas", "beacon"]);
    for (const group of await groups.all()) {
      await expect(group).toHaveAttribute("role", "group");
      await expect(group).toHaveAttribute("aria-label", (await group.locator(".switcher-repo-heading").innerText()).trim());
    }
    // A pull request's checkout is named by its pull request.
    expect(await lineOne(groups.nth(0).locator("[role=option]"))).toEqual(["feature/alpha", "#636 fix(sidebar): restore pane heights after reload"]);
    expect(await lineOne(groups.nth(1).locator("[role=option]"))).toEqual(["beacon", "feat/search"]);
    await expect(groups.nth(0).locator('[data-workspace-id="feature-alpha"]')).toHaveAccessibleName("feature/alpha, Stopped. Start and go to checkout");

    // Pull requests: the repository named, the first three, then Show all.
    await expect(page.locator("#switcher-pull-requests-heading")).toHaveText(/^Pull requests\s*·\s*octo-org\/uatu$/);
    await expect(prRows(page)).toHaveCount(3);
    const showAll = page.locator("[data-switcher-show-all]");
    await expect(showAll).toHaveText("Show all 6");
    await showAll.click();
    await expect(prRows(page)).toHaveCount(6);
    // The footer: the Hub's pages; Sign out lives there, not here.
    await expect(page.locator("#switcher-footer").getByRole("link", { name: "Hub dashboard" })).toHaveAttribute("href", "/");
    await expect(menu(page).getByText("Sign out", { exact: true })).toHaveCount(0);
    await captureScreenshot(page, testInfo, "switcher-desktop-open");
  });

  test("one search over both lists: a repository's name, a branch word, a number; and no lookups while typing", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    await openSwitcher(page);

    await search(page).fill("beacon");
    await expect(page.locator("#switcher-checkouts .switcher-repo-heading")).toHaveText(["beacon"]);
    expect(await lineOne(checkoutRows(page))).toEqual(["beacon", "feat/search"]);
    await expect(prRows(page)).toHaveCount(0);

    await search(page).fill("feat");
    expect(await lineOne(checkoutRows(page))).toEqual(["feature/alpha", "feat/search"]);
    await expect(page.locator('#switcher-pull-requests [data-pr-row="642"]')).toBeVisible();

    await search(page).fill("639");
    await expect(checkoutRows(page)).toHaveCount(0);
    await expect(prRows(page)).toHaveCount(1);
    await expect(page.locator('#switcher-pull-requests [data-pr-row="639"]')).toBeVisible();

    // A number not in the open list is looked up once, after typing settles.
    await search(page).fill("");
    const lookups: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/api/github/pull-request")) lookups.push(url.searchParams.get("number") ?? "?");
    });
    await search(page).pressSequentially("630", { delay: 60 });
    await expect(page.locator("#switcher-pr-notes")).toContainText("#630");
    expect(lookups.every(number => number === "630"), `lookups: ${lookups.join(", ")}`).toBe(true);
    await search(page).fill("");
    await expect(checkoutRows(page)).toHaveCount(4);
  });

  test("the filter menu: Open ▾ lists four choices; Mine and Review requested narrow the list; the choice is named on the toggle", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    await openSwitcher(page);
    const toggle = page.locator('[data-switcher-menu-toggle="filter"]');
    await expect(toggle).toHaveAccessibleName("Filter: Open");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const choices = page.locator('[data-switcher-menu="filter"] [role=menuitemradio]');
    await expect(choices).toHaveText(["Open", "Review requested", "Mine", "Drafts"]);
    await expect(choices.first()).toHaveAttribute("aria-checked", "true");
    await choices.filter({ hasText: "Mine" }).click();
    await expect(toggle).toHaveAccessibleName("Filter: Mine");
    await expect(toggle).toBeFocused();
    // #627 is octo-reviewer's, the fake's viewer.
    await expect(prRows(page)).toHaveCount(1);
    await expect(page.locator('#switcher-pull-requests [data-pr-row="627"]')).toBeVisible();
    await toggle.click();
    await choices.filter({ hasText: "Review requested" }).click();
    await expect(toggle).toHaveAccessibleName("Filter: Review requested");
    for (const row of await prRows(page).all()) await expect(row).toHaveAccessibleName(/your review requested/);
  });

  test("View here shows the pull request: the chip and the status card say Viewing, and Back returns Files and Preview to the branch's own", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    await openSwitcher(page);
    await choosePullRequest(page, 639);
    const view = step(page).getByRole("button", { name: "View #639 here" });
    await expect(view).toBeFocused();
    await expect(step(page)).toContainText("Terminal and agent stay on main");
    await expect(step(page).getByRole("button", { name: "Check out #639 as a worktree…" })).toBeVisible();
    await view.click();
    await expect(menu(page)).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get("pr")).toBe("639");
    await expect(page.locator("#preview-title")).toHaveText("fix(terminal): keep OSC 8 links across reflow");
    const chip = page.locator("#hub-toggle");
    await expect(chip).toHaveAccessibleName("Switch. Working in atlas, main. Viewing pull request 639.");
    const viewing = page.locator("#switcher-chip-viewing");
    await expect(viewing).toContainText("Viewing #639");
    await expect(viewing.getByRole("button", { name: "Back to main" })).toBeVisible();
    await captureScreenshot(page, testInfo, "switcher-desktop-viewing");

    await openSwitcher(page);
    await expect(page.locator("#switcher-status")).toContainText("Viewing");
    await expect(page.locator("#switcher-status")).toContainText("#639");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();

    // Back: the checkout's own pull request (the fake's #642) again.
    await viewing.getByRole("button", { name: "Back to main" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("pr")).toBe("642");
    await expect(viewing).toBeHidden();
    await expect(chip).toHaveAccessibleName("Switch. Working in atlas, main.");
    await expect(page.locator("#preview-path")).toHaveText("#642 · octo-org/uatu");
    // The chip's Back gives focus back to the chip.
    await expect(chip).toBeFocused();
  });

  test("a pull request already checked out offers Go to its worktree first", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    await page.reload();
    await openSwitcher(page);
    await search(page).fill("636");
    const row = page.locator('#switcher-pull-requests [data-pr-row="636"]');
    await expect(row).toHaveAccessibleName(/Checked out/);
    await row.click();
    const first = step(page).locator("[data-choice]").first();
    await expect(first).toHaveAttribute("aria-label", "Go to its worktree, fix/pane-heights");
    await expect(first).toBeFocused();
  });

  test("the keyboard: Enter opens on the combobox, arrows move through both lists, Escape steps back then closes onto the chip", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    const chip = page.locator("#hub-toggle");
    await chip.focus();
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/hub/state");
    await page.keyboard.press("Enter");
    await refreshed;
    await expect(menu(page)).toBeVisible();
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveAttribute("role", "combobox");
    await expect(search(page)).toHaveAttribute("aria-controls", "switcher-checkouts switcher-pull-requests");
    await expect(prRows(page).first()).toBeVisible();
    // Down through the four checkouts into the pull requests.
    const expected = ["switcher-checkout-feature-alpha", "switcher-checkout-fix-pane-heights", "switcher-checkout-beacon", "switcher-checkout-feat-search", "switcher-pr-642", "switcher-pr-639"];
    for (const id of expected) {
      await page.keyboard.press("ArrowDown");
      await expect(search(page)).toHaveAttribute("aria-activedescendant", id);
      await expect(page.locator(`#${id}`)).toHaveAttribute("aria-selected", "true");
    }
    await page.keyboard.press("ArrowUp");
    await expect(search(page)).toHaveAttribute("aria-activedescendant", "switcher-pr-642");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(step(page).getByRole("button", { name: "View #639 here" })).toBeFocused();
    // Escape steps back to the lists, where it was…
    await page.keyboard.press("Escape");
    await expect(step(page)).toBeHidden();
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveAttribute("aria-activedescendant", "switcher-pr-639");
    // …and then closes, back onto the chip.
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    await expect(chip).toBeFocused();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  test("Tab stays inside the dialog", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    await openSwitcher(page);
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press(index % 5 === 4 ? "Shift+Tab" : "Tab");
      expect(await (await focusedElement(page)).inside("#hub-menu"), `focus after ${index + 1} Tab presses`).toBe(true);
    }
  });
});

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the fifth button, outside the tablist, opens the sheet; every row is tall and taken at its centre", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    const button = page.locator("#switcher-button");
    await expect(button).toBeVisible();
    expect(await button.evaluate(element => element.closest("#touch-tab-bar") !== null && element.closest("[role=tablist]") === null)).toBe(true);
    await expect(button).toHaveAttribute("aria-haspopup", "dialog");
    await expectTouchTarget(button, "the switcher button");
    await openHubMenu(page, { tap: true });
    await expect(prRows(page).first()).toBeVisible();
    for (const row of await page.locator("#hub-menu .switcher-row").all()) {
      await row.evaluate(element => element.scrollIntoView({ block: "nearest" }));
      const box = (await row.boundingBox())!;
      expect(box.height, `${(await row.innerText()).split("\n")[0]} is ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(54);
      expect(await centreMiss(row)).toBeNull();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, testInfo, "switcher-touch-open");
  });

  test("View here on a phone: the Viewing strip tops Files and Preview with a 44px Back, and Back takes it away", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    await openHubMenu(page, { tap: true });
    await expect(prRows(page).first()).toBeVisible();
    await choosePullRequest(page, 639);
    await tapCentre(page, step(page).getByRole("button", { name: "View #639 here" }));
    await expect(menu(page)).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get("pr")).toBe("639");
    await expect(page.locator("#switcher-button")).toHaveAccessibleName(/Viewing pull request 639/);

    await page.locator("#touch-tab-preview").click();
    const strip = page.locator("#viewing-strip-preview");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Viewing #639");
    const back = strip.locator("[data-switcher-back]");
    await expectTouchTarget(back, "Back", { width: 44, height: 44 });
    const layout = await strip.evaluate(element => {
      const box = element.getBoundingClientRect();
      const title = document.querySelector<HTMLElement>("#preview-title")!.getBoundingClientRect();
      const label = element.querySelector<HTMLElement>(".viewing-label")!;
      const backBox = element.querySelector<HTMLElement>("[data-switcher-back]")!.getBoundingClientRect();
      return { above: box.bottom <= title.top + 0.5, fullWidth: box.left <= 0 && box.right >= innerWidth, labelWhole: label.scrollWidth <= label.clientWidth + 1, apart: label.getBoundingClientRect().right <= backBox.left };
    });
    expect(layout).toEqual({ above: true, fullWidth: true, labelWhole: true, apart: true });
    await captureScreenshot(page, testInfo, "switcher-touch-viewing-strip");

    await page.locator("#touch-tab-files").click();
    const filesStrip = page.locator("#viewing-strip-files");
    await expect(filesStrip).toBeVisible();
    await tapCentre(page, filesStrip.locator("[data-switcher-back]"));
    await expect.poll(() => new URL(page.url()).searchParams.get("pr")).toBe("642");
    await expect(filesStrip).toBeHidden();
    // The Files tab's Back gives focus to the workspace's tree.
    await expect.poll(async () => (await focusedElement(page)).inside('[data-pane-id="files"]')).toBe(true);
    await page.locator("#touch-tab-preview").click();
    await expect(strip).toBeHidden();
  });

  for (const width of [390, 320]) {
    test(`the Pull requests filter at ${width}px: the toggle and each choice whole inside the sheet, 44px and taken`, async ({ hub, hubContext }) => {
      const page = await hubContext.newPage();
      await page.setViewportSize({ width, height: 844 });
      await openAtlas(hub, page);
      await openHubMenu(page, { tap: true });
      await expect(prRows(page).first()).toBeVisible();
      const toggle = page.locator('#hub-menu [data-switcher-menu-toggle="filter"]');
      await tapCentre(page, toggle);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const sheet = (await menu(page).boundingBox())!;
      for (const control of [toggle, ...await page.locator("#hub-menu [data-switcher-filter]").all()]) {
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(sheet.x - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width + 0.5);
        await expectTouchTarget(control, (await control.innerText()).trim(), { width: 0, height: 44 });
      }
    });
  }

  test("repository headings stay pinned at the top of the scrolling lists", async ({ hub, hubContext }) => {
    const page = await hubContext.newPage();
    await page.setViewportSize({ width: 390, height: 600 });
    await openAtlas(hub, page);
    await openHubMenu(page, { tap: true });
    await expect(prRows(page).first()).toBeVisible();
    await page.locator("[data-switcher-show-all]").click();
    const sticky = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("#hub-menu .switcher-scroll")!;
      const group = document.querySelectorAll<HTMLElement>("#switcher-checkouts > .switcher-repo-group")[1]!;
      scroller.scrollTop += group.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 12;
      const heading = group.querySelector<HTMLElement>(".switcher-repo-heading")!.getBoundingClientRect();
      const top = scroller.getBoundingClientRect().top;
      return {
        scrolledPast: group.getBoundingClientRect().top < top,
        atTop: Math.abs(heading.top - top) <= 1,
        onTop: Boolean(document.elementFromPoint(heading.left + 20, heading.top + heading.height / 2)?.closest(".switcher-repo-heading")),
      };
    });
    expect(sticky).toEqual({ scrolledPast: true, atTop: true, onTop: true });
  });
});

test.describe("touch landscape", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("the sheet is two columns whose lists scroll, the sheet itself never does, and every control is 44px and taken", async ({ hub, hubContext }, testInfo) => {
    const page = await hubContext.newPage();
    await openAtlas(hub, page);
    await openHubMenu(page, { tap: true });
    await expect(prRows(page).first()).toBeVisible();
    const shape = await page.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>("#hub-menu")!;
      const lists = sheet.querySelector<HTMLElement>(".switcher-scroll")!.getBoundingClientRect();
      const status = sheet.querySelector<HTMLElement>("#switcher-status")!.getBoundingClientRect();
      const whole = [...sheet.querySelectorAll<HTMLElement>("#switcher-pull-requests [role=option]")].filter(row => {
        const box = row.getBoundingClientRect();
        return box.top >= lists.top - 0.5 && box.bottom <= lists.bottom + 0.5;
      }).length;
      return { twoColumns: lists.left > status.right - 1, sheetScrolls: sheet.scrollHeight > sheet.clientHeight + 1, lists: lists.height, wholePullRequests: whole };
    });
    expect(shape.twoColumns).toBe(true);
    expect(shape.sheetScrolls).toBe(false);
    expect(shape.lists).toBeGreaterThanOrEqual(100);
    const controls = page.locator("#hub-menu").locator("button, input, a[href], [role=option]");
    for (const control of await controls.all()) {
      if (!(await control.isVisible())) continue;
      await expectTouchTarget(control, (await control.getAttribute("aria-label")) ?? (await control.innerText()).trim().slice(0, 24), { width: 0, height: 44 });
    }
    await captureScreenshot(page, testInfo, "switcher-touch-landscape");
    // Scrolled to its Pull requests, three whole rows fit.
    await page.locator("#switcher-pull-requests-section").evaluate(section => section.scrollIntoView({ block: "start" }));
    const whole = await page.evaluate(() => {
      const lists = document.querySelector<HTMLElement>("#hub-menu .switcher-scroll")!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>("#switcher-pull-requests [role=option]")].filter(row => {
        const box = row.getBoundingClientRect();
        return box.top >= lists.top - 0.5 && box.bottom <= lists.bottom + 0.5;
      }).length;
    });
    expect(whole).toBeGreaterThanOrEqual(3);
  });
});
