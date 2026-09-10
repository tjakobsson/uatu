import { expect, type Page } from "@playwright/test";
import { activeTask } from './navigation';

/** Reference-derived CSS coordinate tolerances, not actual-image goldens.
 * Pixel edges were read at the approved 390×844 normalization. */
const near = (actual: number, expected: number, tolerance = 1.5) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

export async function checkHubGeometry(page: Page) {
  const groups = await page.locator(".mh-group").evaluateAll(elements => elements.map(e => {
    const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  expect(groups).toHaveLength(2);
  near(groups[0]!.x, 20); near(groups[0]!.width, 350); near(groups[0]!.y, 178); near(groups[0]!.height, 104);
  near(groups[1]!.y, 330); near(groups[1]!.height, 312);
  for (const control of await page.locator(".mh-more, .mh-primary").all()) {
    const r = (await control.boundingBox())!; expect(r.width).toBeGreaterThanOrEqual(44); expect(r.height).toBeGreaterThanOrEqual(44);
  }
}

export async function checkSheetGeometry(page: Page) {
  const sheet = (await page.locator(".mh-sheet").boundingBox())!;
  near(sheet.x, 0); near(sheet.width, 390); near(sheet.y + sheet.height, 844);
  const choices = activeTask(page).getByRole('radio');
  await expect(choices).toHaveCount(2);
  await expect(activeTask(page).locator('select')).toHaveCount(0);
  for (const choice of await choices.all()) {
    const row = (await choice.locator('..').boundingBox())!;
    expect(row.height).toBeGreaterThanOrEqual(44);
    expect(row.y).toBeGreaterThanOrEqual(sheet.y);
    expect(row.y + row.height).toBeLessThanOrEqual(sheet.y + sheet.height);
  }
  const control = page.getByRole('radio', { name: 'Right', exact: true });
  // A visible focus ring is an accessibility exception to the unfocused PNG.
  await control.focus(); expect(await control.locator('..').evaluate(e => getComputedStyle(e).outlineStyle)).not.toBe("none");
}

export async function checkWorkspaceChrome(page: Page, expanded: boolean, terminal: boolean) {
  const handle = page.locator("#navigation-handle"), bar = page.locator("#touch-tab-bar");
  if (expanded) {
    const bounds = (await bar.boundingBox())!;
    near(bounds.x, 12, .1); near(bounds.y, 780, .1); near(bounds.width, 366, .1); near(bounds.height, 54, .1);
    const buttons = await page.locator("#touch-tab-bar button, #navigation-hub").all();
    for (const button of buttons) {
      const r = (await button.boundingBox())!;
      expect(r.width).toBeGreaterThanOrEqual(44); expect(r.height).toBeGreaterThanOrEqual(44);
      expect(await button.locator("svg").count()).toBe(1);
    }
    expect(await page.locator(".touch-tab-label").first().evaluate(e => ({ size: getComputedStyle(e).fontSize, weight: getComputedStyle(e).fontWeight }))).toEqual({ size: "11px", weight: "400" });
    const material = await bar.evaluate(e => { const s = getComputedStyle(e); return { background: s.backgroundColor, border: s.borderColor, blur: s.backdropFilter, shadow: s.boxShadow }; });
    expect(material.blur).toContain("blur(24px)"); expect(material.shadow).toContain("inset");
    expect(material.background).toContain(terminal ? "0.84" : "0.76");
    if (terminal) { expect(material.border).toBe("rgb(166, 223, 246)"); expect(await page.locator("#touch-tab-terminal path").getAttribute("d")).not.toMatch(/[zZ]/); }
  } else {
    await expect(bar).toBeHidden(); const r = (await handle.boundingBox())!;
    expect(r.width).toBeGreaterThanOrEqual(44); expect(r.height).toBeGreaterThanOrEqual(44);
    const face = (await handle.locator("span").boundingBox())!;
    near(face.width, 26); near(face.y, 588); expect(face.x === 0 || face.x + face.width === 390).toBe(true);
  }
  if (!terminal) {
    const pill = page.locator(".preview-nav-pill"), r = (await pill.boundingBox())!;
    near(r.y + r.height, expanded ? 768 : 834, .1);
    const material = await pill.evaluate(e => { const s = getComputedStyle(e); return { background: s.backgroundColor, border: s.borderColor, blur: s.backdropFilter }; });
    expect(material.background).toBe("rgba(255, 255, 255, 0.76)"); expect(material.border).toBe("rgba(255, 255, 255, 0.65)"); expect(material.blur).toContain("blur(24px)");
  }
}
