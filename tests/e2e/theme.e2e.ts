// System-theme e2e: the app follows the OS color scheme (emulated via
// Playwright's colorScheme), restyles live on a flip without a reload,
// re-renders mermaid diagrams, updates the theme-color meta, and keeps
// the terminal palette dark in both schemes. Spec:
// openspec/changes/add-system-theme/specs/system-theme/spec.md

import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

async function rootStyles(page: Page): Promise<{ background: string; color: string; terminalBg: string }> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      background: style.backgroundColor,
      color: style.color,
      terminalBg: style.getPropertyValue("--terminal-bg").trim(),
    };
  });
}

async function themeColorMeta(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
  );
}

test("dark scheme renders dark chrome, dark markdown, dark code palette", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      dirty: {
        "dark-doc.md": ["# Dark Doc", "", "```js", "const x = 1;", "```", ""].join("\n"),
      },
    },
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await treeRow(page, "dark-doc.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Dark Doc");

  const styles = await rootStyles(page);
  expect(styles.background).toBe("rgb(13, 17, 23)");
  expect(styles.color).toBe("rgb(230, 237, 243)");

  // Vendored dark siblings: github-markdown-dark styles the rendered body,
  // hljs github-dark styles the fenced code block.
  const markdownColor = await page
    .locator("#preview.markdown-body")
    .evaluate(el => getComputedStyle(el).color);
  expect(markdownColor).not.toBe("rgb(31, 35, 40)");
  const hljsColor = await page
    .locator("#preview code.hljs")
    .first()
    .evaluate(el => getComputedStyle(el).color);
  expect(hljsColor).toBe("rgb(201, 209, 217)");

  expect(await themeColorMeta(page)).toBe("#0d1117");
});

test("light scheme keeps the pre-theme-system appearance", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  const styles = await rootStyles(page);
  expect(styles.background).toBe("rgb(255, 255, 255)");
  expect(styles.color).toBe("rgb(36, 41, 47)");
  // The light meta stays the brand navy from index.html.
  expect(await themeColorMeta(page)).toBe("#0a1c38");
});

test("terminal palette stays dark in both schemes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  expect((await rootStyles(page)).terminalBg).toBe("#0b1220");

  await page.emulateMedia({ colorScheme: "dark" });
  expect((await rootStyles(page)).terminalBg).toBe("#0b1220");
});

test("an OS scheme flip restyles live, re-renders mermaid, updates theme-color", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      dirty: {
        "flip-doc.md": ["# Flip Doc", "", "```mermaid", "graph TD; A-->B;", "```", ""].join("\n"),
      },
    },
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await treeRow(page, "flip-doc.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Flip Doc");
  await expect(page.locator("#preview .mermaid svg")).toBeVisible();
  const lightSvg = await page.locator("#preview .mermaid").innerHTML();

  // Marker proves the flip restyles WITHOUT a page reload.
  await page.evaluate(() => {
    (window as unknown as { __noReloadMarker?: boolean }).__noReloadMarker = true;
  });

  await page.emulateMedia({ colorScheme: "dark" });

  await expect.poll(() => rootStyles(page).then(s => s.background)).toBe("rgb(13, 17, 23)");
  expect(await themeColorMeta(page)).toBe("#0d1117");
  // The visible diagram re-renders with dark theme inputs — new SVG markup.
  await expect
    .poll(async () => {
      const svg = await page.locator("#preview .mermaid svg").count();
      if (svg === 0) return "pending";
      const html = await page.locator("#preview .mermaid").innerHTML();
      return html === lightSvg ? "unchanged" : "re-rendered";
    })
    .toBe("re-rendered");
  expect(
    await page.evaluate(() => (window as unknown as { __noReloadMarker?: boolean }).__noReloadMarker),
  ).toBe(true);

  // Flip back: the page returns to the light palette live.
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => rootStyles(page).then(s => s.background)).toBe("rgb(255, 255, 255)");
  expect(await themeColorMeta(page)).toBe("#0a1c38");
});
