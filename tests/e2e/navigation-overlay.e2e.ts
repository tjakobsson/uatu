import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { openNavigationPreferences, showSurface } from "./navigation-helpers";
import { test as hubTest, loginHub, hubPost } from "./hub-mobile-fixtures";

// Bun's development loader itself requires sessionStorage. Exercise production
// delivery for storage-denial acceptance, including when this file runs alone.
test.use({ productionServer: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function boot(page: Page): Promise<void> {
  const { token } = await page.request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await expect(page.locator("#preview")).toBeVisible();
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
}

async function freeze(page: Page): Promise<void> {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 100));
}

// The approved design's bar is close + Hub + the four surfaces, with no
// Preferences button, so the sheet is reached by holding the handle. This
// exercises the real press timer rather than dispatching the event directly.
async function preferences(page: Page): Promise<void> {
  await openNavigationPreferences(page);
}

test("four persistent surfaces, conditional action and no reserved gutter", async ({ page }) => {
  await boot(page);
  await expect(page.getByRole("tablist", { name: "App surfaces" }).getByRole("tab")).toHaveCount(4);
  await expect(page.locator("#navigation-hub")).toBeHidden();
  // No Preferences button in the bar, in either mode.
  await expect(page.locator("#navigation-preferences")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveCSS("padding-bottom", "0px");
  await page.locator("#touch-tab-files").click();
  const bottom = await page.locator(".sidebar").evaluate(element => element.getBoundingClientRect().bottom);
  expect(bottom).toBe(844);
  await page.locator("#touch-tab-preview").click();
  await expect(page.locator(".sidebar")).toHaveCount(1);
  await expect(page.locator("#chat-surface")).toHaveCount(1);
  await expect(page.locator("#terminal-panel")).toHaveCount(1);
  await expect(page.locator("#touch-tab-preview")).toHaveAttribute("aria-selected", "true");
});

test("ready idle interval resets on selection, not pointer hover", async ({ page }) => {
  await boot(page);
  await freeze(page);
  await page.locator("#touch-tab-preview").click();
  await page.clock.runFor(6000);
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
  await page.locator("#touch-tab-files").click();
  await page.clock.runFor(6000);
  await page.locator("#touch-tab-preview").hover();
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
  await page.clock.runFor(1001);
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "false");
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("inert", "");
  await page.clock.runFor(280);
  await expect(page.locator("#touch-tab-bar")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
});

test("non-pointer focus protects navigation and Escape restores its trigger", async ({ page }) => {
  await boot(page);
  await freeze(page);
  await page.locator("#touch-tab-preview").focus();
  await page.clock.runFor(20000);
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#navigation-handle")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#touch-tab-preview")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#touch-tab-files")).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
});

test("held pointer stays protected outside bounds until release or cancellation", async ({ page }) => {
  await boot(page);
  await freeze(page);
  const control = page.locator("#touch-tab-preview");
  await control.dispatchEvent("pointerdown", { pointerId: 9, button: 0 });
  await control.dispatchEvent("pointerleave", { pointerId: 9 });
  await page.clock.runFor(20000);
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
  await page.locator("body").dispatchEvent("pointercancel", { pointerId: 9 });
  await page.clock.runFor(7001);
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "false");
});

test("content input arrives once, Keep Open suppresses outside dismissal, dialogs own Escape", async ({ page }) => {
  await page.request.post("/__e2e/chat", { data: { action: "seed", title: "Navigation draft", items: [] } });
  await boot(page);
  await preferences(page);
  await page.locator("#navigation-keep-open").check();
  await page.keyboard.press("Escape");
  await expect(page.locator("#navigation-preferences-dialog")).not.toBeVisible();
  // The sheet is reached through the handle, which exists only while the
  // navigation is collapsed, so bring it back before asserting Keep Open.
  await page.locator("#navigation-handle").click();
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
  await page.locator("#touch-tab-chat").click();
  await expect(page.locator("#chat-input")).toBeEnabled();
  await page.locator("#chat-input").fill("exactly once");
  await expect(page.locator("#chat-input")).toHaveValue("exactly once");
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
  await preferences(page);
  await page.locator("#navigation-keep-open").uncheck();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator("#navigation-handle").click();
  await page.locator("#chat-input").press("End");
  await page.keyboard.type("!");
  await expect(page.locator("#chat-input")).toHaveValue("exactly once!");
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "false");
});

test("drag commits without opening, cancellation restores committed remote placement", async ({ page, context }) => {
  await boot(page);
  await page.locator("#navigation-close").click();
  const handle = page.locator("#navigation-handle");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(370, 200, { steps: 5 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute("data-side", "right");
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "false");
  const key = "uatu:presentation:v1:%2F:navigation";
  const other = await context.newPage();
  await other.goto("/");
  const placed = (await handle.boundingBox())!;
  await page.mouse.move(placed.x + 22, placed.y + 22);
  await page.mouse.down();
  await page.mouse.move(15, 400, { steps: 5 });
  await other.evaluate(key => localStorage.setItem(key, JSON.stringify({ side: "right", position: 0.9, autoHide: true, previewSide: "right" })), key);
  await expect(handle).toHaveAttribute("data-side", "left");
  await handle.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute("data-side", "right");
  expect((await handle.boundingBox())!.y).toBeGreaterThan(650);
  await handle.focus();
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("data-side", "left");
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("data-side", "right");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => {
    const rotated = (await handle.boundingBox())!;
    return rotated.y + rotated.height;
  }).toBeLessThanOrEqual(390);
  await expect.poll(async () => {
    const rotated = (await handle.boundingBox())!;
    return rotated.x + rotated.width;
  }).toBeLessThanOrEqual(844);
  await other.close();
});

test("preferences validate corrupt values and ignore prototype keys", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("uatu:prototype:navigation", JSON.stringify({ side: "right", autoHide: false }));
    localStorage.setItem("uatu:presentation:v1:%2F:navigation", '{"side":"invalid","position":99,"autoHide":"no","previewSide":"right"}');
  });
  await boot(page);
  await preferences(page);
  await expect(page.locator("#navigation-side")).toHaveValue("left");
  await expect(page.locator("#navigation-position")).toHaveValue("100");
  await expect(page.locator("#navigation-keep-open")).not.toBeChecked();
  await expect(page.locator("#navigation-preview-side")).toHaveValue("right");
});

test("storage failure leaves reachable in-memory preferences", async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) {
      if (key.includes("navigation")) throw new Error("Storage unavailable");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key.includes("navigation")) throw new Error("Storage unavailable");
      set.call(this, key, value);
    };
  });
  await boot(page);
  await preferences(page);
  await page.locator("#navigation-keep-open").check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator("#navigation-handle").click();
  await page.locator("#preview").click({ position: { x: 10, y: 10 } });
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
});

for (const denied of [["localStorage"], ["sessionStorage"], ["localStorage", "sessionStorage"]]) {
  test(`throwing ${denied.join(" and ")} getters do not prevent boot or Terminal use`, async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.stack ?? error.message));
    await page.addInitScript(keys => {
      for (const key of keys) Object.defineProperty(window, key, {
        configurable: true,
        get() { throw Object.assign(new Error("Storage denied"), { name: "SecurityError" }); },
      });
    }, denied);
    await boot(page);
    expect(errors).toEqual([]);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await preferences(page);
    await page.locator("#navigation-keep-open").check();
    await page.locator("#navigation-side").selectOption("right");
    await page.locator("#navigation-preview-side").selectOption("right");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator("#navigation-preferences-dialog")).not.toBeVisible();
    await showSurface(page, "terminal");
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible();
    const session = await page.locator(".terminal-pane").first().getAttribute("data-session-id");
    // Keystrokes sent while the shell is still initializing can be swallowed or
    // echoed garbled, so wait for the prompt to render before typing.
    await expect.poll(
      async () => (await page.locator(".terminal-pane-host .xterm-rows > div").allTextContents()).some(text => text.trim().length > 0),
      { timeout: 10_000, message: "shell prompt must render before typing" },
    ).toBe(true);
    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type("echo storage-$((6*7))");
    await page.keyboard.press("Enter");
    await expect.poll(
      async () => (await page.locator(".xterm-rows > div").allTextContents()).some(text => text.trim() === "storage-42"),
      { timeout: 15_000, message: "the PTY must echo the command output" },
    ).toBe(true);
    await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
    await page.locator("#touch-tab-preview").click();
    await preferences(page);
    await expect(page.locator("#navigation-side")).toHaveValue("right");
    await expect(page.locator("#navigation-preview-side")).toHaveValue("right");
    await expect(page.locator("#navigation-keep-open")).toBeChecked();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await showSurface(page, "terminal");
    await expect(page.locator(".terminal-pane")).toHaveCount(1);
    await expect(page.locator(".terminal-pane")).toHaveAttribute("data-session-id", session!);
    expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`${viewport.width}x${viewport.height} ${colorScheme} touch navigation`, () => {
      test.use({ viewport, colorScheme });
      test("destinations and edge handle remain readable and within the viewport", async ({ page }) => {
        await boot(page);
        await expect(page.locator("#touch-tab-bar [role=tab]")).toHaveCount(4);
        for (const control of await page.locator("#touch-tab-bar [role=tab], #navigation-close").all()) {
          const box = (await control.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        }
        // The Hub destination is an anchor rather than a button, and is absent
        // outside a Hub, so match either control type and skip hidden ones.
        for (const label of await page.locator(".touch-tab-label:visible").all()) {
          expect(await label.evaluate(element => {
            const label = element.getBoundingClientRect();
            const control = element.closest("button, a")!.getBoundingClientRect();
            return label.left >= control.left && label.right <= control.right;
          })).toBe(true);
        }
        await page.locator("#navigation-close").click();
        const handle = (await page.locator("#navigation-handle").boundingBox())!;
        expect(handle.width).toBeGreaterThanOrEqual(44);
        expect(handle.height).toBeGreaterThanOrEqual(44);
        expect(handle.x + handle.width).toBeLessThanOrEqual(viewport.width);
        expect(handle.y + handle.height).toBeLessThanOrEqual(viewport.height);
        await page.locator("#navigation-handle").click();
        await page.locator("#touch-tab-files").click();
        await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      });
    });
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} fine-pointer desktop`, () => {
    test.use({ viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false, colorScheme });
    test("does not render touch navigation or replace the split workspace", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
      await expect(page.locator("#preview")).toBeVisible();
      await expect(page.locator(".sidebar")).toBeVisible();
      await expect(page.locator("#touch-tab-bar")).toBeHidden();
      await expect(page.locator("#navigation-handle")).toBeHidden();
      const sidebar = (await page.locator(".sidebar").boundingBox())!;
      const preview = (await page.locator(".preview-shell").boundingBox())!;
      expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(preview.x);
    });
  });
}

test("200% labels and reduced motion remain reachable in a short narrow viewport", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 390 });
  await boot(page);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  for (const control of await page.locator("#touch-tab-bar [role=tab], #navigation-close").all()) {
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await expect(page.locator("#touch-tab-bar")).toHaveCSS("transition-duration", "0s");
  await page.locator("#navigation-close").click();
  await expect(page.locator("#touch-tab-bar")).toBeHidden();
  await page.locator("#navigation-handle").click();
  await page.locator("#touch-tab-files").click();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
});

test("Chat attention reaches the collapsed handle without acknowledging the surface", async ({ page, request }) => {
  const snapshot = await request.post("/__e2e/chat", { data: { action: "seed", title: "Navigation attention", items: [] } }).then(response => response.json());
  await boot(page);
  await page.locator("#touch-tab-chat").click();
  await expect(page.locator("#chat-input")).toBeVisible();
  await page.locator("#touch-tab-preview").click();
  await page.locator("#navigation-close").click();
  await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id,
    item: { id: "navigation-attention", type: "assistant_message", createdAt: Date.now(), markdown: "New background activity" } } });
  await expect(page.locator("#touch-tab-chat")).toHaveAttribute("data-badge", "");
  await expect(page.locator("#navigation-handle")).toHaveAttribute("data-attention", "");
  await expect(page.locator("#navigation-handle")).toHaveAccessibleName(/pending attention: Chat/);
  await page.locator("#navigation-handle").click();
  await expect(page.locator("#touch-tab-chat")).toHaveAttribute("data-badge", "");
  await page.locator("#touch-tab-chat").click();
  await expect(page.locator('[data-chat-item-id="navigation-attention"]')).toContainText("New background activity");
  await expect(page.locator("#touch-tab-chat")).not.toHaveAttribute("data-badge");
  await expect(page.locator("#navigation-handle")).not.toHaveAttribute("data-attention");
});

test("Terminal input and unseen output survive dismissal with overlay-only contrast", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await boot(page);
  await page.locator("#touch-tab-terminal").click();
  await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible();
  const session = await page.locator(".terminal-pane").first().getAttribute("data-session-id");
  const background = await page.locator(".xterm").first().evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(page.locator("#touch-tab-bar")).toHaveCSS("color", "rgb(244, 250, 255)");
  await page.locator(".xterm-helper-textarea").first().focus();
  await page.keyboard.type("sleep 2; echo navigation-$((21*2))");
  await page.keyboard.press("Enter");
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "false");
  await page.locator("#navigation-handle").click();
  await page.locator("#touch-tab-preview").click();
  await page.locator("#navigation-close").click();
  await expect(page.locator("#touch-tab-terminal")).toHaveAttribute("data-badge", "");
  await expect(page.locator("#navigation-handle")).toHaveAccessibleName(/Terminal, unseen output/);
  await page.locator("#navigation-handle").click();
  await expect(page.locator("#touch-tab-terminal")).toHaveAttribute("data-badge", "");
  await page.locator("#touch-tab-terminal").click();
  await expect(page.locator("#touch-tab-terminal")).not.toHaveAttribute("data-badge");
  await expect(page.locator(".terminal-pane")).toHaveCount(1);
  await expect(page.locator(".terminal-pane")).toHaveAttribute("data-session-id", session!);
  await expect(page.locator(".xterm").first()).toHaveCSS("background-color", background);
  await expect.poll(async () => (await page.locator(".xterm-rows > div").allTextContents()).filter(text => text.trim() === "navigation-42").length).toBe(1);
});

test("dismissal retains bounds and reverses locally while controls are usable", async ({ page }) => {
  await boot(page);
  const bar = page.locator("#touch-tab-bar");
  const before = await bar.boundingBox();
  await page.locator("#navigation-close").click();
  await expect(bar).toHaveAttribute("data-open", "false");
  expect(await bar.boundingBox()).toEqual(before);
  await page.locator("#navigation-handle").click();
  await expect(bar).toHaveAttribute("data-open", "true");
  expect(await bar.boundingBox()).toEqual(before);
  await expect(bar).toHaveCSS("transform", "none");
  await page.locator("#touch-tab-files").click();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
});

test("real Preview file controls do not dismiss or displace expanded navigation", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await boot(page);
  const group = page.locator("#preview-file-navigation");
  await expect(group).toBeVisible();
  await expect(group).toHaveAttribute("aria-busy", "false");
  await freeze(page);
  const bar = page.locator("#touch-tab-bar");
  await page.locator("#touch-tab-preview").click();
  const originalPath = await page.locator("#preview-path").textContent();
  const next = group.getByRole("button", { name: "Next file", exact: true });
  await expect(next).toBeEnabled();
  const originalBounds = (await group.boundingBox())!;
  await page.clock.runFor(6500);
  await next.dispatchEvent("pointerdown", { pointerId: 12, button: 0 });
  await page.clock.runFor(2000);
  await expect(bar).toHaveAttribute("data-open", "true");
  await next.dispatchEvent("pointerup", { pointerId: 12 });
  await next.click();
  await expect(page.locator("#preview-path")).not.toHaveText(originalPath!);
  await expect(group).toHaveAttribute("aria-busy", "false");
  await expect(bar).toHaveAttribute("data-open", "true");
  expect((await group.boundingBox())!.y).toBe(originalBounds.y);
  await group.getByRole("button", { name: "Previous file", exact: true }).click();
  await expect(page.locator("#preview-path")).toHaveText(originalPath!);
  await expect(group).toHaveAttribute("aria-busy", "false");
  await expect(bar).toHaveAttribute("data-open", "true");
  expect((await group.boundingBox())!.y).toBe(originalBounds.y);
});

test("keyboard and zoom viewport bounds clamp the handle and lift navigation without a gutter", async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  await boot(page);
  await page.locator("#navigation-close").click();
  await page.locator("#navigation-handle").focus();
  await page.keyboard.press("ArrowRight");
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { width: 260, height: 350, offsetTop: 30, offsetLeft: 20, scale: 1.5 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  });
  const handle = (await page.locator("#navigation-handle").boundingBox())!;
  expect(handle.x).toBeGreaterThanOrEqual(20);
  expect(handle.x + handle.width).toBeLessThanOrEqual(280);
  expect(handle.y).toBeGreaterThanOrEqual(30);
  expect(handle.y + handle.height).toBeLessThanOrEqual(380);
  await page.locator("#navigation-handle").click();
  const bar = (await page.locator("#touch-tab-bar").boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(20);
  expect(bar.x + bar.width).toBeLessThanOrEqual(280);
  expect(bar.y + bar.height).toBeLessThanOrEqual(380);
  await expect(page.locator(".app-shell")).toHaveCSS("padding-bottom", "0px");
});

test("unavailable Terminal remains a disabled fourth tab without changing other surfaces", async ({ page }) => {
  await page.route("**/api/state", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), terminal: "disabled" } });
  });
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:active-tab", "terminal"));
  await boot(page);
  await expect(page.locator("#touch-tab-terminal")).toBeDisabled();
  await expect(page.locator("#touch-tab-bar [role=tab]")).toHaveCount(4);
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
  await page.locator("#touch-tab-preview").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#touch-tab-chat")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#touch-tab-files")).toBeFocused();
});

test("Reduce Transparency and increased contrast use opaque overlay surfaces", async ({ page, browserName, context }) => {
  test.skip(browserName !== "chromium", "Chromium exposes media-feature emulation for Reduced Transparency");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }, { name: "prefers-contrast", value: "more" }] });
  await boot(page);
  await expect(page.locator("#touch-tab-bar")).toHaveCSS("backdrop-filter", "none");
  await expect(page.locator("#touch-tab-bar")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.emulateMedia({ colorScheme: "dark", contrast: "more" });
  await expect(page.locator("#touch-tab-bar")).toHaveCSS("background-color", "rgb(22, 27, 34)");
});

hubTest("confirmed Hub shares only navigation preferences across workspaces and Settings", async ({ page, context, hub }) => {
  hubTest.setTimeout(120000);
  await loginHub(page, hub);
  const ids: string[] = [];
  for (const path of Object.values(hub.workspaces)) {
    const result = await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path, displayName: "Navigation workspace", start: false });
    ids.push(result.workspace.id);
    await hubPost(page.request, hub, `/api/hub/sessions/${result.workspace.id}/start`);
  }
  await page.goto(`${hub.origin}/s/${ids[0]}/`);
  await expect(page.locator("#navigation-hub")).toBeVisible();
  await expect(page.locator("#navigation-preferences")).toHaveCount(0);
  await expect(page.locator("#navigation-hub")).toHaveAttribute("href", `${hub.origin}/`);
  await page.locator("#touch-tab-files").click();
  const other = await context.newPage();
  await other.goto(`${hub.origin}/s/${ids[1]}/`);
  await expect(other.locator("#navigation-hub")).toBeVisible();
  await expect(other.locator("html")).toHaveAttribute("data-active-tab", "preview");
  const settings = await context.newPage();
  await settings.goto(`${hub.origin}/settings`);
  await settings.locator("#navigation-side").selectOption("right");
  await settings.locator("#navigation-auto-hide").selectOption("false");
  await settings.locator("#navigation-preview-side").selectOption("right");
  await expect(page.locator("#navigation-handle")).toHaveAttribute("data-side", "right");
  await expect(other.locator("#navigation-handle")).toHaveAttribute("data-side", "right");
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "files");
  await expect(other.locator("html")).toHaveAttribute("data-active-tab", "preview");
  const before = await other.locator("#preview-path").textContent();
  await page.locator("#navigation-close").click();
  await page.locator("#navigation-handle").focus();
  await page.keyboard.press("Home");
  await expect(other.locator("#navigation-handle")).toHaveAttribute("data-side", "left");
  await expect(settings.locator("#navigation-side")).toHaveValue("left");
  await expect(other.locator("#preview-path")).toHaveText(before!);
  await other.reload();
  await expect(other.locator("#navigation-hub")).toBeVisible();
  await expect(other.locator("#navigation-handle")).toHaveAttribute("data-side", "left");
  await expect(settings.locator("#navigation-auto-hide")).toHaveValue("false");
  await expect(settings.locator("#navigation-preview-side")).toHaveValue("right");
  await settings.close();
  await other.close();
});
