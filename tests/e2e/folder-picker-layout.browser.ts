/** Server-free CSS regression: bun tests/e2e/folder-picker-layout.browser.ts */
import { chromium, expect } from "@playwright/test";
import { createTaskView } from "../../src/hub/mobile/task-view";
import { action, emptyState, listRow } from "../../src/hub/mobile/design-system";
import { escapeHtml } from "../../src/shared/html";

const tokens = await Bun.file(new URL("../../src/hub/mobile/tokens.css", import.meta.url)).text();
const css = await Bun.file(new URL("../../src/hub/mobile/styles.css", import.meta.url)).text();
const name = "current-folder-with-a-very-long-accessible-name-".repeat(3);
const path = `/remote/${"long-parent-directory/".repeat(8)}${name}`;
const rows = Array.from({ length: 80 }, (_, i) => listRow(`folder-${i}`, `Folder ${i} ${"long-name-".repeat(8)}`)).join("");
const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }]) {
    for (const textScale of [1, 2]) {
      for (const colorMode of ["light", "dark", "forced"] as const) {
      const page = await browser.newPage({ viewport });
      await page.emulateMedia({ colorScheme: colorMode === "dark" ? "dark" : "light", forcedColors: colorMode === "forced" ? "active" : "none", reducedMotion: "reduce" });
      await page.setContent(`<style>html,body{height:100%;margin:0}html{font-size:${16 * textScale}px}${tokens}${css.replace('@import "./tokens.css";', "")}</style><div class="mh-root"><div id="host"></div></div>`);
      // Execute the real TaskView implementation, without a server or copied markup.
      await page.addScriptTag({ content: `const esc = ${escapeHtml.toString()}; window.makeTask = ${createTaskView.toString()};` });
      for (const state of ["list", "empty", "error", "loading"]) {
        const content = state === "list" ? `<div class="mh-folder-list">${rows}</div>`
          : state === "empty" ? `<div class="mh-folder-empty">${emptyState("folder", "No subfolders", "Files aren’t shown here. Tap Choose to use this folder.")}</div>`
          : state === "error" ? `<div class="mh-folder-error" role="alert"><p class="mh-note">This folder could not be loaded.</p>${action("retry", "Retry")}</div>`
          : '<p role="status">Loading folders…</p>';
        await page.evaluate(({ name, path, content, state }) => {
          const win = window as any;
          win.chosen = false;
          const task = win.makeTask(document.querySelector("#host"), () => true, () => {});
          const root = task.open(state === "loading" ? "Choose Folder" : name,
            `<div class="mh-folder-location"><code>${path}</code></div><nav class="mh-folder-parent"><button class="mh-text-action mh-folder-parent-link">Up to parent</button></nav>${content}`,
            { label: "Choose", run: () => { win.chosen = true; } });
          root.classList.add("mh-folder-picker");
          root.querySelector("h1").title = state === "loading" ? "Choose Folder" : name;
          root.querySelector('[data-action="commit-sheet"]').disabled = state === "loading" || state === "error";
        }, { name, path, content, state });
        const header = page.locator(".mh-folder-picker > header");
        const before = await header.boundingBox();
        expect(before!.height).toBeLessThan(viewport.height / 2);
        await page.locator(".mh-sheet-body").evaluate(body => { body.scrollTop = body.scrollHeight; });
        expect(await header.boundingBox()).toEqual(before);
        for (const label of ["Cancel", "Choose"]) {
          const button = page.getByRole("button", { name: label, exact: true });
          await expect(button).toBeInViewport();
          const box = await button.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
          expect(box!.width).toBeGreaterThanOrEqual(44);
        }
        expect(await page.locator(".mh-folder-picker").evaluate(root => root.scrollTop)).toBe(0);
        expect(await page.locator(".mh-sheet-body").evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
        expect(await page.locator(".mh-folder-location").textContent()).toBe(path);
        if (state === "list") {
          await expect(page.locator('[data-flow="folder-79"]')).toBeInViewport();
          await expect(page.getByRole("heading", { name, exact: true })).toHaveAttribute("title", name);
          await page.getByRole("button", { name: "Choose", exact: true }).click();
          expect(await page.evaluate(() => (window as any).chosen)).toBe(true);
        }
      }
      await page.close();
      }
    }
  }
  console.log("Folder-picker browser layout: 48 viewport/text/state/color combinations passed (reduced motion).");
} finally {
  await browser.close();
}
