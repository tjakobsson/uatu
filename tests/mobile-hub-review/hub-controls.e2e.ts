import { expect, test } from "@playwright/test";
import { namedButton } from "./navigation";

const evidence = new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/preview-refinement/", import.meta.url).pathname;
test.beforeEach(async ({ request }) => { await request.post("/review/reset", { data: { scenario: "mixed" } }); });

test("Hub controls give Configure a visible primary button without changing its operation", async ({ page, request }, info) => {
  await page.goto("/?detail=add-workspace");
  await namedButton(page, "Create workspace").click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const configure = page.getByRole("button", { name: "Configure new workspace", exact: true });
  await expect(configure).toHaveClass(/mh-commit/);
  await expect(configure).toHaveCount(1);
  for (const [width, height, scheme, textSize] of [[390, 844, "light", "100%"], [320, 568, "dark", "100%"], [844, 390, "light", "200%"]] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.evaluate(size => { document.documentElement.style.fontSize = size; }, textSize);
    await configure.scrollIntoViewIfNeeded();
    const style = await configure.evaluate(el => { const s = getComputedStyle(el); return { fill: s.backgroundColor, color: s.color, radius: s.borderRadius, height: el.getBoundingClientRect().height }; });
    expect(style.fill).not.toBe("rgba(0, 0, 0, 0)"); expect(style.fill).not.toBe(style.color);
    expect(style.radius).not.toBe("0px"); expect(style.height).toBeGreaterThanOrEqual(44);
    expect(await page.locator(".mh-flow-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `${evidence}${info.project.name}-configure-${width}.png` });
  }
  await configure.click();
  await expect(page.getByRole("region", { name: "Create Workspace", exact: true })).toBeVisible();
  expect((await (await request.get("/review/state")).json()).log).toEqual([]);
});

test("Hub controls distinguish a folder with files from an empty or failed collection", async ({ page, request }, info) => {
  await page.goto("/settings?detail=default-folder"); await page.locator('[data-flow="edit"]').click();
  await page.getByLabel("Folder path").fill("/synthetic/atlas/examples/guides");
  await namedButton(page, "Choose folder").click();
  const picker = page.locator(".mh-folder-picker");
  await expect(picker.getByRole("heading", { name: "No subfolders", exact: true })).toBeVisible();
  await expect(picker).toContainText("Files aren’t shown here. Tap Choose to use this folder.");
  await expect(picker.locator(".mh-empty-state svg")).toHaveAttribute("aria-hidden", "true");
  await expect(picker.locator(".mh-empty-state button, [role=alert]")).toHaveCount(0);
  await expect(picker.getByRole("button", { name: "Choose", exact: true })).toBeEnabled();
  await page.screenshot({ path: `${evidence}${info.project.name}-no-subfolders.png` });
  await picker.getByRole("button", { name: "Choose", exact: true }).click();
  await expect(page.getByLabel("Folder path")).toHaveValue("/synthetic/atlas/examples/guides");
  expect((await (await request.get("/review/state")).json()).log).toEqual([]);
});
