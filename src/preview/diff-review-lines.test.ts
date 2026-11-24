import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { anchorLabel, expandButtonLabel, filterJumpPaths, firstCommentLine, inlineComposerPrompt, lineExcerpt, lineOptionText, moveLineIndex, reviewLineLabel, rowTapNumberCell } from "./diff-review-lines";

describe("review line numbers", () => {
  test("name the action, the file and the side", () => {
    expect(reviewLineLabel({ side: "additions", lineNumber: 12 }, false, "docs/a.md")).toBe("Comment on docs/a.md line 12");
    expect(reviewLineLabel({ side: "deletions", lineNumber: 3 }, false, "docs/a.md")).toBe("Comment on docs/a.md line 3 (removed)");
    expect(reviewLineLabel({ side: "deletions", lineNumber: 3 }, true, "docs/a.md")).toBe("Comment on docs/a.md line 3 (old)");
  });

  test("collapsed-context expanders say what they show, where", () => {
    expect(expandButtonLabel(" 4 unmodified\n lines ", "down", "docs/hub.md")).toBe("Show 4 unmodified lines below in docs/hub.md");
    expect(expandButtonLabel("", "both", "README.md")).toBe("Show unmodified lines in README.md");
    expect(expandButtonLabel("12 unmodified lines", "up", "a.ts")).toBe("Show 12 unmodified lines above in a.ts");
  });

  test("arrow keys stay inside the column; other keys are not ours", () => {
    expect(moveLineIndex(0, "ArrowDown", 3)).toBe(1);
    expect(moveLineIndex(2, "ArrowDown", 3)).toBe(2);
    expect(moveLineIndex(0, "ArrowUp", 3)).toBe(0);
    expect(moveLineIndex(1, "Home", 3)).toBe(0);
    expect(moveLineIndex(1, "End", 3)).toBe(2);
    expect(moveLineIndex(1, "Tab", 3)).toBeNull();
    expect(moveLineIndex(0, "ArrowDown", 0)).toBeNull();
  });
});

describe("naming a commented line away from the diff", () => {
  const files = [{ path: "links.ts", oldContents: "const a = 1;\nold   two\n", newContents: "export const a = 1;\nnew two\n" }];
  test("the old and new sides of the same line read differently", () => {
    expect(anchorLabel({ path: "links.ts", line: 1, side: "LEFT" })).toBe("links.ts:1 (old)");
    expect(anchorLabel({ path: "links.ts", line: 1, side: "RIGHT" })).toBe("links.ts:1 (new)");
    expect(lineExcerpt(files, { path: "links.ts", line: 1, side: "LEFT" })).toBe("const a = 1;");
    expect(lineExcerpt(files, { path: "links.ts", line: 1, side: "RIGHT" })).toBe("export const a = 1;");
  });
  test("one trimmed line, shortened, and empty when unknown", () => {
    expect(lineExcerpt(files, { path: "links.ts", line: 2, side: "LEFT" })).toBe("old two");
    expect(lineExcerpt(files, { path: "links.ts", line: 1, side: "RIGHT" }, 8)).toBe("export …");
    expect(lineExcerpt(files, { path: "links.ts", line: 40, side: "RIGHT" })).toBe("");
    expect(lineExcerpt(files, { path: "gone.ts", line: 1, side: "RIGHT" })).toBe("");
  });
  test("from GitHub's patch when the file's sides aren't sent", () => {
    const patch = "diff --git a/p.ts b/p.ts\n--- a/p.ts\n+++ b/p.ts\n@@ -10,3 +10,4 @@ fn\n keep\n-gone\n+added one\n+added two\n same\n";
    const patched = [{ path: "p.ts", patch }];
    expect(lineExcerpt(patched, { path: "p.ts", line: 11, side: "LEFT" })).toBe("gone");
    expect(lineExcerpt(patched, { path: "p.ts", line: 12, side: "RIGHT" })).toBe("added two");
    expect(lineExcerpt(patched, { path: "p.ts", line: 13, side: "RIGHT" })).toBe("same");
    expect(lineExcerpt(patched, { path: "p.ts", line: 12, side: "LEFT" })).toBe("same");
    expect(lineExcerpt(patched, { path: "p.ts", line: 2, side: "RIGHT" })).toBe("");
  });
});

describe("inline composers on either side of a line", () => {
  test("the old and new sides' composers are named apart", () => {
    expect(inlineComposerPrompt({ path: "docs/a.md", line: 1, side: "LEFT" }, "octo")).toBe("Comment on docs/a.md:1 (old) as @octo…");
    expect(inlineComposerPrompt({ path: "docs/a.md", line: 1, side: "RIGHT" }, "octo")).toBe("Comment on docs/a.md:1 (new) as @octo…");
  });
  test("line picker options name the side and start of the line", () => {
    expect(lineOptionText({ side: "deletions", lineNumber: 3 }, "  # Title ")).toBe("line 3 (old) · # Title");
    expect(lineOptionText({ side: "additions", lineNumber: 3 }, "")).toBe("line 3 (new)");
    expect(lineOptionText({ side: "additions", lineNumber: 4 }, "x".repeat(45))).toBe(`line 4 (new) · ${"x".repeat(40)}…`);
  });
});

describe("rowTapNumberCell", () => {
  // Pierre's unified column: number cells and line rows share a `code`, keyed
  // by line index; annotations sit between rows.
  const { document } = parseHTML(`<code data-additions>
    <div data-column-number="4" data-line-index="3,3" data-line-type="context">4</div>
    <div data-line data-line-index="3,3"><span id="text">const a = 1;</span></div>
    <div data-line-annotation><slot><div id="thread">comment</div></slot></div>
  </code>`);
  const path = (element: Element | null) => {
    const chain: Element[] = [];
    for (let node = element; node; node = node.parentElement) chain.push(node);
    return chain;
  };

  test("a tap on a line's code stands for its number", () => {
    expect(rowTapNumberCell(path(document.querySelector("#text")))?.getAttribute("data-column-number")).toBe("4");
  });

  test("a tap on a number, a comment or outside a line is not a row tap", () => {
    expect(rowTapNumberCell(path(document.querySelector("[data-column-number]")))).toBeNull();
    expect(rowTapNumberCell(path(document.querySelector("#thread")))).toBeNull();
    expect(rowTapNumberCell(path(document.querySelector("code")))).toBeNull();
  });
});

describe("firstCommentLine", () => {
  const line = (side: "additions" | "deletions", lineNumber: number, text: string, changed = true) => ({ side, lineNumber, text, changed });
  test("skips blank and unchanged lines, preferring an added line", () => {
    const lines = [line("additions", 1, "# Title", false), line("additions", 2, "   "), line("deletions", 3, "old text"), line("additions", 3, "new text")];
    expect(firstCommentLine(lines)).toEqual(line("additions", 3, "new text"));
  });
  test("falls back to a removed line, then a blank changed one, then the first line", () => {
    expect(firstCommentLine([line("additions", 1, "", true), line("deletions", 2, "gone")])?.lineNumber).toBe(2);
    expect(firstCommentLine([line("additions", 1, "same", false), line("additions", 2, "")])?.lineNumber).toBe(2);
    expect(firstCommentLine([line("additions", 1, "same", false)])?.lineNumber).toBe(1);
    expect(firstCommentLine([])).toBeUndefined();
  });
});

describe("filterJumpPaths", () => {
  const paths = ["docs/pr-review.md", "src/preview/pr-view.ts", "src/sidebar/pull-request.ts", "README.md"];
  test("keeps the paths containing every word, case-insensitively, in their order", () => {
    expect(filterJumpPaths(paths, "pr-view")).toEqual(["src/preview/pr-view.ts"]);
    expect(filterJumpPaths(paths, "SRC ts")).toEqual(["src/preview/pr-view.ts", "src/sidebar/pull-request.ts"]);
    expect(filterJumpPaths(paths, "readme")).toEqual(["README.md"]);
    expect(filterJumpPaths(paths, "nothing")).toEqual([]);
  });
  test("an empty or blank query keeps every path", () => {
    expect(filterJumpPaths(paths, "")).toEqual(paths);
    expect(filterJumpPaths(paths, "   ")).toEqual(paths);
  });
});
