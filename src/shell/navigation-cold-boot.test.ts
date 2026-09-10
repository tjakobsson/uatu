import { expect, test } from "bun:test";

test("cold workspace markup withholds both navigation controls until their owner places them", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
  for (const id of ["navigation-handle", "touch-tab-bar"]) {
    const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];
    expect(tag).toBeDefined();
    expect(tag).toMatch(/\binert\b/);
    expect(tag).not.toContain("data-navigation-ready");
  }
  expect(css).toMatch(/:is\(\.touch-tab-bar, \.navigation-handle\):not\(\[data-navigation-ready\]\)\s*\{\s*visibility: hidden;\s*pointer-events: none;/);
});
