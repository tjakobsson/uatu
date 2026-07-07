import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  __drainMermaidQueueForTests,
  __resetMermaidStateForTests,
  normalizeMermaidSvg,
  normalizeRenderedDiagram,
  renderMermaidDiagrams,
  replaceMermaidCodeBlocks,
} from "./preview";

// renderMermaidDiagrams resolves when lazy rendering is INSTALLED, not when
// diagrams are rendered. Tests install and then drain the queue. Bun's test
// environment has no IntersectionObserver, so installs take the render-all
// fallback path unless a test fakes the observer explicitly.
async function installAndDrain(
  container: ParentNode,
  themeInputs?: Parameters<typeof renderMermaidDiagrams>[1],
): Promise<void> {
  await renderMermaidDiagrams(container, themeInputs);
  await __drainMermaidQueueForTests();
}

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

    await installAndDrain(container as unknown as ParentNode, { theme: "default" });
    await installAndDrain(container as unknown as ParentNode, { theme: "default" });
    expect(initialize.mock.calls.length).toBe(1);

    await installAndDrain(container as unknown as ParentNode, { theme: "dark" });
    expect(initialize.mock.calls.length).toBe(2);
    expect(initialize.mock.calls[1][0].theme).toBe("dark");

    // themeVariables change also triggers re-init.
    await installAndDrain(container as unknown as ParentNode, {
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
      installAndDrain(container as unknown as ParentNode, { theme: "default" }),
    ).resolves.toBeUndefined();

    expect(run.mock.calls[0][0].suppressErrors).toBe(true);

    const nodes = container.querySelectorAll(".mermaid");
    expect(nodes[0].querySelector("svg[data-mermaid-ok]")).not.toBeNull();
    expect(nodes[1].querySelector("svg[data-mermaid-error]")).not.toBeNull();
  });
});

describe("lazy mermaid render queue", () => {
  let doc: Document;

  // Records each rendered node's source at invocation time — the node's
  // textContent is replaced by the rendered SVG, so asserting on it later
  // reads the badge glyph instead of the diagram source.
  let renderedSources: string[] = [];
  const okRun = () =>
    mock(async (options: { nodes: HTMLElement[] }) => {
      for (const node of options.nodes) {
        renderedSources.push((node.textContent ?? "").trim());
        node.innerHTML = '<svg data-mermaid-ok="true" viewBox="0 0 10 10"></svg>';
      }
    });

  beforeEach(() => {
    doc = parseHTML("<!doctype html><html><body></body></html>").document as unknown as Document;
    __resetMermaidStateForTests();
    renderedSources = [];
  });

  afterEach(() => {
    delete (globalThis as { mermaid?: unknown }).mermaid;
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  function containerWith(...sources: string[]): HTMLElement {
    const container = doc.createElement("div");
    container.innerHTML = sources.map(s => `<div class="mermaid">${s}</div>`).join("");
    return container as unknown as HTMLElement;
  }

  test("fallback path renders every node, one diagram per mermaid.run call, in order", async () => {
    const run = okRun();
    (globalThis as { mermaid?: unknown }).mermaid = { initialize: mock(() => undefined), run };
    const container = containerWith("graph A", "graph B", "graph C");

    await installAndDrain(container);

    expect(run.mock.calls.length).toBe(3);
    for (const call of run.mock.calls) {
      expect(call[0].nodes.length).toBe(1);
    }
    const rendered = Array.from(container.querySelectorAll(".mermaid"));
    expect(rendered.every(node => node.querySelector("svg") !== null)).toBe(true);
    expect(rendered.every(node => !node.classList.contains("mermaid-pending"))).toBe(true);
    // FIFO: processed in DOM order.
    expect(renderedSources).toEqual(["graph A", "graph B", "graph C"]);
  });

  test("a new install abandons the previous install's pending queue entries", async () => {
    const run = okRun();
    (globalThis as { mermaid?: unknown }).mermaid = { initialize: mock(() => undefined), run };
    const first = containerWith("graph OLD-1", "graph OLD-2");
    const second = containerWith("graph NEW");

    // Install twice back-to-back WITHOUT draining in between: the second
    // install bumps the generation while the first install's entries are
    // still queued. At most the already-in-flight first entry renders;
    // the rest are abandoned.
    await renderMermaidDiagrams(first as unknown as ParentNode);
    await renderMermaidDiagrams(second as unknown as ParentNode);
    await __drainMermaidQueueForTests();

    const oldNodes = Array.from(first.querySelectorAll(".mermaid"));
    const newNode = second.querySelector(".mermaid");
    expect(newNode?.querySelector("svg")).not.toBeNull();
    // The superseded container's trailing node must not have rendered.
    expect(oldNodes[oldNodes.length - 1]?.querySelector("svg")).toBeNull();
    expect(renderedSources).not.toContain("graph OLD-2");
    expect(renderedSources).toContain("graph NEW");
  });

  test("identical source and theme reuses the cached SVG without invoking mermaid", async () => {
    const run = okRun();
    (globalThis as { mermaid?: unknown }).mermaid = { initialize: mock(() => undefined), run };

    await installAndDrain(containerWith("graph SAME") as unknown as ParentNode, { theme: "default" });
    expect(run.mock.calls.length).toBe(1);

    const revisit = containerWith("graph SAME");
    await installAndDrain(revisit as unknown as ParentNode, { theme: "default" });

    // Cache hit: no second mermaid invocation, but the SVG is present and
    // wrapped in the fullscreen-viewer trigger like a fresh render.
    expect(run.mock.calls.length).toBe(1);
    const node = revisit.querySelector(".mermaid");
    expect(node?.querySelector("button.mermaid-trigger svg")).not.toBeNull();
    expect(node?.classList.contains("mermaid-pending")).toBe(false);
  });

  test("a theme change misses the cache and re-renders", async () => {
    const run = okRun();
    (globalThis as { mermaid?: unknown }).mermaid = { initialize: mock(() => undefined), run };

    await installAndDrain(containerWith("graph THEMED") as unknown as ParentNode, { theme: "default" });
    await installAndDrain(containerWith("graph THEMED") as unknown as ParentNode, { theme: "dark" });

    expect(run.mock.calls.length).toBe(2);
  });

  test("failed renders are not cached, so the same source re-renders", async () => {
    const run = mock(async (options: { nodes: HTMLElement[] }) => {
      for (const node of options.nodes) {
        node.innerHTML = '<svg data-mermaid-error="true"></svg>';
      }
    });
    (globalThis as { mermaid?: unknown }).mermaid = { initialize: mock(() => undefined), run };

    await installAndDrain(containerWith("flowchat BAD") as unknown as ParentNode);
    await installAndDrain(containerWith("flowchat BAD") as unknown as ParentNode);

    // No cache entry for the error render: mermaid is invoked both times.
    expect(run.mock.calls.length).toBe(2);
  });

  test("with an IntersectionObserver, nodes render only when they intersect", async () => {
    const run = okRun();
    (globalThis as { mermaid?: unknown }).mermaid = { initialize: mock(() => undefined), run };

    // Fake observer: records targets, renders nothing until the test fires
    // intersections explicitly.
    const observed: Element[] = [];
    let callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void = () => {};
    class FakeObserver {
      constructor(cb: typeof callback) {
        callback = cb;
      }
      observe(target: Element): void {
        observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;

    const container = containerWith("graph VISIBLE", "graph OFFSCREEN");
    await renderMermaidDiagrams(container as unknown as ParentNode);
    await __drainMermaidQueueForTests();

    // Nothing intersected yet: both nodes observed, neither rendered.
    expect(observed.length).toBe(2);
    expect(run.mock.calls.length).toBe(0);
    expect(container.querySelectorAll(".mermaid-pending").length).toBe(2);

    // First node scrolls near the viewport.
    callback([{ target: observed[0]!, isIntersecting: true }]);
    await __drainMermaidQueueForTests();

    expect(run.mock.calls.length).toBe(1);
    const nodes = Array.from(container.querySelectorAll(".mermaid"));
    expect(nodes[0]?.querySelector("svg")).not.toBeNull();
    expect(nodes[1]?.querySelector("svg")).toBeNull();
    expect(nodes[1]?.classList.contains("mermaid-pending")).toBe(true);
  });
});
