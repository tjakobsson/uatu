import { expect, test } from "@playwright/test";
import { recordMotionEvidence } from "./motion-evidence";
import { DEFAULT_NAVIGATION_PLACEMENT } from "../../src/shell/navigation-preferences";

test.beforeEach(async ({ request }) => { await request.post("/review/reset", { data: { scenario: "mixed" } }); });

test("foreground drives reversible travel, immediate interaction and stable viewport geometry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  const root = page.locator("#mobile-workspace-root");
  const before = await root.boundingBox();
  await page.evaluate(() => { (window as any).__resident = document.querySelector(".app-shell"); });
  // Seek the actual CSS transition, not mocked timers (CSS has its own clock).
  await page.evaluate(() => {
    document.querySelector<HTMLAnchorElement>("#navigation-hub")!.click();
    const root = document.querySelector<HTMLElement>("#mobile-workspace-root")!;
    void getComputedStyle(root).left;
    const travel = document.getAnimations().filter(a => a instanceof CSSTransition && ["left", "translate"].includes(a.transitionProperty));
    if (!travel.some(a => (a.effect as KeyframeEffect).target === root)) throw new Error("Workspace travel transition missing");
    for (const transition of travel) { transition.pause(); transition.currentTime = 80; }
  });
  const moving = await root.boundingBox();
  expect(moving!.x).toBeGreaterThan(0);
  expect(moving!.x).toBeLessThan(before!.width);
  expect(moving!.width).toBe(before!.width);
  expect(moving!.height).toBe(before!.height);
  expect(await page.evaluate(() => [innerWidth, innerHeight, visualViewport?.width])).toEqual([390, 844, 390]);
  const screenshot = await page.screenshot({ scale: "css" });
  await test.info().attach("workspace-exit-in-flight", { body: screenshot, contentType: "image/png" });
  await recordMotionEvidence(test.info(), "in-flight", screenshot);
  await recordMotionEvidence(test.info(), "geometry", { before, moving, durationMs: 240, sampledAtMs: 80, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width, visualHeight: visualViewport?.height })) });
  await test.info().attach("motion-geometry", { body: JSON.stringify({ before, moving, durationMs: 240, sampledAtMs: 80 }), contentType: "application/json" });
  await expect(root).toHaveAttribute("inert", "");
  // A real pointer click reaches the Hub while protected workspace pixels are
  // still moving out. No transitionend listener unlocks the foreground.
  await page.locator('[data-action="settings"]').click();
  await expect(page.locator("#mobile-hub-root h1:visible")).toHaveText(["Settings"]);
  await page.locator('[data-action="return"]').click();
  await expect(root).not.toHaveAttribute("inert", "");
  await expect.poll(async () => (await root.boundingBox())!.x).toBe(0);
  expect(await page.evaluate(() => (window as any).__resident === document.querySelector(".app-shell"))).toBe(true);
  expect(await page.evaluate(() => document.querySelector("#touch-tab-bar")!.contains(document.activeElement))).toBe(false);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await root.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor));
  }
});

test("Reduced Motion is immediate and invalidation never travels protected pixels", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await page.locator("#navigation-hub").click();
  const result = await page.locator("#mobile-workspace-root").evaluate(el => ({ x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width, duration: getComputedStyle(el).transitionDuration }));
  expect(result.x).toBe(result.width); expect(result.duration).toBe("0s");
  await page.locator('[data-action="return"]').click();
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await request.post("/review/backend/signOut", { data: [] });
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("data-access-invalidated", "");
  expect(await page.locator("#mobile-workspace-root").evaluate(el => getComputedStyle(el).visibility)).toBe("hidden");
});

test("visible workspace controls accept pointer input before Return travel completes", async ({ page }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  await page.locator("#navigation-hub").click();
  const root = page.locator("#mobile-workspace-root");
  await expect.poll(() => root.evaluate(el => el.getBoundingClientRect().x)).toBe(390);
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (document.documentElement.dataset.workspaceForeground !== "true") return;
      observer.disconnect();
      void getComputedStyle(document.querySelector("#mobile-workspace-root")!).left;
      for (const transition of document.getAnimations()) {
        if (transition instanceof CSSTransition && ["left", "translate"].includes(transition.transitionProperty)) { transition.pause(); transition.currentTime = 120; }
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-workspace-foreground"] });
  });
  await page.locator('[data-action="return"]').click();
  await expect(root).not.toHaveAttribute("inert", "");
  const x = await root.evaluate(el => el.getBoundingClientRect().x);
  expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(390);
  await page.locator("#navigation-close").click();
  await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "false");
  expect(await page.evaluate(() => innerWidth)).toBe(390);
  await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.playState === "paused") animation.play(); });
  await expect.poll(() => root.evaluate(el => el.getBoundingClientRect().x)).toBe(0);
});

test("calibrated fresh handle placement matches reference; selector fade stays local", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  const bar = page.locator("#touch-tab-bar"), handle = page.locator("#navigation-handle");
  await page.locator("#navigation-close").click();
  await expect(bar).toBeHidden();
  const bounds = (await handle.boundingBox())!;
  expect(bounds.y).toBeCloseTo(8 + (844 - 16 - bounds.height) * DEFAULT_NAVIGATION_PLACEMENT.position, 1);
  expect((await handle.locator("span").boundingBox())!.y).toBeCloseTo(588, 0);
  await expect(handle).toHaveAttribute("data-side", "left");
  await recordMotionEvidence(test.info(), "handle-default", { viewport: { width: 390, height: 844 }, normalizedPosition: DEFAULT_NAVIGATION_PLACEMENT.position, target: bounds, visualFace: await handle.locator("span").boundingBox(), referenceVisualTopApprox: 588, policy: "Intentional fresh/reset default calibration only; stored ratios and mapping unchanged" });
  await recordMotionEvidence(test.info(), "handle-default-image", await page.screenshot({ scale: "css" }));
  await handle.focus(); await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await handle.boundingBox())!.y).toBeCloseTo(8 + (844 - 16 - bounds.height) * (DEFAULT_NAVIGATION_PLACEMENT.position + .05), 1);
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("data-side", "right");
  await handle.click();
  const visible = await bar.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), duration: getComputedStyle(el).transitionDuration, transform: getComputedStyle(el).transform }));
  expect(visible.duration).toBe("0.18s, 0.24s");
  expect(visible.transform).toBe("none");
  expect(visible.rect.y).toBeCloseTo(780, 1);
  await page.locator("#navigation-close").click();
  expect(await bar.evaluate(el => getComputedStyle(el).transitionDuration)).toBe("0.28s, 0.24s");
  await page.reload();
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  await page.locator("#navigation-close").click();
  await expect(handle).toHaveAttribute("data-side", "right");
  expect((await handle.boundingBox())!.y).toBeCloseTo(8 + (844 - 16 - bounds.height) * (DEFAULT_NAVIGATION_PLACEMENT.position + .05), 1);
  await handle.focus(); await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("data-side", "left");
  expect((await handle.locator("span").boundingBox())!.y).toBeCloseTo(588, 0);
});

for (const side of ["left", "right"] as const) {
  test(`explicitly saved ${side} .72 placement retains original pixels across sizes and reload`, async ({ page }) => {
    const saved = { side, position: .72, autoHide: false, previewSide: "right" };
    await page.addInitScript(value => { if (!localStorage.getItem("uatu:navigation:v1:hub")) localStorage.setItem("uatu:navigation:v1:hub", JSON.stringify(value)); }, saved);
    await page.goto("/s/atlas/README.md");
    await expect(page.locator("#preview")).toContainText("Synthetic review document");
    await expect(page.locator("#mobile-hub-root")).toBeHidden();
    await page.locator("#navigation-close").click();
    const handle = page.locator("#navigation-handle");
    const measurements: object[] = [];
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => (await handle.boundingBox())!.y).toBeCloseTo(8 + (viewport.height - 16 - 44) * .72, 1);
      const rect = (await handle.boundingBox())!;
      expect(rect.x).toBe(side === "left" ? 0 : viewport.width - 44);
      expect(rect.width).toBeGreaterThanOrEqual(44); expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(rect.y).toBeGreaterThanOrEqual(8); expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height - 8);
      expect(await page.evaluate(() => localStorage.getItem("uatu:navigation:v1:hub"))).toBe(JSON.stringify(saved));
      measurements.push({ viewport, rect, unchangedStoredRatio: .72 });
    }
    await page.reload();
    await expect(page.locator("#preview")).toContainText("Synthetic review document");
    await expect(page.locator("#mobile-hub-root")).toBeHidden();
    await page.locator("#navigation-close").click();
    expect((await handle.boundingBox())!.y).toBeCloseTo(8 + (390 - 16 - 44) * .72, 1);
    expect(await page.evaluate(() => localStorage.getItem("uatu:navigation:v1:hub"))).toBe(JSON.stringify(saved));
    await recordMotionEvidence(test.info(), side === "left" ? "handle-saved-left" : "handle-saved-right", { saved, measurements });
    await handle.click(); await page.locator("#navigation-hub").click();
    await page.locator('[data-action="settings"]').click(); await page.locator('[data-action="handle"]').click();
    await page.locator('[data-action="reset-handle"]').click(); await page.locator('[data-action="cancel-sheet"]').click();
    expect(await page.evaluate(() => localStorage.getItem("uatu:navigation:v1:hub"))).toBe(JSON.stringify(saved));
  });
}

test("fresh placement stays in bounds on phone and landscape; Home and sheet Reset share the default", async ({ page }) => {
  const patches: object[] = [], mutations: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/api/personal-state") && request.method() === "PATCH") patches.push(request.postDataJSON());
    if (path.startsWith("/review/backend/") && !path.split("/").at(-1)!.startsWith("read")) mutations.push(path);
  });
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  await page.locator("#navigation-close").click();
  const handle = page.locator("#navigation-handle");
  for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await handle.boundingBox())!.y).toBeCloseTo(8 + (viewport.height - 60) * DEFAULT_NAVIGATION_PLACEMENT.position, 1);
    const rect = (await handle.boundingBox())!;
    expect(rect.x).toBe(0); expect(rect.y).toBeGreaterThanOrEqual(8); expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height - 8);
    expect(rect.width).toBeGreaterThanOrEqual(44); expect(rect.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => localStorage.getItem("uatu:navigation:v1:hub"))).toBeNull();
  await handle.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  const home = await page.evaluate(() => JSON.parse(localStorage.getItem("uatu:navigation:v1:hub")!));
  expect(home).toEqual({ ...DEFAULT_NAVIGATION_PLACEMENT, autoHide: true, previewSide: "left" });
  await handle.click(); await page.locator("#navigation-hub").click();
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="handle"]').click();
  await page.getByRole('radio', { name: 'Right', exact: true }).check();
  await page.locator('[data-pref="position"]').press("Home");
  await page.locator('[data-action="reset-handle"]').click();
  await expect(page.locator('[data-pref="position"]')).toHaveValue(String(DEFAULT_NAVIGATION_PLACEMENT.position * 100));
  // Reset is a draft action: Cancel must not alter the committed Home result.
  await page.locator('[data-action="cancel-sheet"]').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("uatu:navigation:v1:hub")!))).toEqual(home);
  await page.locator('[data-action="handle"]').click();
  await page.locator('[data-action="reset-handle"]').click();
  await page.locator('[data-action="commit-sheet"]').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("uatu:navigation:v1:hub")!))).toEqual(home);
  await page.locator('[data-action="return"]').click();
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  await page.locator("#navigation-close").click();
  expect((await handle.locator("span").boundingBox())!.y).toBeCloseTo(588, 0);
  await page.setViewportSize({ width: 844, height: 390 });
  await handle.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowUp");
  expect((await handle.boundingBox())!.y).toBeCloseTo(8, 1);
  for (let i = 0; i < 25; i++) await page.keyboard.press("ArrowDown");
  expect((await handle.boundingBox())!.y + (await handle.boundingBox())!.height).toBeCloseTo(390 - 8, 1);
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("data-side", "left");
  expect(mutations).toEqual([]);
  for (const patch of patches) expect(Object.keys(patch).some(key => ["side", "position", "autoHide", "previewSide"].includes(key))).toBe(false);
});

for (const sample of [
  { label: "saved .723456", position: .723456, fresh: false },
  { label: "saved .72", position: .72, fresh: false },
  { label: "saved .7373", position: .7373, fresh: false },
  { label: "fresh calibrated default", position: DEFAULT_NAVIGATION_PLACEMENT.position, fresh: true },
]) {
  test(`no-op Done preserves exact ${sample.label} storage in both handle sheets`, async ({ page }) => {
    const initial = sample.fresh
      ? { ...DEFAULT_NAVIGATION_PLACEMENT, autoHide: true, previewSide: "left" }
      : { side: "right", position: sample.position, autoHide: false, previewSide: "right" };
    // Whitespace makes an accidental no-op reserialization observable too.
    const raw = sample.fresh ? null : JSON.stringify(initial, null, 1);
    await page.addInitScript(raw => { if (raw !== null) localStorage.setItem("uatu:navigation:v1:hub", raw); }, raw);
    await page.goto("/s/atlas/README.md");
    await expect(page.locator("#preview")).toContainText("Synthetic review document");
    await expect(page.locator("#mobile-hub-root")).toBeHidden();
    await page.locator("#navigation-close").click();
    const handle = page.locator("#navigation-handle");
    await handle.press("Shift+F10");
    const dialog = page.locator("#navigation-preferences-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#navigation-position")).toHaveAttribute("step", "any");
    expect(await page.locator("#navigation-position").evaluate(el => (el as HTMLInputElement).valueAsNumber)).toBeCloseTo(sample.position * 100, 9);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("uatu:navigation:v1:hub"))).toBe(raw);

    await handle.click(); await page.locator("#navigation-hub").click();
    await page.locator('[data-action="settings"]').click(); await page.locator('[data-action="handle"]').click();
    const range = page.locator('[data-pref="position"]');
    await expect(range).toHaveAttribute("step", "any");
    expect(await range.evaluate(el => (el as HTMLInputElement).valueAsNumber)).toBeCloseTo(sample.position * 100, 9);
    await page.locator('[data-action="commit-sheet"]').click();
    expect(await page.evaluate(() => localStorage.getItem("uatu:navigation:v1:hub"))).toBe(raw);

    // A real side-only change must not round the untouched position either.
    await page.locator('[data-action="handle"]').click();
    const nextSide = initial.side === "left" ? "right" : "left";
    await page.getByRole('radio', { name: nextSide === 'right' ? 'Right' : 'Left', exact: true }).check();
    await page.locator('[data-action="commit-sheet"]').click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("uatu:navigation:v1:hub")!));
    expect(stored).toEqual({ ...initial, side: nextSide });
  });
}
