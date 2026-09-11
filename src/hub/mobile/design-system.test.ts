import { expect, test } from "bun:test";

const recipes = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const tokens = await Bun.file(new URL("./tokens.css", import.meta.url)).text();

test("theme roles are compact, relative and separate from measured layout", () => {
  for (const role of ["page", "detail", "editor", "body", "value", "control", "secondary", "label"]) {
    expect(tokens).toMatch(new RegExp(`--mh-type-${role}: [\\d.]+rem;`));
  }
  for (const role of ["canvas", "surface", "text", "muted", "action", "line", "selected", "positive", "danger", "warning", "field-background", "switch-on", "switch-off", "material"]) {
    expect(tokens).toContain(`--mh-${role}:`);
    expect(recipes).toContain(`var(--mh-${role})`);
  }
  expect(tokens).not.toMatch(/--mh-(keyboard|dock|flow-toolbar|overview-toolbar|prompt|visible)-/);
  expect(recipes).toContain("var(--mh-keyboard-clearance) + var(--mh-dock-clearance) + var(--mh-flow-toolbar-height)");
});

test("compact control hierarchy preserves Return identity above navigation labels", () => {
  const size = (role: string) => Number(tokens.match(new RegExp(`--mh-type-${role}: ([\\d.]+)rem;`))![1]);
  expect(size("control")).toBe(15 / 16);
  expect(size("control")).toBeGreaterThan(size("navigation"));
  expect(size("control")).toBeGreaterThan(size("secondary"));
  expect(size("value")).toBe(17 / 16);
  for (const selector of [".mh-return strong", ".mh-primary", ".mh-subtitle", ".mh-value", ".mh-flow-back"]) {
    const rule = recipes.slice(recipes.indexOf(`.mh-root ${selector} {`)).split("}")[0]!;
    expect(rule).toContain("font-size: var(--mh-type-control)");
  }
  for (const selector of [".mh-return small", ".mh-tab"]) {
    const rule = recipes.slice(recipes.indexOf(`.mh-root ${selector} {`)).split("}")[0]!;
    expect(rule).toContain("font-size: var(--mh-type-navigation)");
  }
  expect(recipes).toMatch(/\.mh-info dd \{[^}]*font-size: var\(--mh-type-value\)/);
  expect(recipes).toMatch(/\.mh-field textarea \{[^}]*font-size: var\(--mh-type-value\)/);
});

test("only noninteractive task heading entry focus suppresses the visible ring", () => {
  expect(recipes).toContain('.mh-root .mh-editor header h1[tabindex="-1"]:focus { outline: none; }');
  expect(recipes).toContain(".mh-root :focus-visible { outline: 3px solid var(--mh-action); outline-offset: 3px; }");
  const css = recipes.replace(/\/\*[\s\S]*?\*\//g, "");
  const editorFocusRules = [...css.matchAll(/([^{}]*\.mh-editor[^{}]*:focus[^{}]*)\{([^{}]*)\}/g)];
  expect(editorFocusRules).toHaveLength(1);
  expect(editorFocusRules[0]![1]!.trim()).toBe('.mh-root .mh-editor header h1[tabindex="-1"]:focus');
});

test("all variable references resolve to theme or measured owner outputs", () => {
  const declared = new Set([...`${tokens}\n${recipes}`.matchAll(/(--mh-[\w-]+):/g)].map(match => match[1]));
  for (const match of recipes.matchAll(/var\((--mh-[\w-]+)/g)) {
    expect(declared.has(match[1]) || ["--mh-prompt-height", "--mh-visible-height"].includes(match[1]!)).toBe(true);
  }
});

test("distinct editable, read-only, navigation and task recipes retain accessibility states", () => {
  expect(recipes).toMatch(/\.mh-root \.mh-field \{ display: grid;/);
  expect(recipes).toContain(".mh-root .mh-info dt");
  expect(recipes).toContain(".mh-root .mh-list-primary");
  expect(recipes).toMatch(/\.mh-root \.mh-editor \{[^}]*border-radius: 0;/);
  expect(recipes).toMatch(/\.mh-root \.mh-confirmation \{[^}]*max-width: 440px/);
  for (const state of [":focus-visible", ":disabled", '[aria-invalid="true"]', "input:checked", "prefers-reduced-transparency", "forced-colors", "overflow-wrap: anywhere"]) expect(recipes).toContain(state);
  for (const mode of ["prefers-color-scheme: dark", "prefers-contrast: more", "prefers-reduced-motion: reduce"]) expect(tokens).toContain(mode);
  expect(recipes).toContain(".mh-preference-choices .mh-check:has(input:checked)::after");
  expect(recipes).not.toContain(".mh-side-field");
  expect(recipes).not.toContain(".mh-sheet h2");
  expect(recipes).toContain(".mh-task > header > h2");
});

test("base selectors have one authoritative recipe (media overrides are explicit)", () => {
  const base = recipes.split("@media")[0]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]+;/g, "");
  const seen = new Set<string>();
  for (const match of base.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1]!.trim();
    expect(seen.has(selector)).toBe(false);
    seen.add(selector);
  }
});
