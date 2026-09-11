import { expect, test } from "bun:test";

const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const tokens = await Bun.file(new URL("./tokens.css", import.meta.url)).text();
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1]!.includes(".mh-folder-picker"));
const recipe = rules.map(match => match[0]).join("\n");
function rule(selector: string) {
  const found = rules.find(match => match[1]!.trim() === `.mh-root ${selector}`);
  expect(found).toBeDefined();
  return found![2]!;
}

test("folder body is the sole scrollport so ordinary flex header stays visible without dock gutter", () => {
  expect(rule(".mh-editor.mh-folder-picker")).toContain("overflow: hidden");
  expect(rule(".mh-editor.mh-folder-picker")).toContain("display: flex");
  expect(css).toMatch(/\.mh-root \.mh-editor header \{[^}]*flex: 0 0 auto/);
  const body = rule(".mh-folder-picker .mh-sheet-body");
  expect(body).toContain("flex: 1");
  expect(body).toContain("min-height: 0");
  expect(body).toContain("overflow: auto");
  expect(body).toContain("env(safe-area-inset-right)");
  expect(body).toContain("env(safe-area-inset-left)");
  expect(recipe).not.toMatch(/dock-clearance|toolbar-height|position:\s*(fixed|sticky)|max-height|100[vds]*vh/);
});

test("compact header truncates only heading presentation, never actions or body path", () => {
  expect(rule(".mh-folder-picker > header")).toContain("grid-template-columns: minmax(var(--mh-target), 1fr) minmax(0, 2fr) minmax(var(--mh-target), 1fr)");
  expect(rule('.mh-folder-picker > header [data-action="cancel-sheet"]')).toContain("grid-column: 1");
  expect(rule('.mh-folder-picker > header [data-action="commit-sheet"]')).toContain("grid-column: 3");
  expect(rule(".mh-folder-picker > header h1")).toContain("grid-column: 2");
  expect(rule(".mh-folder-picker > header h1")).toContain("text-overflow: ellipsis");
  for (const selector of [".mh-folder-picker > header button"]) {
    expect(rule(selector)).toContain("white-space: normal");
    expect(rule(selector)).toContain("overflow-wrap: anywhere");
  }
  expect(rule(".mh-folder-picker > header button")).not.toMatch(/ellipsis|overflow:\s*hidden|white-space:\s*nowrap/);
  expect(rule(".mh-folder-picker .mh-folder-parent-link")).toContain("gap: var(--mh-space-2)");
  expect(rule(".mh-folder-picker > header button")).toContain("min-height: var(--mh-target)");
  expect(rule(".mh-folder-picker .mh-folder-parent")).toContain("min-height: var(--mh-target)");
  expect(tokens).toContain("--mh-target: 44px");
});

test("read-only location stays selectable and wraps while statuses retain semantic roles", () => {
  const location = rule(".mh-folder-picker .mh-folder-location");
  for (const declaration of ["user-select: text", "white-space: pre-wrap", "overflow-wrap: anywhere", "font-size: var(--mh-type-secondary)"]) expect(location).toContain(declaration);
  expect(rule(".mh-folder-picker .mh-folder-empty")).toContain("var(--mh-muted)");
  expect(rule(".mh-folder-picker .mh-folder-error")).toContain("var(--mh-danger)");
});

test("picker is locally scoped and inherits light/dark, forced-color and reduced-motion accessibility", () => {
  for (const match of rules) {
    const selectors = match[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim().split(",");
    for (const selector of selectors) expect(selector.trim()).toMatch(/^\.mh-root \.(?:mh-editor\.)?mh-folder-picker(?:\s|$)/);
  }
  expect(recipe).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|animation:|transition:|forced-color-adjust:|outline:|\.mh-workspace/);
  expect(tokens).toContain("prefers-color-scheme: dark");
  expect(tokens).toContain("prefers-reduced-motion: reduce");
  expect(css).toContain("@media (forced-colors: active)");
  expect(css).toContain(".mh-root :focus-visible { outline: 3px solid var(--mh-action)");
  expect(css).toContain('.mh-root .mh-editor header h1[tabindex="-1"]:focus { outline: none; }');
});
