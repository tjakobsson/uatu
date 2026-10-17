import { expect, test } from "bun:test";
import { AutomaticBackgroundNotices, automaticBackgroundNote } from "./automatic-background";

test("automatic feedback preserves accepted steer without claiming delivery, worker counts or completion", () => {
  expect(automaticBackgroundNote(undefined)).toBe("");
  expect(automaticBackgroundNote("accepted")).toBe("Steer accepted; background request acknowledged. Jobs may still be running.");
  expect(automaticBackgroundNote("not-needed")).toBe("Steer accepted; no confirmed blocking work was observed.");
  for (const outcome of ["failed", "unavailable", "unknown"] as const) {
    const note = automaticBackgroundNote(outcome);
    expect(note).toContain("Steer accepted");
    expect(note).not.toMatch(/delivered|finished|completed|resend/i);
  }
  expect(automaticBackgroundNote("unknown")).toContain("could not be confirmed");
});

for (const outcome of ["unknown", "failed", "unavailable"] as const) test(`${outcome} feedback belongs to its operation, not unrelated successful mutations`, () => {
  const notices = new AutomaticBackgroundNotices();
  notices.record("parent", "source", outcome);
  notices.record("parent", "remove-unrelated");
  notices.record("parent", "queue-only-conversion");
  notices.record("parent", "later-steer", "accepted");
  notices.clearSuccessful("parent");
  expect(notices.text("parent")).toBe(automaticBackgroundNote(outcome));
  expect(notices.text("other-parent")).toBe("");
  notices.record("parent", "source", "accepted");
  notices.clearSuccessful("parent");
  expect(notices.text("parent")).toBe("");
});

test("primary-unknown guidance survives unrelated lifecycle cleanup and repeated outcomes do not duplicate text", () => {
  const notices = new AutomaticBackgroundNotices();
  notices.unconfirmed("parent", "primary", "Acceptance unconfirmed; do not repeat.");
  notices.record("parent", "a", "unknown");
  notices.record("parent", "b", "unknown");
  notices.clearSuccessful("parent");
  expect(notices.text("parent")).toBe(`Acceptance unconfirmed; do not repeat. ${automaticBackgroundNote("unknown")}`);
});

test("unresolved feedback leads successful acknowledgements in the readable notice band", () => {
  const notices = new AutomaticBackgroundNotices();
  notices.record("parent", "earlier-success", "accepted");
  notices.record("parent", "uncertain", "unknown");
  expect(notices.text("parent")).toBe(`${automaticBackgroundNote("unknown")} ${automaticBackgroundNote("accepted")}`);
});
