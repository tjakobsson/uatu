import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { ViewLayout } from "../shared/types";
import { ensureLayoutToolbar } from "./layout-toolbar";

function previewChrome() {
  const { document } = parseHTML(
    `<html><body><div class="preview-shell"><div id="file-facts-strip"></div><div id="preview"></div></div></body></html>`,
  );
  const doc = document as unknown as Document;
  const shell = doc.querySelector<HTMLElement>(".preview-shell")!;
  const preview = doc.querySelector<HTMLElement>("#preview")!;
  const selected: ViewLayout[] = [];
  const onSelect = (next: ViewLayout) => selected.push(next);
  return { doc, shell, preview, selected, onSelect };
}

function checkedValues(shell: HTMLElement): string[] {
  return [...shell.querySelectorAll<HTMLElement>(".uatu-layout-toolbar-segment")]
    .filter(button => button.getAttribute("aria-checked") === "true")
    .map(button => button.getAttribute("data-layout-value") ?? "");
}

describe("ensureLayoutToolbar", () => {
  test("mounts one radiogroup directly above #preview with the current layout checked", () => {
    const { shell, preview, onSelect } = previewChrome();
    ensureLayoutToolbar(shell, preview, true, "single", onSelect);

    const toolbar = shell.querySelector<HTMLElement>(".uatu-layout-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar!.getAttribute("role")).toBe("radiogroup");
    expect(toolbar!.nextElementSibling).toBe(preview);
    const values = [...toolbar!.querySelectorAll("[data-layout-value]")].map(b => b.getAttribute("data-layout-value"));
    expect(values).toEqual(["single", "split-h", "split-v"]);
    expect(checkedValues(shell)).toEqual(["single"]);
    expect(shell.querySelector(".uatu-layout-toolbar-segment.is-active")?.getAttribute("data-layout-value")).toBe("single");
  });

  test("a later render updates the same toolbar and buttons in place instead of rebuilding them", () => {
    const { shell, preview, onSelect } = previewChrome();
    ensureLayoutToolbar(shell, preview, true, "single", onSelect);
    const toolbar = shell.querySelector<HTMLElement>(".uatu-layout-toolbar")!;
    const singleButton = toolbar.querySelector<HTMLElement>("[data-layout-value='single']")!;
    const splitButton = toolbar.querySelector<HTMLElement>("[data-layout-value='split-h']")!;

    // The render that completes a switch into side-by-side (or a live reload
    // of the open document) must not detach the button under the pointer: a
    // click whose mousedown and mouseup land on different elements is lost.
    ensureLayoutToolbar(shell, preview, true, "split-h", onSelect);

    expect(shell.querySelectorAll(".uatu-layout-toolbar")).toHaveLength(1);
    expect(shell.querySelector(".uatu-layout-toolbar")).toBe(toolbar);
    expect(toolbar.querySelector("[data-layout-value='single']")).toBe(singleButton);
    expect(singleButton.isConnected).toBe(true);
    expect(checkedValues(shell)).toEqual(["split-h"]);
    expect(splitButton.classList.contains("is-active")).toBe(true);
    expect(singleButton.classList.contains("is-active")).toBe(false);
  });

  test("buttons keep dispatching their layout after in-place updates", () => {
    const { shell, preview, selected, onSelect } = previewChrome();
    ensureLayoutToolbar(shell, preview, true, "single", onSelect);
    ensureLayoutToolbar(shell, preview, true, "split-h", onSelect);
    ensureLayoutToolbar(shell, preview, true, "split-v", onSelect);

    shell.querySelector<HTMLElement>("[data-layout-value='single']")!.click();
    expect(selected).toEqual(["single"]);
  });

  test("hiding removes the toolbar, and showing again builds a fresh one", () => {
    const { shell, preview, onSelect } = previewChrome();
    ensureLayoutToolbar(shell, preview, true, "single", onSelect);
    ensureLayoutToolbar(shell, preview, false, "single", onSelect);
    expect(shell.querySelector(".uatu-layout-toolbar")).toBeNull();

    ensureLayoutToolbar(shell, preview, true, "split-v", onSelect);
    expect(shell.querySelector(".uatu-layout-toolbar")?.nextElementSibling).toBe(preview);
    expect(checkedValues(shell)).toEqual(["split-v"]);
  });
});
