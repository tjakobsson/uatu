import { describe, expect, test } from "bun:test";

import { blockHoldingLine, effectiveRevision, effectiveViewMode, fileViewModes, formatBytes, kindOfPath, parseBlobLink } from "./pull-request-file-model";

describe("pull request file view rules", () => {
  test("a path's kind decides the modes; Diff only for a changed file", () => {
    expect(kindOfPath("docs/a.md")).toBe("markdown");
    expect(kindOfPath("docs/A.ADOC")).toBe("asciidoc");
    expect(kindOfPath("docs/images/x.svg")).toBe("image");
    expect(kindOfPath("src/a.ts")).toBe("text");
    expect(fileViewModes("markdown", true)).toEqual(["rendered", "source", "diff"]);
    expect(fileViewModes("asciidoc", false)).toEqual(["rendered", "source"]);
    expect(fileViewModes("text", true)).toEqual(["source", "diff"]);
    expect(fileViewModes("image", true)).toEqual([]);
  });

  test("the shared preference applies where the file offers it", () => {
    expect(effectiveViewMode(["rendered", "source", "diff"], "diff")).toBe("diff");
    expect(effectiveViewMode(["source", "diff"], "rendered")).toBe("source");
    expect(effectiveViewMode(["rendered", "source"], "diff")).toBe("rendered");
    expect(effectiveViewMode([], "rendered")).toBeNull();
  });

  test("a deleted file shows its base, an added one its head", () => {
    expect(effectiveRevision("removed", "head")).toBe("base");
    expect(effectiveRevision("added", "base")).toBe("head");
    expect(effectiveRevision("modified", "base")).toBe("base");
    expect(effectiveRevision(null, "head")).toBe("head");
  });

  test("sizes read in B, KB and MB", () => {
    expect(formatBytes(439)).toBe("439 B");
    expect(formatBytes(1229)).toBe("1.2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  test("a blob-route link maps back to a file of the pull request", () => {
    expect(parseBlobLink("api/github/pr-blob/abc123def456/639/c0ffee1/docs/hub.md")).toEqual({ number: 639, oid: "c0ffee1", path: "docs/hub.md" });
    expect(parseBlobLink("/api/github/pr-blob/k/639/c0ffee1/docs/a%20b.md")).toEqual({ number: 639, oid: "c0ffee1", path: "docs/a b.md" });
    expect(parseBlobLink("api/github/pr-blob/k/639/c0ffee1/docs%2F..%2Fx")).toBeNull();
    expect(parseBlobLink("api/github/pr-blob/k/639/c0ffee1")).toBeNull();
    expect(parseBlobLink("docs/hub.md")).toBeNull();
  });
});

describe("blockHoldingLine", () => {
  test("a line belongs to the last block starting at or before it; nested blocks win", () => {
    // AsciiDoc order: a section at 5 holding paragraphs at 7 and 10.
    const blocks = [{ line: 3, name: "intro" }, { line: 5, name: "section" }, { line: 7, name: "para" }, { line: 10, name: "list" }];
    expect(blockHoldingLine(blocks, 1)).toBeNull();
    expect(blockHoldingLine(blocks, 3)?.name).toBe("intro");
    expect(blockHoldingLine(blocks, 4)?.name).toBe("intro");
    expect(blockHoldingLine(blocks, 5)?.name).toBe("section");
    expect(blockHoldingLine(blocks, 8)?.name).toBe("para");
    expect(blockHoldingLine(blocks, 40)?.name).toBe("list");
    expect(blockHoldingLine([], 4)).toBeNull();
  });
});
