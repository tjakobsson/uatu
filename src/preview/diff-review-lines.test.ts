import { describe, expect, test } from "bun:test";

import { anchorLabel, expandButtonLabel, lineExcerpt, moveLineIndex, reviewLineLabel } from "./diff-review-lines";

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
});
