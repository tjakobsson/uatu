import { expect, test } from "bun:test";

const hub = await Bun.file(new URL("../../src/hub/mobile/styles.css", import.meta.url)).text();
const preview = await Bun.file(new URL("../../src/preview/file-navigation.css", import.meta.url)).text();
const shell = await Bun.file(new URL("../../src/styles.css", import.meta.url)).text();
const markup = await Bun.file(new URL("../../src/index.html", import.meta.url)).text();

test("radio preferences keep checkmarks and values wrap without shrinking", () => {
  expect(hub).toMatch(/\.mh-preference-choices input\[type="radio"\]\s*\{[^}]*inset: 0;[^}]*width: 100%;[^}]*height: 100%/);
  expect(hub).toContain('.mh-check:has(input:checked)::after { visibility: visible; }');
  expect(hub).toContain('.mh-check:has(input:focus-visible) { outline: 3px solid var(--mh-action);');
  expect(hub).toMatch(/\.mh-root \.mh-value\s*\{[^}]*flex-shrink: 0;[^}]*max-width: 38%/);
  expect(hub.match(/\.mh-root \.mh-value\s*\{[^}]*\}/)?.[0]).not.toContain("nowrap");
});

test("normal Preview rim is luminous; contrast alternatives are explicit", () => {
  const pill = preview.match(/\.preview-nav-pill\s*\{([^}]+)\}/)![1]!;
  expect(pill).toContain("border: 1px solid rgb(255 255 255 / 65%)");
  expect(pill).toContain("background: rgb(255 255 255 / 76%)");
  expect(pill).toContain("blur(24px)");
  expect(preview).toContain("@media (forced-colors: active)");
  expect(preview).toContain("border: 1px solid CanvasText");
  expect(preview).toContain(".preview-nav-arrow:disabled { color: GrayText; }");
  expect(preview).toContain("min-width: 44px"); expect(preview).toContain("min-height: 44px");
});

test("workspace SVGs are local silhouettes, not text or a boxed terminal", () => {
  const terminal = markup.slice(markup.indexOf('id="touch-tab-terminal"'), markup.indexOf('id="navigation-preferences-dialog"'));
  expect(terminal).toContain('d="m4 3.5 4 4.5-4 4.5M9.5 12.5H14"');
  expect(terminal).not.toContain("M2 3h12v10H2z");
  const handle = markup.slice(markup.indexOf('id="navigation-handle"'), markup.indexOf('id="navigation-handle-help"'));
  expect(handle).toContain("<svg"); expect(handle).not.toContain("&rsaquo;");
  expect(shell).toContain(".touch-tab-label {\n  font-size: 0.6875rem;\n  font-weight: 400;");
  expect(shell).toContain("html[data-ui-mode=\"touch\"] .touch-tab-bar");
  // Changes to the floating chrome must not create a permanent interior gutter.
  expect(shell).toContain('html[data-ui-mode="touch"] { --tab-bar-total: 0px; }');
});
