import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { expect as browserExpect } from "@playwright/test";
import { check } from "../../src/hub/mobile/flow-ui";

test("Chromium switch is a green native draft with a 44px row and forced-color support", async () => {
  const entry = await Bun.file(new URL("../../src/hub/mobile/styles.css", import.meta.url)).text();
  const tokens = await Bun.file(new URL("../../src/hub/mobile/tokens.css", import.meta.url)).text();
  const css = entry.replace('@import "./tokens.css";', tokens);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<style>${css}</style><main class="mh-root">${check("consent", "Allow credential access")}</main><script>window.changes=0;window.writes=0;document.addEventListener('change',()=>window.changes++);</script>`, { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    await page.goto(`http://localhost:${server.port}`);
    const control = page.getByRole("switch", { name: "Allow credential access" });
    expect(await control.isChecked()).toBe(false);
    expect(await page.evaluate(() => ({ changes: (window as any).changes, writes: (window as any).writes }))).toEqual({ changes: 0, writes: 0 });
    expect((await page.locator("label").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await control.boundingBox())!.width).toBe(51);
    expect((await control.boundingBox())!.height).toBe(31);
    await control.check();
    // The track and thumb animate for 150ms; test the settled selected state,
    // not whichever interpolated color happens to follow native check().
    await browserExpect.poll(() => control.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(52, 199, 89)");
    await browserExpect.poll(() => control.evaluate(el => getComputedStyle(el, "::before").transform)).toBe("matrix(1, 0, 0, 1, 20, 0)");
    expect(await page.evaluate(() => (window as any).writes)).toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await control.evaluate(el => getComputedStyle(el, "::before").transitionDuration)).toBe("0s");
    await page.emulateMedia({ forcedColors: "active" });
    expect(await control.isChecked()).toBe(true);
    expect(await control.evaluate(el => getComputedStyle(el).forcedColorAdjust)).toBe("none");
    await page.emulateMedia({ forcedColors: "none", colorScheme: "light" });
    await page.locator(".mh-root").evaluate(root => {
      root.insertAdjacentHTML("beforeend", '<h1>Page title</h1><label class="mh-field"><span>Persistent label</span><input placeholder="Editable value"></label><dl class="mh-info"><div class="mh-info-row"><dt>Read-only label</dt><dd>Read-only value</dd></div></dl><section class="mh-task mh-sheet mh-editor"><header><h1>Editor title</h1></header></section>');
    });
    expect(await page.locator(".mh-field").evaluate(el => getComputedStyle(el).display)).toBe("grid");
    expect(await page.locator(".mh-field input").evaluate(el => getComputedStyle(el).fontSize)).toBe("17px");
    expect(await page.locator(".mh-info dd").evaluate(el => getComputedStyle(el).fontSize)).toBe("17px");
    expect(await page.locator(".mh-editor h1").evaluate(el => getComputedStyle(el).fontSize)).toBe("26px");
    expect(await page.locator(".mh-editor").evaluate(el => getComputedStyle(el).borderRadius)).toBe("0px");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.locator(".mh-field input").evaluate(el => getComputedStyle(el).fontSize)).toBe("34px");
    expect(await page.locator(".mh-field").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await page.locator(".mh-field input").evaluate(el => getComputedStyle(el).color)).toBe("rgb(247, 247, 250)");
  } finally {
    server.stop(true);
    // Bound Chromium shutdown: Bun occasionally waits indefinitely for the
    // transport close even after Chromium has completed all assertions.
    await Promise.race([browser.close(), Bun.sleep(2000)]);
  }
}, 30_000);
