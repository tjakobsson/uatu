import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  __resetMermaidStateForTests,
  normalizeMermaidSvg,
  normalizeRenderedDiagram,
  renderMermaidDiagrams,
  replaceMermaidCodeBlocks,
} from "./preview";

describe("replaceMermaidCodeBlocks", () => {
  test("converts mermaid code fences into mermaid nodes", () => {
    const html = '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>';
    const transformed = replaceMermaidCodeBlocks(html);

    expect(transformed).toBe('<div class="mermaid">graph TD\nA--&gt;B</div>');
  });
});

describe("rendered diagram normalization", () => {
  let doc: Document;

  beforeEach(() => {
    doc = parseHTML("<!doctype html><html><body></body></html>").document as unknown as Document;
    __resetMermaidStateForTests();
  });

  test("normalizeMermaidSvg lifts intended pixel size from style.maxWidth onto the width attribute", () => {
    // Mermaid emits `width="100%"` (a percentage) and the intended display
    // size in `style="max-width: Wpx"`. We rewrite the width attribute with
    // the explicit pixel value so the SVG has a real intrinsic size.
    const div = doc.createElement("div");
    div.className = "mermaid";
    div.innerHTML =
      '<svg style="max-width: 412px;" width="100%" height="auto" viewBox="0 0 412 240"></svg>';
    const svg = div.querySelector("svg") as unknown as SVGElement;

    normalizeMermaidSvg(svg);

    // Width attribute is now the explicit pixel value from Mermaid's intent.
    expect(svg.getAttribute("width")).toBe("412");
    // Height attribute stripped so CSS `height: auto` can recompute from viewBox.
    expect(svg.getAttribute("height")).toBeNull();
    // Mermaid's library-chosen max-width hint is preserved verbatim.
    expect(svg.style.maxWidth).toBe("412px");
    // viewBox preserved verbatim.
    expect(svg.getAttribute("viewBox")).toBe("0 0 412 240");
  });

  test("normalizeMermaidSvg leaves width attribute unchanged when style.maxWidth is missing", () => {
    const div = doc.createElement("div");
    div.className = "mermaid";
    div.innerHTML = '<svg width="100%" viewBox="0 0 100 50"></svg>';
    const svg = div.querySelector("svg") as unknown as SVGElement;

    normalizeMermaidSvg(svg);

    // No reliable px hint means we leave width alone; the trigger may fall
    // back to UA defaults. Acceptable — only happens for malformed inputs.
    expect(svg.getAttribute("width")).toBe("100%");
  });

  test("normalizeRenderedDiagram wraps the SVG in a button trigger with badge", () => {
    const div = doc.createElement("div");
    div.className = "mermaid";
    div.innerHTML =
      '<svg style="max-width: 412px;" width="412" height="240" viewBox="0 0 412 240"></svg>';

    normalizeRenderedDiagram(div as unknown as HTMLElement);

    const trigger = div.querySelector("button.mermaid-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("type")).toBe("button");
    expect(trigger?.querySelector("svg")).not.toBeNull();
    expect(trigger?.querySelector(".mermaid-trigger-badge")).not.toBeNull();
  });

  test("normalizeRenderedDiagram is idempotent", () => {
    const div = doc.createElement("div");
    div.className = "mermaid";
    div.innerHTML = '<svg viewBox="0 0 100 100"></svg>';

    normalizeRenderedDiagram(div as unknown as HTMLElement);
    normalizeRenderedDiagram(div as unknown as HTMLElement);

    expect(div.querySelectorAll("button.mermaid-trigger").length).toBe(1);
  });
});

describe("renderMermaidDiagrams theme inputs", () => {
  let doc: Document;

  beforeEach(() => {
    doc = parseHTML("<!doctype html><html><body></body></html>").document as unknown as Document;
    __resetMermaidStateForTests();
  });

  afterEach(() => {
    delete (globalThis as { mermaid?: unknown }).mermaid;
  });

  test("re-initializes only when theme inputs change", async () => {
    const initialize = mock(() => undefined);
    const run = mock(async () => undefined);
    (globalThis as { mermaid?: unknown }).mermaid = { initialize, run };

    const container = doc.createElement("div");
    container.innerHTML = '<div class="mermaid">graph TD; A-->B;</div>';

    await renderMermaidDiagrams(container as unknown as ParentNode, { theme: "default" });
    await renderMermaidDiagrams(container as unknown as ParentNode, { theme: "default" });
    expect(initialize.mock.calls.length).toBe(1);

    await renderMermaidDiagrams(container as unknown as ParentNode, { theme: "dark" });
    expect(initialize.mock.calls.length).toBe(2);
    expect(initialize.mock.calls[1][0].theme).toBe("dark");

    // themeVariables change also triggers re-init.
    await renderMermaidDiagrams(container as unknown as ParentNode, {
      theme: "dark",
      themeVariables: { primaryColor: "#fff" },
    });
    expect(initialize.mock.calls.length).toBe(3);
    expect(initialize.mock.calls[2][0].themeVariables).toEqual({ primaryColor: "#fff" });
  });

  test("a bad diagram does not reject the batch and other diagrams still render", async () => {
    // Regression: mid-edit typos (e.g., `flowchat` instead of `flowchart`)
    // used to reject `mermaid.run`, surfacing as Bun's unhandled-rejection
    // overlay and aborting the rest of `applyDocumentPayload`.
    const initialize = mock(() => undefined);
    const run = mock(async (options: { nodes: HTMLElement[]; suppressErrors?: boolean }) => {
      // Stand in for Mermaid's `suppressErrors` behavior: paint an error
      // indicator on bad nodes, an OK SVG on good nodes, resolve cleanly.
      for (const node of options.nodes) {
        const isBad = node.textContent?.includes("flowchat") ?? false;
        node.innerHTML = isBad
          ? '<svg data-mermaid-error="true"></svg>'
          : '<svg data-mermaid-ok="true"></svg>';
      }
    });
    (globalThis as { mermaid?: unknown }).mermaid = { initialize, run };

    const container = doc.createElement("div");
    container.innerHTML =
      '<div class="mermaid">flowchart LR; A-->B;</div>' +
      '<div class="mermaid">flowchat LR; X-->Y;</div>';

    await expect(
      renderMermaidDiagrams(container as unknown as ParentNode, { theme: "default" }),
    ).resolves.toBeUndefined();

    expect(run.mock.calls[0][0].suppressErrors).toBe(true);

    const nodes = container.querySelectorAll(".mermaid");
    expect(nodes[0].querySelector("svg[data-mermaid-ok]")).not.toBeNull();
    expect(nodes[1].querySelector("svg[data-mermaid-error]")).not.toBeNull();
  });
});
