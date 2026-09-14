import { describe, expect, test } from "bun:test";
import path from "node:path";

// The activity chrome's colour is chosen for contrast, and a retune of one
// theme's value would silently undo it. Hold the ratio here, against every
// surface the chrome sits on, so the stylesheet cannot drift below it.

function lightDark(css: string, name: string): [string, string] {
  const match = css.match(new RegExp(`--${name}: light-dark\\((#[0-9a-fA-F]{6}), (#[0-9a-fA-F]{6})\\)`));
  if (!match) throw new Error(`no light-dark token --${name}`);
  return [match[1]!, match[2]!];
}

function luminance(hex: string): number {
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map(at => channel(Number.parseInt(hex.slice(at, at + 2), 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("activity chrome contrast", () => {
  test("--chat-activity-fg reads at 7:1 or better on both surfaces in both themes, and stays quieter than prose", async () => {
    const css = await Bun.file(path.resolve(import.meta.dir, "../styles.css")).text();
    const chrome = lightDark(css, "chat-activity-fg");
    const subtle = lightDark(css, "text-subtle");
    const strong = lightDark(css, "text-strong");
    const surfaces = [lightDark(css, "surface"), lightDark(css, "surface-raised")];
    for (const theme of [0, 1] as const) {
      for (const surface of surfaces) {
        expect(contrast(chrome[theme], surface[theme])).toBeGreaterThanOrEqual(7);
        // Stronger than the secondary-label colour, quieter than prose.
        expect(contrast(chrome[theme], surface[theme])).toBeGreaterThan(contrast(subtle[theme], surface[theme]));
        expect(contrast(chrome[theme], surface[theme])).toBeLessThan(contrast(strong[theme], surface[theme]));
      }
    }
  });

  test("the shell block and the ansi classes draw only from the terminal variables", async () => {
    const css = await Bun.file(path.resolve(import.meta.dir, "../styles.css")).text();
    const block = css.match(/\.chat-activity pre\.chat-tool-terminal \{[^}]*\}/)?.[0];
    expect(block).toContain("font-family: var(--terminal-font-family)");
    expect(block).toContain("background: var(--terminal-bg)");
    expect(block).toContain("white-space: pre");
    const ansiRules = css.match(/^\.ansi-[^\n]*$/gm) ?? [];
    expect(ansiRules.length).toBeGreaterThanOrEqual(34);
    for (const rule of ansiRules) expect(rule).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    for (let index = 0; index < 16; index += 1) {
      expect(css).toContain(`.ansi-fg-${index}`);
      expect(css).toContain(`.ansi-bg-${index}`);
    }
  });
});
