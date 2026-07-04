import { afterEach, describe, expect, test } from "bun:test";

import { appState } from "./state";
import { setPreviewMode, setSelectedId } from "./selection";

const initialSelectedId = appState.selectedId;
const initialPreviewMode = appState.previewMode;

afterEach(() => {
  appState.selectedId = initialSelectedId;
  appState.previewMode = initialPreviewMode;
});

describe("selection mutators", () => {
  test("setSelectedId assigns the selection", () => {
    setSelectedId("/watch/docs/readme.md");
    expect(appState.selectedId).toBe("/watch/docs/readme.md");
    setSelectedId(null);
    expect(appState.selectedId).toBeNull();
  });

  test("setPreviewMode assigns the preview surface", () => {
    setPreviewMode({ kind: "review-score", repositoryId: "repo-1" });
    expect(appState.previewMode).toEqual({ kind: "review-score", repositoryId: "repo-1" });
    setPreviewMode({ kind: "document" });
    expect(appState.previewMode).toEqual({ kind: "document" });
  });
});
