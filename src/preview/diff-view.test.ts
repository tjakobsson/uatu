import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  DIFF_MAX_BYTES,
  DIFF_MAX_HIGHLIGHT_BYTES,
  DIFF_MAX_LINES,
  __pierreModuleLoadedForTests,
  __highlighterLoadedForTests,
  __resetDiffViewCachesForTests,
  diffRenderTier,
  prepareDiffRender,
  prewarmDiffView,
  renderDocumentDiff,
  type DocumentDiffPayload,
} from "./diff-view";

let host: HTMLElement;
let cleanup: () => void;

beforeEach(() => {
  __resetDiffViewCachesForTests();
  const { document, window } = parseHTML("<!doctype html><html><body><div id='host'></div></body></html>");
  // Pierre / Shiki call into globals; install linkedom's document for the
  // unit tests' duration. The Pierre branch is exercised in Playwright E2E
  // — these unit tests only touch the fallback paths, which need plain DOM.
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as unknown as { document: unknown }).document = document;
  (globalThis as unknown as { window: unknown }).window = window;
  host = document.getElementById("host") as unknown as HTMLElement;
  cleanup = () => {
    (globalThis as unknown as { document: unknown }).document = previousDocument as unknown;
    (globalThis as unknown as { window: unknown }).window = previousWindow as unknown;
  };
});

afterEach(() => {
  cleanup();
});

describe("renderDocumentDiff state cards", () => {
  test("renders the 'no git history' card for unsupported-no-git", async () => {
    const payload: DocumentDiffPayload = { kind: "unsupported-no-git" };

    await renderDocumentDiff(host, payload, null);

    expect(host.querySelector(".uatu-diff-state")?.textContent).toContain("No git history available");
    expect(__pierreModuleLoadedForTests()).toBe(false);
    expect(__highlighterLoadedForTests()).toBe(false);
  });

  test("renders the 'no changes' card with base ref for unchanged", async () => {
    const payload: DocumentDiffPayload = { kind: "unchanged", baseRef: "origin/main" };

    await renderDocumentDiff(host, payload, null);

    const card = host.querySelector(".uatu-diff-state");
    expect(card?.textContent).toContain("No changes");
    expect(card?.textContent).toContain("origin/main");
    expect(__pierreModuleLoadedForTests()).toBe(false);
  });

  test("renders the 'binary' card with base ref for binary", async () => {
    const payload: DocumentDiffPayload = { kind: "binary", baseRef: "origin/main" };

    await renderDocumentDiff(host, payload, null);

    const card = host.querySelector(".uatu-diff-state");
    expect(card?.textContent).toContain("Binary file");
    expect(card?.textContent).toContain("origin/main");
    expect(__pierreModuleLoadedForTests()).toBe(false);
  });
});

describe("renderDocumentDiff lightweight fallback", () => {
  test("renders via fallback when patch exceeds DIFF_MAX_BYTES", async () => {
    const payload: DocumentDiffPayload = {
      kind: "text",
      baseRef: "origin/main",
      patch: largePatchByBytes(),
      bytes: DIFF_MAX_BYTES + 1,
      addedLines: 5,
      deletedLines: 5,
    };

    await renderDocumentDiff(host, payload, "typescript");

    expect(host.querySelector(".uatu-diff-fallback-pre")).not.toBeNull();
    expect(host.querySelector(".uatu-diff-fallback-notice")?.textContent).toContain("Large diff");
    expect(__pierreModuleLoadedForTests()).toBe(false);
    expect(__highlighterLoadedForTests()).toBe(false);
  });

  test("renders via fallback when changed-line count exceeds DIFF_MAX_LINES", async () => {
    const payload: DocumentDiffPayload = {
      kind: "text",
      baseRef: "origin/main",
      patch: "diff --git a/x b/x\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      bytes: 100,
      addedLines: DIFF_MAX_LINES,
      deletedLines: 1,
    };

    await renderDocumentDiff(host, payload, null);

    expect(host.querySelector(".uatu-diff-fallback-pre")).not.toBeNull();
    expect(host.querySelector(".uatu-diff-fallback-notice")?.textContent).toContain("line cutoff");
    expect(__pierreModuleLoadedForTests()).toBe(false);
  });

  test("fallback classifies added, deleted, hunk, header, and context lines", async () => {
    const patch = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,3 +1,3 @@",
      " context",
      "-removed",
      "+added",
    ].join("\n") + "\n";

    const payload: DocumentDiffPayload = {
      kind: "text",
      baseRef: "HEAD",
      patch,
      bytes: DIFF_MAX_BYTES + 1, // force fallback path
      addedLines: 1,
      deletedLines: 1,
    };

    await renderDocumentDiff(host, payload, null);

    const pre = host.querySelector(".uatu-diff-fallback-pre");
    expect(pre).not.toBeNull();
    expect(pre?.querySelector(".uatu-diff-line-added")?.textContent).toContain("+added");
    expect(pre?.querySelector(".uatu-diff-line-deleted")?.textContent).toContain("-removed");
    expect(pre?.querySelector(".uatu-diff-line-hunk")?.textContent).toContain("@@");
    expect(pre?.querySelectorAll(".uatu-diff-line-header").length).toBeGreaterThanOrEqual(2);
    const contextLines = Array.from(pre?.querySelectorAll(".uatu-diff-line-context") ?? []);
    expect(contextLines.some(node => (node as Element).textContent?.includes("context"))).toBe(true);
  });
});

describe("diffRenderTier size bands", () => {
  const textPayload = (overrides: Partial<Extract<DocumentDiffPayload, { kind: "text" }>>): Extract<DocumentDiffPayload, { kind: "text" }> => ({
    kind: "text",
    baseRef: "main",
    patch: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n",
    bytes: 100,
    addedLines: 1,
    deletedLines: 1,
    ...overrides,
  });

  test("small diffs render via Pierre with highlighting", () => {
    expect(diffRenderTier(textPayload({}))).toBe("pierre");
  });

  test("patch bytes at the highlight threshold select the plaintext tier", () => {
    expect(diffRenderTier(textPayload({ bytes: DIFF_MAX_HIGHLIGHT_BYTES }))).toBe("pierre-plaintext");
  });

  test("blob sizes count toward the highlight threshold", () => {
    const blob = "x".repeat(DIFF_MAX_HIGHLIGHT_BYTES / 2);
    expect(diffRenderTier(textPayload({ oldContents: blob, newContents: blob }))).toBe("pierre-plaintext");
  });

  test("diffs above the Pierre cutoffs select the lightweight fallback", () => {
    expect(diffRenderTier(textPayload({ bytes: DIFF_MAX_BYTES }))).toBe("lightweight");
    expect(diffRenderTier(textPayload({ addedLines: DIFF_MAX_LINES, deletedLines: 0 }))).toBe("lightweight");
  });
});

describe("prewarmDiffView", () => {
  test("populates the module and highlighter caches once and is idempotent", () => {
    expect(__pierreModuleLoadedForTests()).toBe(false);
    expect(__highlighterLoadedForTests()).toBe(false);

    // Don't await: the real Pierre + Shiki load belongs to the browser
    // (exercised in Playwright). The unit-level contract is that one call
    // creates the cached module/highlighter promises and a second call
    // leaves the caches as-is instead of re-creating them — which the
    // cache inspectors (backed by the module-level singletons that
    // ensureHighlighter reuses) make observable.
    prewarmDiffView().catch(() => {});
    expect(__pierreModuleLoadedForTests()).toBe(true);
    expect(__highlighterLoadedForTests()).toBe(true);

    prewarmDiffView().catch(() => {});
    expect(__pierreModuleLoadedForTests()).toBe(true);
    expect(__highlighterLoadedForTests()).toBe(true);
  });
});

describe("prepareDiffRender readiness gate", () => {
  test("no-ops on state-card payloads without loading Pierre", async () => {
    await prepareDiffRender({ kind: "unsupported-no-git" }, "typescript");
    await prepareDiffRender({ kind: "unchanged", baseRef: "main" }, "typescript");
    await prepareDiffRender({ kind: "binary", baseRef: "main" }, "typescript");

    expect(__pierreModuleLoadedForTests()).toBe(false);
    expect(__highlighterLoadedForTests()).toBe(false);
  });

  test("no-ops on lightweight-tier payloads without loading Pierre", async () => {
    const payload: DocumentDiffPayload = {
      kind: "text",
      baseRef: "main",
      patch: largePatchByBytes(),
      bytes: DIFF_MAX_BYTES + 1,
      addedLines: 5,
      deletedLines: 5,
    };

    await prepareDiffRender(payload, "typescript");

    expect(__pierreModuleLoadedForTests()).toBe(false);
    expect(__highlighterLoadedForTests()).toBe(false);
  });
});

describe("renderDocumentDiff lightweight fallback chunking", () => {
  test("lines are grouped into content-visibility chunks with classification intact", async () => {
    const lineCount = 1200;
    const body = Array.from({ length: lineCount }, (_, i) => (i % 2 === 0 ? `+added ${i}` : ` context ${i}`)).join("\n");
    const patch = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,600 +1,600 @@\n${body}\n`;
    const payload: DocumentDiffPayload = {
      kind: "text",
      baseRef: "HEAD",
      patch,
      bytes: DIFF_MAX_BYTES + 1, // force the fallback path
      addedLines: lineCount / 2,
      deletedLines: 0,
    };

    await renderDocumentDiff(host, payload, null);

    const pre = host.querySelector(".uatu-diff-fallback-pre");
    expect(pre).not.toBeNull();
    const chunks = Array.from(pre?.querySelectorAll(".uatu-diff-fallback-chunk") ?? []);
    // 1205 total lines (header lines + body + trailing empty) at 500 per chunk.
    expect(chunks.length).toBe(3);
    // Every line span lives inside a chunk, and classification survives.
    expect(pre?.querySelectorAll(":scope > span").length).toBe(0);
    expect(chunks[0]?.querySelectorAll("span").length).toBe(500);
    expect(pre?.querySelector(".uatu-diff-line-added")?.textContent).toContain("+added 0");
    expect(pre?.querySelector(".uatu-diff-line-hunk")?.textContent).toContain("@@");
  });
});

describe("renderDocumentDiff clears the host between renders", () => {
  test("a second render replaces the first state card", async () => {
    await renderDocumentDiff(host, { kind: "unsupported-no-git" }, null);
    expect(host.querySelectorAll(".uatu-diff-state").length).toBe(1);

    await renderDocumentDiff(host, { kind: "unchanged", baseRef: "HEAD" }, null);
    expect(host.querySelectorAll(".uatu-diff-state").length).toBe(1);
    expect(host.querySelector(".uatu-diff-state")?.textContent).toContain("No changes");
  });
});

function largePatchByBytes(): string {
  // Synthesize a patch larger than DIFF_MAX_BYTES so the cutoff triggers
  // without needing 5 000 changed lines.
  const filler = "x".repeat(DIFF_MAX_BYTES);
  return `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n+${filler}\n`;
}
