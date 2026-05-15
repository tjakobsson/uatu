import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  __pierreModuleLoadedForTests,
  __highlighterLoadedForTests,
  __resetDiffViewCachesForTests,
  renderDocumentDiff,
  type DocumentDiffPayload,
} from "./document-diff-view";

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
