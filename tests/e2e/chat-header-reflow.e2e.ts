import { test as base, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { enlargedPendingFixture } from "./enlarged-pending-fixture";
import { captureScreenshot, saveEvidence } from "./evidence";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  for (const width of [320, 390, 844]) for (const theme of ["light", "dark"] as const) {
    test(`native conversation header reflows without painted overflow: ${engine} ${theme} ${width}`, async ({ launchBrowser, baseURL, request }, info) => {
      const browser = await launchBrowser(engine);
      const page = await browser.newPage({ baseURL, viewport: { width, height: width === 844 ? 390 : 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      try {
        await enlargedPendingFixture(page, request, width, theme);
        // The shared fixture seeds at 844px tall. Apply the actual landscape
        // band afterward so this case cannot silently remain a square tablet.
        if (width === 844) await page.setViewportSize({ width, height: 390 });
        expect(page.viewportSize()).toEqual({ width, height: width === 844 ? 390 : 844 });
        const picker = page.getByRole("combobox", { name: "Conversation", exact: true });
        const selected = await picker.inputValue();
        const titles = [null,
          "A long conversation title that must stay inside its native picker while every header action remains available",
          "An_unbroken_conversation_title_that_must_not_expand_the_native_selected_value_beyond_the_available_header_width",
        ];
        for (const title of titles) {
          if (title) {
            await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
            await page.getByRole("button", { name: "Rename conversation", exact: true }).click();
            await page.locator("#chat-rename-title").fill(title);
            await page.locator("#chat-rename-title").press("Enter");
            await expect(page.locator("#chat-rename-form")).toBeHidden();
            await expect(picker.locator("option:checked")).toContainText(title);
          }
          for (const percent of [200, 100, 200]) {
            await page.evaluate(percent => { document.documentElement.style.fontSize = `${percent}%`; }, percent);
            await page.evaluate(() => document.fonts.ready);
            // Linux WebKit can report a fitting layout before its native control
            // paints. Force that paint before measuring, without retaining images.
            await page.screenshot({ animations: "disabled" });
            if ((title === null || title === titles.at(-1)) && percent === 100) {
              await captureScreenshot(page, info, `native-header-${engine}-${theme}-${width}-${title ? "long" : "initial"}`);
            }
            if (width === 844 && title === titles.at(-1) && percent === 200) {
              await captureScreenshot(page, info, `native-header-${engine}-${theme}-landscape-enlarged`);
            }
            const geometry = await page.evaluate(() => {
              const selectors = ["#chat-surface", "#chat-work-dock", ".chat-header", ".chat-conversation-controls", ".chat-conversation-picker", "#chat-conversation-select", ".chat-conversation-controls > button:not([hidden])"];
              return selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)])
                .filter(node => node.getClientRects().length > 0).map(node => {
                  const id = node.id || node.className;
                  const box = node.getBoundingClientRect();
                  return { id, width: node.clientWidth, scroll: node.scrollWidth, box: box.toJSON(),
                    font: getComputedStyle(node).fontSize,
                    overflow: getComputedStyle(node).overflowX,
                    contain: getComputedStyle(node).contain,
                    hit: node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
                    // The select itself must receive hits at both block edges;
                    // a taller wrapper with dead padding is not a touch target.
                    // Stay one CSS pixel inside: Chromium rounds the paint
                    // containment hit boundary at fractional layout edges.
                    blockEdges: [box.top + 1, box.bottom - 1].map(y => {
                      const target = document.elementFromPoint(box.x + box.width / 2, y);
                      return { hit: node.contains(target), target: target?.id || target?.className };
                    }) };
                });
            });
            await saveEvidence(info, `header-${percent}-${info.attachments.length}.json`, JSON.stringify(geometry, null, 2));
            for (const node of geometry) {
              expect(node.box.left).toBeGreaterThanOrEqual(0);
              expect(node.box.right).toBeLessThanOrEqual(width);
              if (["chat-surface", "chat-work-dock", "chat-header", "chat-conversation-controls"].includes(node.id)) {
                expect(node.scroll).toBeLessThanOrEqual(node.width);
                // The regression must not pass by clipping a header or its actions.
                if (["chat-header", "chat-conversation-controls"].includes(node.id)) expect(["hidden", "clip"]).not.toContain(node.overflow);
              }
              else {
                expect(node.hit).toBe(true);
                expect(node.box.height).toBeGreaterThanOrEqual(44);
              }
            }
            const select = geometry.find(node => node.id === "chat-conversation-select")!;
            const wrapper = geometry.find(node => node.id === "chat-conversation-picker")!;
            expect(select.blockEdges.every(edge => edge.hit)).toBe(true);
            expect(select.box.height).toBeGreaterThanOrEqual(wrapper.box.height);
            expect(wrapper.contain).toBe("paint");
            expect(select.box.left).toBeGreaterThanOrEqual(wrapper.box.left);
            expect(select.box.right).toBeLessThanOrEqual(wrapper.box.right);
            expect(select.font).toBe(`${16 * percent / 100}px`);
            // The selected title gives up width, never another row. Keep all
            // actions beside the native picker, including at enlarged text.
            const actions = geometry.filter(node => /chat-(rename|new)-conversation/.test(node.id));
            expect(actions).toHaveLength(2);
            for (const action of actions) {
              expect(action.box.top).toBeLessThan(select.box.bottom);
              expect(action.box.bottom).toBeGreaterThan(select.box.top);
              expect(action.box.width).toBeGreaterThanOrEqual(44);
              expect(action.blockEdges.every(edge => edge.hit)).toBe(true);
            }
          }
        }
        await expect(picker).toHaveValue(selected);
        expect(await picker.evaluate(node => node instanceof HTMLSelectElement && node.labels!.length > 0 && node.options.length > 0)).toBe(true);
        // Keep real keyboard focus and the native picker; reflow must not
        // replace them with clipped replicas or inaccessible custom controls.
        await picker.focus();
        await expect(picker).toBeFocused();
        const focus = await picker.evaluate(node => {
          const wrapper = node.closest(".chat-conversation-picker")!;
          const style = getComputedStyle(wrapper);
          return { within: wrapper.matches(":focus-within"), outline: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) };
        });
        expect(focus).toMatchObject({ within: true, outline: "solid" });
        expect(focus.width).toBeGreaterThanOrEqual(2);
        expect(focus.offset).toBeGreaterThanOrEqual(0);
        // macOS WebKit uses Option-Tab to include buttons when system Full
        // Keyboard Access is off. Keep the same focus-order assertions on
        // every host without changing the user's system preferences.
        const nextControl = engine === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
        await picker.press(nextControl);
        await expect(page.getByRole("button", { name: "Rename conversation", exact: true })).toBeFocused();
        await page.keyboard.press(nextControl);
        await expect(page.getByRole("button", { name: "New conversation", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(picker).not.toHaveValue(selected);
        if (width === 390) {
          // A separate desktop context exercises the normal-sized native popup,
          // not merely the touch control's measured box at enlarged text.
          const desktop = await browser.newPage({ baseURL, viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
          try {
            await enlargedPendingFixture(desktop, request, 1280, theme);
            await desktop.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
            const desktopPicker = desktop.getByRole("combobox", { name: "Conversation", exact: true });
            const previous = await desktopPicker.inputValue();
            await desktop.getByRole("button", { name: "New conversation", exact: true }).click();
            await expect(desktopPicker).not.toHaveValue(previous);
            const values = await desktopPicker.locator("option").evaluateAll(options => options.map(option => option.value).filter(Boolean));
            expect(values.length).toBeGreaterThanOrEqual(2);
            const target = values.at(-1)!;
            await desktopPicker.selectOption(target);
            const title = "ZZZ Desktop native picker retains the complete long conversation title during keyboard selection";
            await desktop.getByRole("button", { name: "Rename conversation", exact: true }).click();
            await desktop.locator("#chat-rename-title").fill(title);
            await desktop.locator("#chat-rename-title").press("Enter");
            await expect(desktop.locator("#chat-rename-form")).toBeHidden();
            await desktopPicker.selectOption(values[0]!);
            await desktopPicker.focus();
            await desktopPicker.press("Space");
            await desktopPicker.press("ArrowDown");
            await desktopPicker.press("z");
            await desktopPicker.press("Enter");
            await expect(desktopPicker).toHaveValue(target);
            await expect(desktopPicker.locator("option:checked")).toContainText(title);
            await expect(desktopPicker).toBeFocused();
            // The change reaches the conversation model, not just the DOM value.
            await expect(desktop.locator("#chat-title")).toHaveText(title);
            await captureScreenshot(desktop, info, `native-header-${engine}-${theme}-desktop-long`);
            expect(await desktopPicker.evaluate(node => {
              const control = node.getBoundingClientRect();
              const header = node.closest(".chat-header")!;
              const bounds = header.getBoundingClientRect();
              return node instanceof HTMLSelectElement && control.width > 0 && control.left >= bounds.left
                && control.right <= bounds.right && header.scrollWidth <= header.clientWidth;
            })).toBe(true);
          } finally { await desktop.close(); }
        }
      } finally { await page.close(); }
    });
  }
}
