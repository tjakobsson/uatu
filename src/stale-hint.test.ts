import { describe, expect, test } from "bun:test";

import { nextStaleHint, type StaleHint } from "./stale-hint";

const ACTIVE = "/repo/src/foo.ts";
const OTHER = "/repo/src/bar.ts";

describe("nextStaleHint - file-event", () => {
  test("does not produce a hint in author mode", () => {
    const next = nextStaleHint(null, {
      kind: "file-event",
      mode: "author",
      activeId: ACTIVE,
      changedId: ACTIVE,
      activeStillExists: true,
    });
    expect(next).toBeNull();
  });

  test("produces a changed hint in review mode when the active file changed on disk", () => {
    const next = nextStaleHint(null, {
      kind: "file-event",
      mode: "review",
      activeId: ACTIVE,
      changedId: ACTIVE,
      activeStillExists: true,
    });
    expect(next).toEqual({ kind: "changed", documentId: ACTIVE });
  });

  test("produces no hint when a different (non-active) file changed on disk", () => {
    const next = nextStaleHint(null, {
      kind: "file-event",
      mode: "review",
      activeId: ACTIVE,
      changedId: OTHER,
      activeStillExists: true,
    });
    expect(next).toBeNull();
  });

  test("coalesces multiple changed events for the same active file into one hint", () => {
    const first = nextStaleHint(null, {
      kind: "file-event",
      mode: "review",
      activeId: ACTIVE,
      changedId: ACTIVE,
      activeStillExists: true,
    });
    const second = nextStaleHint(first, {
      kind: "file-event",
      mode: "review",
      activeId: ACTIVE,
      changedId: ACTIVE,
      activeStillExists: true,
    });
    expect(second).toBe(first);
    expect(second).toEqual({ kind: "changed", documentId: ACTIVE });
  });

  test("produces a deleted hint when the active file no longer exists in the payload", () => {
    const next = nextStaleHint(null, {
      kind: "file-event",
      mode: "review",
      activeId: ACTIVE,
      changedId: null,
      activeStillExists: false,
    });
    expect(next).toEqual({ kind: "deleted", documentId: ACTIVE });
  });

  test("deleted overrides an earlier changed hint for the same active file", () => {
    const changed: StaleHint = { kind: "changed", documentId: ACTIVE };
    const next = nextStaleHint(changed, {
      kind: "file-event",
      mode: "review",
      activeId: ACTIVE,
      changedId: null,
      activeStillExists: false,
    });
    expect(next).toEqual({ kind: "deleted", documentId: ACTIVE });
  });

  test("an existing deleted hint is preserved even when a follow-up changed event arrives", () => {
    const deleted: StaleHint = { kind: "deleted", documentId: ACTIVE };
    const next = nextStaleHint(deleted, {
      kind: "file-event",
      mode: "review",
      activeId: ACTIVE,
      changedId: ACTIVE,
      activeStillExists: true,
    });
    expect(next).toBe(deleted);
  });

  test("file event without an active selection is ignored", () => {
    const next = nextStaleHint(null, {
      kind: "file-event",
      mode: "review",
      activeId: null,
      changedId: ACTIVE,
      activeStillExists: true,
    });
    expect(next).toBeNull();
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

describe("nextStaleHint - mode-changed", () => {
  test("switching to author clears any hint", () => {
    const changed: StaleHint = { kind: "changed", documentId: ACTIVE };
    expect(nextStaleHint(changed, { kind: "mode-changed", nextMode: "author" })).toBeNull();
  });

  test("switching to review does not auto-create a hint", () => {
    expect(nextStaleHint(null, { kind: "mode-changed", nextMode: "review" })).toBeNull();
  });

  test("switching to review preserves an existing hint", () => {
    const changed: StaleHint = { kind: "changed", documentId: ACTIVE };
    expect(nextStaleHint(changed, { kind: "mode-changed", nextMode: "review" })).toBe(changed);
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
