import { describe, expect, test } from "bun:test";

import { nextStaleHint, type StaleHint } from "./stale-hint";

const ACTIVE = "/repo/src/foo.ts";

describe("nextStaleHint - file-event", () => {
  test("never produces a hint in the single-mode app", () => {
    // With Modes gone, file events never raise a stale hint — Rule C/D of
    // the follow-mode capability handles selection/reload directly.
    const next = nextStaleHint(null, {
      kind: "file-event",
      activeId: ACTIVE,
      changedId: ACTIVE,
      activeStillExists: true,
    });
    expect(next).toBeNull();
  });

  test("preserves an existing hint when a file event arrives", () => {
    const changed: StaleHint = { kind: "changed", documentId: ACTIVE };
    const next = nextStaleHint(changed, {
      kind: "file-event",
      activeId: ACTIVE,
      changedId: ACTIVE,
      activeStillExists: false,
    });
    expect(next).toBe(changed);
  });
});

describe("nextStaleHint - manual-navigation", () => {
  test("clears any hint", () => {
    const changed: StaleHint = { kind: "changed", documentId: ACTIVE };
    expect(nextStaleHint(changed, { kind: "manual-navigation" })).toBeNull();
    const deleted: StaleHint = { kind: "deleted", documentId: ACTIVE };
    expect(nextStaleHint(deleted, { kind: "manual-navigation" })).toBeNull();
    expect(nextStaleHint(null, { kind: "manual-navigation" })).toBeNull();
  });
});

describe("nextStaleHint - refresh-action", () => {
  test("clears any hint", () => {
    const changed: StaleHint = { kind: "changed", documentId: ACTIVE };
    expect(nextStaleHint(changed, { kind: "refresh-action" })).toBeNull();
    const deleted: StaleHint = { kind: "deleted", documentId: ACTIVE };
    expect(nextStaleHint(deleted, { kind: "refresh-action" })).toBeNull();
  });
});
