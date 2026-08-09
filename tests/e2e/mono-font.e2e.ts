import { expect, test } from "./fixtures";

// Real-browser checks for the shared `--mono-font-family` variable: the
// bundled Hack Nerd Font Mono stack is the standing default and the single
// source of monospace truth — `.uatu.json` carries no font configuration,
// so a legacy `mono` block must not affect rendering.

test.describe("--mono-font-family bundled default", () => {
  test.beforeEach(async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await page.goto("/");
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  });

  test.afterEach(async ({ request }) => {
    await request.post("/__e2e/reset");
  });

  test("CSS variable resolves to the bundled stack", async ({ page }) => {
    const value = await page.evaluate(() =>
      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue("--mono-font-family")
        .trim(),
    );
    expect(value.toLowerCase()).toContain("hack nerd font mono");
    expect(value.toLowerCase().split(",")[0]?.trim().replace(/['"]/g, "")).toBe("hack nerd font mono");
  });

  test("rendered Markdown code block resolves to the variable", async ({ page }) => {
    // Synthesize a code element and check its computed style, which exercises
    // the same CSS path as a real fenced code block.
    const fontFamily = await page.evaluate(() => {
      const container = document.createElement("article");
      container.className = "markdown-body";
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = "const x = 1;";
      pre.appendChild(code);
      container.appendChild(pre);
      document.body.appendChild(container);
      const computed = window.getComputedStyle(code).fontFamily;
      container.remove();
      return computed;
    });
    expect(fontFamily.toLowerCase()).toContain("hack nerd font mono");
  });
});

test.describe("legacy .uatu.json font blocks are not read", () => {
  test.afterEach(async ({ request }) => {
    await request.post("/__e2e/reset");
  });

  test("a legacy mono/terminal block leaves the payload and the variable untouched", async ({ page, request }) => {
    await request.post("/__e2e/reset", {
      data: {
        uatuConfig: {
          mono: { fontFamily: "Courier New, monospace" },
          terminal: { fontFamily: "JetBrains Mono, monospace", fontSize: 18 },
        },
      },
    });

    await page.goto("/");
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    const state = await page.evaluate(async () => {
      const response = await fetch("/api/state");
      return response.json();
    });
    expect("monoConfig" in state).toBe(false);
    expect("terminalConfig" in state).toBe(false);

    const variableValue = await page.evaluate(() =>
      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue("--mono-font-family")
        .trim(),
    );
    expect(variableValue.toLowerCase()).toContain("hack nerd font mono");
  });
});
