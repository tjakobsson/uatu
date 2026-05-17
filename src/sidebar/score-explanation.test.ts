// The score-explanation preview MUST be identical across Author and Review
// modes (the spec requires that toggling Mode does not alter score-detail
// preview content). Previously this was enforced by a brace-counting
// regression test that read app.ts as text — because `buildScoreExplanationHTML`
// was buried in app.ts and importing app.ts triggered DOM side effects.
//
// Now that the function lives in its own DOM-free module, the same property
// is enforced with a direct import: we build the HTML for a representative
// load and assert that the output contains no Mode-aware substring.

import { describe, expect, test } from "bun:test";

import type { ReviewLoadResult } from "../shared/types";
import { buildScoreExplanationHTML } from "./score-explanation";

function availableLoad(overrides: Partial<ReviewLoadResult> = {}): ReviewLoadResult {
  return {
    status: "available",
    score: 18,
    level: "medium",
    thresholds: { medium: 10, high: 30 },
    base: { mode: "configured", ref: "main", mergeBase: "abc1234" },
    changedFiles: [
      { path: "a.ts", oldPath: null, status: "M ", additions: 5, deletions: 1, hunks: 2 },
      { path: "b.ts", oldPath: null, status: "M ", additions: 3, deletions: 0, hunks: 1 },
      { path: "new-file.ts", oldPath: null, status: "??", additions: 0, deletions: 0, hunks: 0 },
    ],
    ignoredFiles: [],
    gitIgnoredFiles: [],
    drivers: [
      {
        kind: "mechanical",
        label: "Changed files",
        score: 10,
        detail: "10 files changed",
        files: ["a.ts", "b.ts"],
      },
      {
        kind: "warning",
        label: "Touches a configured warning area",
        score: 5,
        detail: "tests/security touched",
        files: ["tests/security/auth.test.ts"],
      },
    ],
    configuredAreas: [],
    settingsWarnings: [],
    message: null,
    ...overrides,
  };
}

describe("buildScoreExplanationHTML", () => {
  test("returns the empty string when the load is not available", () => {
    const html = buildScoreExplanationHTML(availableLoad({ status: "unavailable" }));
    expect(html).toBe("");
  });

  test("renders a score-preview section for an available load", () => {
    const html = buildScoreExplanationHTML(availableLoad());
    expect(html).toContain('class="score-preview is-medium"');
    expect(html).toContain("Medium review burden");
    expect(html).toContain("18");
  });

  test("surfaces an Untracked files sub-driver when untracked files are present", () => {
    const html = buildScoreExplanationHTML(availableLoad());
    expect(html).toContain("Untracked files");
    expect(html).toContain("1 file not yet in git");
  });

  test("omits the Untracked sub-driver when no untracked files are present", () => {
    const base = availableLoad();
    const html = buildScoreExplanationHTML({
      ...base,
      changedFiles: base.changedFiles.filter(file => !file.status.startsWith("?")),
    });
    expect(html).not.toContain("Untracked files");
    expect(html).not.toContain("not yet in git");
  });
});

describe("buildScoreExplanationHTML is Mode-independent by construction", () => {
  // These assertions used to walk app.ts as text and check the function
  // body. With the function in its own module we can assert the same
  // property directly on the output: no Mode-aware label can appear because
  // the function has no access to one.

  test("output does not reference the Mode-specific headline labels", () => {
    const html = buildScoreExplanationHTML(availableLoad());
    expect(html).not.toContain("Reviewer burden forecast");
    expect(html).not.toContain("Change review burden");
  });

  test("output never names Author mode or Review mode", () => {
    const html = buildScoreExplanationHTML(availableLoad());
    expect(html).not.toMatch(/\bAuthor\b/);
    expect(html).not.toMatch(/\bReview mode\b/);
  });
});
