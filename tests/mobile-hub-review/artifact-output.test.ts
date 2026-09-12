import { expect, test } from "bun:test";
import { relative, isAbsolute } from "node:path";
import boundary from "./preview-boundary.config";
import preview from "./preview-refinement.config";
import navigation from "./navigation-recovery.config";
import picker from "./focused-picker.config";
import compact from "./compact-gallery.config";

test("raw JSON reporters default to local artifacts, not the curated review package", () => {
  const root = new URL("./results/artifacts/", import.meta.url).pathname;
  const outputs: string[] = [];
  for (const config of [boundary, preview, navigation, picker, compact]) {
    expect(Array.isArray(config.reporter)).toBe(true);
    const reporter = (config.reporter as [string, { outputFile?: string }][]).find(([name]) => name === "json");
    const output = reporter?.[1].outputFile;
    expect(typeof output).toBe("string");
    const path = relative(root, output!);
    expect(isAbsolute(path)).toBe(false);
    expect(path.startsWith("..")).toBe(false);
    expect(path.endsWith(".json")).toBe(true);
    outputs.push(output!);
  }
  expect(new Set(outputs).size).toBe(5);
});

test("local artifact outputs are covered by the reviewer's existing ignore rule", async () => {
  const ignore = await Bun.file(new URL("./.gitignore", import.meta.url)).text();
  expect(ignore.split(/\r?\n/)).toContain("results/");
});
