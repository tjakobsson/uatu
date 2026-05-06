import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  characterOffsetWithin,
  computeState,
  formatReference,
  offsetToLine,
  type SelectionInspectorOptions,
} from "./selection-inspector";

type FakeRange = { commonAncestorContainer: Node; startContainer: Node; startOffset: number; endContainer: Node; endOffset: number };

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
    getRangeAt: () =>
      (opts.range ?? {
        commonAncestorContainer: null as unknown as Node,
        startContainer: null as unknown as Node,
        startOffset: 0,
        endContainer: null as unknown as Node,
        endOffset: 0,
      }) as Range,
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

describe("offsetToLine", () => {
  test("returns 1 for offset 0 regardless of content", () => {
    expect(offsetToLine("anything", 0)).toBe(1);
    expect(offsetToLine("\n\n\n", 0)).toBe(1);
  });

  test("counts newlines preceding the offset", () => {
    const text = "a\nb\nc\nd";
    expect(offsetToLine(text, 0)).toBe(1);
    expect(offsetToLine(text, 2)).toBe(2);
    expect(offsetToLine(text, 4)).toBe(3);
    expect(offsetToLine(text, 6)).toBe(4);
  });

  test("trimTrailingNewline keeps a range ending at the start of the next line on the previous line", () => {
    // "line1\nline2\n" — offset 6 is right after the first '\n', i.e. the
    // start of line 2. With trim, it should still report line 1 (the last
    // line the selection actually covered).
    const text = "line1\nline2\n";
    expect(offsetToLine(text, 6)).toBe(2);
    expect(offsetToLine(text, 6, { trimTrailingNewline: true })).toBe(1);
  });

  test("clamps offsets larger than the text length", () => {
    expect(offsetToLine("abc", 999)).toBe(1);
    expect(offsetToLine("a\nb", 999)).toBe(2);
  });
});

describe("characterOffsetWithin", () => {
  test("returns 0 for a target equal to root with offset 0", () => {
    const { document } = parseHTML(
      "<!doctype html><html><body><pre><code>hello\nworld</code></pre></body></html>",
    );
    const code = document.querySelector("code") as unknown as Node;
    expect(characterOffsetWithin(code, code, 0)).toBe(0);
  });

  test("returns null when target is not contained by root", () => {
    const { document } = parseHTML(
      "<!doctype html><html><body><pre><code>hello</code></pre><span id='outside'>world</span></body></html>",
    );
    const code = document.querySelector("code") as unknown as Node;
    const outside = document.querySelector("#outside") as unknown as Node;
    expect(characterOffsetWithin(code, outside, 0)).toBeNull();
  });

  test("computes character offset for a text-node target", () => {
    const { document } = parseHTML(
      "<!doctype html><html><body><pre><code>hello\nworld</code></pre></body></html>",
    );
    const code = document.querySelector("code") as unknown as Node;
    const textNode = code.firstChild as Node;
    expect(characterOffsetWithin(code, textNode, 0)).toBe(0);
    expect(characterOffsetWithin(code, textNode, 5)).toBe(5);
    expect(characterOffsetWithin(code, textNode, 6)).toBe(6); // start of "world"
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

  test("returns reference for a Source-view selection rooted in pre.uatu-source-pre", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <article id='preview'><pre class='uatu-source-pre'><code id='wholefile'>line1
line2
line3
line4</code></pre></article>
      </body></html>`,
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const code = document.querySelector("#wholefile") as unknown as Node;
    const textNode = code.firstChild as Node;
    // Selection spans from the start of "line2" to the end of "line3":
    //   "line1\nline2\nline3\nline4"
    //          ^6              ^17
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
              commonAncestorContainer: textNode,
              startContainer: textNode,
              startOffset: 6,
              endContainer: textNode,
              endOffset: 17,
            },
          }),
      }),
    );
    expect(state.kind).toBe("reference");
    if (state.kind !== "reference") return;
    expect(state.record).toEqual({ path: "src/app.ts", startLine: 2, endLine: 3 });
  });

  test("collapses a single-line selection in source view to startLine === endLine", () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <article id='preview'><pre class='uatu-source-pre'><code id='wholefile'>alpha
beta
gamma</code></pre></article>
      </body></html>`,
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const code = document.querySelector("#wholefile") as unknown as Node;
    const textNode = code.firstChild as Node;
    // "beta" — characters 6..10 of "alpha\nbeta\ngamma"
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
              commonAncestorContainer: textNode,
              startContainer: textNode,
              startOffset: 6,
              endContainer: textNode,
              endOffset: 10,
            },
          }),
      }),
    );
    expect(state.kind).toBe("reference");
    if (state.kind !== "reference") return;
    expect(state.record).toEqual({ path: "fixture.txt", startLine: 2, endLine: 2 });
  });

  test("range ending at the start of the next line is reported on the previous line", () => {
    // claudecode.nvim convention: a selection ending immediately after a
    // newline reports the previous line as endLine, since the user's
    // selection covered "those lines", not "up to the first character of
    // the next."
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <article id='preview'><pre class='uatu-source-pre'><code id='wholefile'>alpha
beta
gamma</code></pre></article>
      </body></html>`,
    );
    const previewElement = document.querySelector("#preview") as unknown as HTMLElement;
    const code = document.querySelector("#wholefile") as unknown as Node;
    const textNode = code.firstChild as Node;
    // "alpha\n" — offset 0..6 (the trailing newline is included). End line
    // should be 1, not 2.
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
              commonAncestorContainer: textNode,
              startContainer: textNode,
              startOffset: 0,
              endContainer: textNode,
              endOffset: 6,
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
