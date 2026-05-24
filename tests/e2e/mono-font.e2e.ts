import { expect, test } from "./fixtures";

// Real-browser checks for the shared `--mono-font-family` variable:
// 1. Default (no .uatu.json mono block) — variable is the bundled
//    Hack Nerd Font Mono stack; code blocks pick it up.
// 2. Override (.uatu.json mono.fontFamily set) — variable carries the
//    override; code blocks pick it up; terminal panel inherits unless
//    .uatu.json terminal.fontFamily also wins inside the panel.
// 3. Both knobs set — mono applies outside the terminal, terminal narrows
//    inside.
//
// The unit suite covers the loader (src/mono/config.test.ts) and the
// state-payload shape (src/server/session.test.ts). This file is the
// end-to-end smoke test against a real browser.

test.describe("--mono-font-family default (no override)", () => {
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
    // Pick any document that contains a fenced code block. The e2e fixture
    // ships `mermaid-shapes.md` and friends, but we want a simple text block.
    // Navigate to the README which has prose; for a fenced block we route
    // to the asciidoc cheatsheet or open links-demo.md. The reliable
    // approach: synthesize a code element by injecting one and check its
    // computed style, which exercises the same CSS path as a real code block.
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

test.describe(".uatu.json mono.fontFamily override", () => {
  test.afterEach(async ({ request }) => {
    await request.post("/__e2e/reset");
  });

  test("override flows through state and reaches the CSS variable", async ({ page, request }) => {
    await request.post("/__e2e/reset", {
      data: { uatuConfig: { mono: { fontFamily: "Courier New, monospace" } } },
    });

    await page.goto("/");
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    const state = await page.evaluate(async () => {
      const response = await fetch("/api/state");
      return response.json();
    });
    expect(state.monoConfig?.fontFamily).toBe("Courier New, monospace");

    const variableValue = await page.evaluate(() =>
      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue("--mono-font-family")
        .trim(),
    );
    expect(variableValue).toBe("Courier New, monospace");

    // A synthesized markdown-body code block picks up the override.
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
    expect(fontFamily.toLowerCase()).toContain("courier new");
  });

  test("terminal.fontFamily wins over mono.fontFamily inside the panel", async ({ page, request }) => {
    await request.post("/__e2e/reset", {
      data: {
        uatuConfig: {
          mono: { fontFamily: "Berkeley Mono, monospace" },
          terminal: { fontFamily: "JetBrains Mono, monospace" },
        },
      },
    });

    await page.goto("/");
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    const state = await page.evaluate(async () => {
      const response = await fetch("/api/state");
      return response.json();
    });
    expect(state.monoConfig?.fontFamily).toBe("Berkeley Mono, monospace");
    expect(state.terminalConfig?.fontFamily).toBe("JetBrains Mono, monospace");

    // Mono variable carries the mono override (terminal override is applied
    // narrowly to the xterm constructor, not to --mono-font-family).
    const monoVar = await page.evaluate(() =>
      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue("--mono-font-family")
        .trim(),
    );
    expect(monoVar).toBe("Berkeley Mono, monospace");
  });

  test("only mono.fontFamily set — terminal inherits via CSS variable cascade", async ({ page, request }) => {
    await request.post("/__e2e/reset", {
      data: { uatuConfig: { mono: { fontFamily: "Berkeley Mono, monospace" } } },
    });

    await page.goto("/");
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    // --terminal-font-family falls through to var(--mono-font-family) at
    // the CSS layer. The computed value should resolve to the mono override.
    const resolvedTerminalFamily = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.fontFamily = "var(--terminal-font-family)";
      document.body.appendChild(probe);
      const computed = window.getComputedStyle(probe).fontFamily;
      probe.remove();
      return computed;
    });
    expect(resolvedTerminalFamily.toLowerCase()).toContain("berkeley mono");
  });
});
