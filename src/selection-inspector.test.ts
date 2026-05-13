import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  computeState,
  extractSourceTextFromHost,
  formatReference,
  lineNumberForNode,
  type SelectionInspectorOptions,
} from "./selection-inspector";

type FakeRange = {
  commonAncestorContainer: Node;
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  // Optional override; defaults to the same value the surrounding fake
  // selection's `toString()` returns, since a genuine `Range.toString()` and
  // `Selection.toString()` agree for single-range selections under normal DOM
  // semantics. The inspector reads both to defend against Chromium's
  // grid-layout selection serializer (see selection-inspector.ts).
  toString?: () => string;
};

function fakeSelection(opts: {
  collapsed: boolean;
  rangeCount: number;
  text: string;
  range?: FakeRange;
}): Selection {
  return {
    isCollapsed: opts.collapsed,
    rangeCount: opts.rangeCount,
    toString: () => opts.text,
    getRangeAt: () => {
      const baseRange = opts.range ?? {
        commonAncestorContainer: null as unknown as Node,
        startContainer: null as unknown as Node,
        startOffset: 0,
        endContainer: null as unknown as Node,
        endOffset: 0,
      };
      // Mirror the surrounding selection's text on the range so the inspector's
      // empty-text filter (which checks both `selection.toString()` and
      // `range.toString()`) behaves like a real DOM selection. The explicit
      // own-property check is necessary because plain object literals inherit
      // `Object.prototype.toString`; using `??` to fall back on a missing
      // override would never trigger, and `range.toString()` would silently
      // return `"[object Object]"`.
      const explicitToString = Object.prototype.hasOwnProperty.call(baseRange, "toString")
        ? (baseRange as { toString?: () => string }).toString
        : undefined;
      return {
        ...baseRange,
        toString: explicitToString ?? (() => opts.text),
      } as unknown as Range;
    },
  } as unknown as Selection;
}

function buildOptions(
  override: Partial<SelectionInspectorOptions> & {
    previewElement: HTMLElement;
    getActiveDocumentPath: () => string | null;
    isSourceView?: () => boolean;
  },
): SelectionInspectorOptions {
  return {
    previewElement: override.previewElement,
    getActiveDocumentPath: override.getActiveDocumentPath,
    isSourceView: override.isSourceView ?? (() => true),
    getSelection: override.getSelection ?? (() => null),
  };
}

// Build a fixture that mirrors @pierre/diffs's File output: a host div carrying
// `class="uatu-source-pre"`, a `<pre data-file>` inside it, and per-line
// `<div data-line="N">` elements (each containing a token <span>) inside the
// content container.
function buildSourceFixture(lines: string[]): {
  document: Document;
  previewElement: HTMLElement;
  sourceHost: Element;
  lineElement: (n: number) => Element;
  tokenIn: (n: number) => Node;
} {
  const renderedLines = lines
    .map(
      (text, index) =>
        `<div data-line="${index + 1}" data-line-type="context" data-line-index="${index}"><span>${text}</span></div>`,
    )
    .join("");
  const { document } = parseHTML(
    `<!doctype html><html><body>
      <article id='preview'>
        <div class='uatu-source-pre'>
          <pre data-file=''>
            <code data-code=''>
              <div data-gutter=''>${lines.map((_, i) => `<span data-line-number-content=''>${i + 1}</span>`).join("")}</div>
              <div data-content=''>${renderedLines}</div>
            </code>
          </pre>
        </div>
      </article>
    </body></html>`,
  );
  const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
  const sourceHost = document.querySelector(".uatu-source-pre") as unknown as Element;
  const lineElement = (n: number) =>
    document.querySelector(`[data-line="${n}"]`) as unknown as Element;
  const tokenIn = (n: number) => {
    const el = lineElement(n);
    const span = el.querySelector("span");
    if (!span || !span.firstChild) {
      throw new Error(`no token text for line ${n}`);
    }
    return span.firstChild as unknown as Node;
  };
  return { document, previewElement, sourceHost, lineElement, tokenIn };
}

describe("formatReference", () => {
  test("collapses single-line ranges to @path#L<n>", () => {
    expect(formatReference({ path: "src/app.ts", startLine: 42, endLine: 42 })).toBe(
      "@src/app.ts#L42",
    );
  });

  test("expands multi-line ranges to @path#L<a>-<b>", () => {
    expect(formatReference({ path: "README.md", startLine: 21, endLine: 24 })).toBe(
      "@README.md#L21-24",
    );
  });

  test("handles paths with directories", () => {
    expect(
      formatReference({ path: "openspec/changes/foo/proposal.md", startLine: 1, endLine: 1 }),
    ).toBe("@openspec/changes/foo/proposal.md#L1");
  });
});

describe("lineNumberForNode", () => {
  test("returns the data-line attribute of the nearest ancestor", () => {
    const { sourceHost, tokenIn } = buildSourceFixture(["line1", "line2", "line3"]);
    expect(lineNumberForNode(tokenIn(1), sourceHost)).toBe(1);
    expect(lineNumberForNode(tokenIn(2), sourceHost)).toBe(2);
    expect(lineNumberForNode(tokenIn(3), sourceHost)).toBe(3);
  });

  test("returns null when no ancestor carries data-line", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <article id='preview'><p id='para'>not a code line</p></article>
      </body></html>`,
    );
    const previewElement = document.querySelector("#preview") as unknown as Element;
    const para = document.querySelector("#para") as unknown as Element;
    const text = para.firstChild as unknown as Node;
    expect(lineNumberForNode(text, previewElement)).toBeNull();
  });

  test("returns null for non-numeric data-line values", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <div id='root'><div data-line='not-a-number'><span id='target'>x</span></div></div>
      </body></html>`,
    );
    const root = document.querySelector("#root") as unknown as Element;
    const target = document.querySelector("#target") as unknown as Node;
    expect(lineNumberForNode(target, root)).toBeNull();
  });

  test("stops at the supplied root and ignores ancestors above it", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <div data-line='99'>
          <div id='root'>
            <span id='inside'>x</span>
          </div>
        </div>
      </body></html>`,
    );
    const root = document.querySelector("#root") as unknown as Element;
    const inside = document.querySelector("#inside") as unknown as Node;
    expect(lineNumberForNode(inside, root)).toBeNull();
  });
});

describe("computeState", () => {
  test("returns placeholder when no document path is active", () => {
    const { document } = parseHTML(
      "<!doctype html><html><body><article id='preview'></article></body></html>",
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => null,
        isSourceView: () => true,
        getSelection: () =>
          fakeSelection({
            collapsed: false,
            rangeCount: 1,
            text: "hello",
            range: {
              commonAncestorContainer: previewElement as unknown as Node,
              startContainer: previewElement as unknown as Node,
              startOffset: 0,
              endContainer: previewElement as unknown as Node,
              endOffset: 1,
            },
          }),
      }),
    );
    expect(state.kind).toBe("placeholder");
  });

  test("returns placeholder when selection is collapsed", () => {
    const { document } = parseHTML(
      "<!doctype html><html><body><article id='preview'></article></body></html>",
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "docs/foo.md",
        getSelection: () => fakeSelection({ collapsed: true, rangeCount: 1, text: "" }),
      }),
    );
    expect(state.kind).toBe("placeholder");
  });

  test("returns placeholder when toString() is empty", () => {
    const { document } = parseHTML(
      "<!doctype html><html><body><article id='preview'></article></body></html>",
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "docs/foo.md",
        getSelection: () =>
          fakeSelection({
            collapsed: false,
            rangeCount: 1,
            text: "",
            range: {
              commonAncestorContainer: previewElement as unknown as Node,
              startContainer: previewElement as unknown as Node,
              startOffset: 0,
              endContainer: previewElement as unknown as Node,
              endOffset: 0,
            },
          }),
      }),
    );
    expect(state.kind).toBe("placeholder");
  });

  test("returns placeholder when commonAncestor is outside the preview", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <aside id='sidebar'><span id='outside-target'>not preview</span></aside>
        <article id='preview'></article>
      </body></html>`,
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const sidebarTarget = document.querySelector("#outside-target") as unknown as Node;
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "docs/foo.md",
        getSelection: () =>
          fakeSelection({
            collapsed: false,
            rangeCount: 1,
            text: "not preview",
            range: {
              commonAncestorContainer: sidebarTarget,
              startContainer: sidebarTarget,
              startOffset: 0,
              endContainer: sidebarTarget,
              endOffset: 5,
            },
          }),
      }),
    );
    expect(state.kind).toBe("placeholder");
  });

  test("returns hint when isSourceView is false but a valid preview selection exists", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <article id='preview'><p id='para'>hello world</p></article>
      </body></html>`,
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const para = document.querySelector("#para") as unknown as Node;
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "README.md",
        isSourceView: () => false,
        getSelection: () =>
          fakeSelection({
            collapsed: false,
            rangeCount: 1,
            text: "hello world",
            range: {
              commonAncestorContainer: para,
              startContainer: para,
              startOffset: 0,
              endContainer: para,
              endOffset: 11,
            },
          }),
      }),
    );
    expect(state.kind).toBe("hint");
  });

  test("returns hint when selection is rooted in a fenced code block (no uatu-source-pre ancestor)", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <article id='preview'><pre><code id='fenced'>let x = 1;\nlet y = 2;</code></pre></article>
      </body></html>`,
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const fenced = document.querySelector("#fenced") as unknown as Node;
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "README.md",
        isSourceView: () => true, // even though source view is on, the selection is in a non-uatu-source <pre>
        getSelection: () =>
          fakeSelection({
            collapsed: false,
            rangeCount: 1,
            text: "let x = 1",
            range: {
              commonAncestorContainer: fenced,
              startContainer: fenced.firstChild as Node,
              startOffset: 0,
              endContainer: fenced.firstChild as Node,
              endOffset: 9,
            },
          }),
      }),
    );
    expect(state.kind).toBe("hint");
  });

  test("returns reference for a Source-view selection spanning multiple data-line elements", () => {
    const { previewElement, lineElement, tokenIn } = buildSourceFixture([
      "line1",
      "line2",
      "line3",
      "line4",
    ]);
    const startToken = tokenIn(2);
    const endToken = tokenIn(3);
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "src/app.ts",
        isSourceView: () => true,
        getSelection: () =>
          fakeSelection({
            collapsed: false,
            rangeCount: 1,
            text: "line2\nline3",
            range: {
              // Browsers usually set commonAncestor to a parent that contains
              // both endpoints. The source host is a safe upper bound.
              commonAncestorContainer: lineElement(2).parentElement as unknown as Node,
              startContainer: startToken,
              startOffset: 0,
              endContainer: endToken,
              endOffset: 5,
            },
          }),
      }),
    );
    expect(state.kind).toBe("reference");
    if (state.kind !== "reference") return;
    expect(state.record).toEqual({ path: "src/app.ts", startLine: 2, endLine: 3 });
  });

  test("collapses a single-line selection to startLine === endLine", () => {
    const { previewElement, lineElement, tokenIn } = buildSourceFixture(["alpha", "beta", "gamma"]);
    const token = tokenIn(2);
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "fixture.txt",
        isSourceView: () => true,
        getSelection: () =>
          fakeSelection({
            collapsed: false,
            rangeCount: 1,
            text: "beta",
            range: {
              commonAncestorContainer: lineElement(2) as unknown as Node,
              startContainer: token,
              startOffset: 0,
              endContainer: token,
              endOffset: 4,
            },
          }),
      }),
    );
    expect(state.kind).toBe("reference");
    if (state.kind !== "reference") return;
    expect(state.record).toEqual({ path: "fixture.txt", startLine: 2, endLine: 2 });
  });

  test("range ending at the leading edge of the next data-line element clamps to the prior line", () => {
    // The user dragged from the start of line 1 to "just before line 2"; the
    // browser materializes the end as `<div data-line="2">` at offset 0.
    // We report endLine = 1.
    const { previewElement, lineElement, tokenIn } = buildSourceFixture(["alpha", "beta", "gamma"]);
    const startToken = tokenIn(1);
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "fixture.txt",
        isSourceView: () => true,
        getSelection: () =>
          fakeSelection({
            collapsed: false,
            rangeCount: 1,
            text: "alpha\n",
            range: {
              commonAncestorContainer: lineElement(1).parentElement as unknown as Node,
              startContainer: startToken,
              startOffset: 0,
              endContainer: lineElement(2) as unknown as Node,
              endOffset: 0,
            },
          }),
      }),
    );
    expect(state.kind).toBe("reference");
    if (state.kind !== "reference") return;
    expect(state.record).toEqual({ path: "fixture.txt", startLine: 1, endLine: 1 });
  });

  test("returns placeholder if getSelection returns null", () => {
    const { document } = parseHTML(
      "<!doctype html><html><body><article id='preview'></article></body></html>",
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const state = computeState(
      buildOptions({
        previewElement,
        getActiveDocumentPath: () => "docs/foo.md",
        getSelection: () => null,
      }),
    );
    expect(state.kind).toBe("placeholder");
  });
});

describe("extractSourceTextFromHost", () => {
  test("joins data-line elements with newlines and returns clean source", () => {
    const { sourceHost } = buildSourceFixture(["const a = 1;", "const b = 2;", "const c = 3;"]);
    expect(extractSourceTextFromHost(sourceHost)).toBe(
      "const a = 1;\nconst b = 2;\nconst c = 3;",
    );
  });

  test("excludes line-number digits from the gutter", () => {
    // The fixture's gutter places "1", "2", "3" inside data-line-number-content
    // spans. extractSourceTextFromHost MUST NOT include those digits.
    const { sourceHost } = buildSourceFixture(["aaa", "bbb", "ccc"]);
    const text = extractSourceTextFromHost(sourceHost);
    expect(text).toBe("aaa\nbbb\nccc");
    expect(text).not.toMatch(/^1/);
    expect(text).not.toMatch(/\d{2,}/);
  });

  test("plain-text fallback (no data-line nodes) reads code.textContent directly", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <div class='uatu-source-pre uatu-source-pre--plain'>
          <pre><code>line1\nline2\n</code></pre>
        </div>
      </body></html>`,
    );
    const host = document.querySelector(".uatu-source-pre") as unknown as Element;
    expect(extractSourceTextFromHost(host)).toBe("line1\nline2");
  });
});
