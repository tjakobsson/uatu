import { describe, expect, test } from "bun:test";

import type { RootGroup } from "../shared/types";
import { chooseSelectionForFileEvent, selectionForChipTurnOn } from "./follow-rules";

// Single-root fixture with two documents, README (older) and setup.md (newer).
// setup.md is the newest-mtime non-binary doc, so it is what
// `defaultDocumentId` returns and what Rule B's catch-up targets.
function fixture(): RootGroup[] {
  return [
    {
      id: "/tmp/docs",
      label: "docs",
      path: "/tmp/docs",
      hiddenCount: 0,
      docs: [
        {
          id: "/tmp/docs/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 2,
          rootId: "/tmp/docs",
          kind: "markdown",
        },
        {
          id: "/tmp/docs/guides/setup.md",
          name: "setup.md",
          relativePath: "guides/setup.md",
          mtimeMs: 5,
          rootId: "/tmp/docs",
          kind: "markdown",
        },
      ],
    },
  ];
}

describe("chooseSelectionForFileEvent — Rule C / Rule D", () => {
  test("intentional emptiness suppresses defaults, unlike startup null", () => {
    expect(chooseSelectionForFileEvent(fixture(), null, "/tmp/docs/README.md", false, true)).toBeNull();
    expect(chooseSelectionForFileEvent(fixture(), null, null, false)).toBe("/tmp/docs/guides/setup.md");
    expect(chooseSelectionForFileEvent(fixture(), null, "/tmp/docs/README.md", true, true)).toBe("/tmp/docs/README.md");
  });
  test("Rule C: follow on + non-binary change → selection moves to changed file", () => {
    const roots = fixture();
    const next = chooseSelectionForFileEvent(
      roots,
      "/tmp/docs/README.md",
      "/tmp/docs/guides/setup.md",
      true,
    );
    expect(next).toBe("/tmp/docs/guides/setup.md");
  });

  test("Rule D: follow off → selection unchanged when current doc still exists", () => {
    const roots = fixture();
    const next = chooseSelectionForFileEvent(
      roots,
      "/tmp/docs/README.md",
      "/tmp/docs/guides/setup.md",
      false,
    );
    expect(next).toBe("/tmp/docs/README.md");
  });

  test("Rule D: follow off + the current doc itself changed → selection unchanged", () => {
    // The in-place reload is the caller's job (gated on shouldRefreshPreview);
    // this helper's job is only to decide selection.
    const roots = fixture();
    const next = chooseSelectionForFileEvent(
      roots,
      "/tmp/docs/README.md",
      "/tmp/docs/README.md",
      false,
    );
    expect(next).toBe("/tmp/docs/README.md");
  });

  test("Rule C: follow on + changed image embedded in the shown document → selection stays", () => {
    const roots = fixture();
    roots[0]!.docs.push({
      id: "/tmp/docs/hero.svg",
      name: "hero.svg",
      relativePath: "hero.svg",
      mtimeMs: 50,
      rootId: "/tmp/docs",
      kind: "binary",
    });
    const shown = new Set(["/tmp/docs/hero.svg"]);
    expect(chooseSelectionForFileEvent(roots, "/tmp/docs/README.md", "/tmp/docs/hero.svg", true, false, shown))
      .toBe("/tmp/docs/README.md");
    expect(chooseSelectionForFileEvent(roots, "/tmp/docs/README.md", "/tmp/docs/hero.svg", true))
      .toBe("/tmp/docs/hero.svg");
    // A document change is followed whatever the preview shows.
    expect(chooseSelectionForFileEvent(
      roots,
      "/tmp/docs/README.md",
      "/tmp/docs/guides/setup.md",
      true,
      false,
      new Set(["/tmp/docs/guides/setup.md"]),
    )).toBe("/tmp/docs/guides/setup.md");
  });

  test("empty roots preserve a manual destination but have no default", () => {
    expect(chooseSelectionForFileEvent([], null, null, true)).toBeNull();
    expect(chooseSelectionForFileEvent([], "/some/id", "/other/id", false)).toBe("/some/id");
  });
});

describe("selectionForChipTurnOn — Rule B catch-up", () => {
  test("returns the newest-mtime doc when it differs from the current selection", () => {
    const roots = fixture();
    expect(selectionForChipTurnOn(roots, "/tmp/docs/README.md")).toBe(
      "/tmp/docs/guides/setup.md",
    );
  });

  test("returns null when the current selection IS already the newest doc", () => {
    const roots = fixture();
    expect(selectionForChipTurnOn(roots, "/tmp/docs/guides/setup.md")).toBeNull();
  });

  test("returns the newest doc when current selection is null", () => {
    const roots = fixture();
    expect(selectionForChipTurnOn(roots, null)).toBe("/tmp/docs/guides/setup.md");
  });

  test("targets the newest document, not a newer image", () => {
    // Rule B stays documents-only: on a fresh checkout every file shares the
    // checkout time, so "newest image" would be an arbitrary asset. Images
    // are followed only when they actually change (Rule C).
    const roots = fixture();
    roots[0]!.docs.push({
      id: "/tmp/docs/hero.svg",
      name: "hero.svg",
      relativePath: "hero.svg",
      mtimeMs: 50,
      rootId: "/tmp/docs",
      kind: "binary",
    });
    expect(selectionForChipTurnOn(roots, "/tmp/docs/README.md")).toBe("/tmp/docs/guides/setup.md");
  });

  test("returns null when there are no documents to follow", () => {
    expect(selectionForChipTurnOn([], null)).toBeNull();
    expect(selectionForChipTurnOn([], "/some/id")).toBeNull();
  });
});
