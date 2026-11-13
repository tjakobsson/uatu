import { expect, test } from "bun:test";
import { AutomaticBackgroundNotices, automaticBackgroundNote } from "./automatic-background";

test("uncertain action retains a bounded plain excerpt and truthful read lifecycle", () => {
  const notices = new AutomaticBackgroundNotices();
  notices.unconfirmed("parent", "source", "Queue → Steer", "<img onerror=bad>\n" + "long ".repeat(100));
  expect(notices.text("parent")).toContain('Queue → Steer “<img onerror=bad>');
  expect(notices.text("parent").length).toBeLessThan(260);
  expect(notices.text("parent")).toContain("Checking conversation status");
  notices.checked("parent", "source", true);
  expect(notices.text("parent")).toContain("Status checked; acceptance still unconfirmed");
  notices.record("parent", "unrelated", "accepted");
  expect(notices.text("parent")).toContain("<img onerror=bad>");
  notices.unconfirmed("parent", "attachment", "Send now", "");
  expect(notices.text("parent")).toContain("attachment-only message");
  notices.checked("parent", "attachment", false);
  expect(notices.text("parent")).toContain("Status check unavailable");
});

test("notice memory is bounded across conversations and operations", () => {
  const notices = new AutomaticBackgroundNotices();
  for (let conversation = 0; conversation < 101; conversation++) {
    for (let operation = 0; operation < 21; operation++) notices.unconfirmed(`c${conversation}`, `op${operation}`, "Steer", `message ${operation}`);
  }
  expect(notices.text("c0")).toBe("");
  expect(notices.text("c100")).not.toContain("message 0”");
  expect(notices.text("c100").match(/acceptance unconfirmed/g)).toHaveLength(20);
  expect(notices.text("c100")).toContain("message 20”");
});

test("automatic feedback preserves accepted steer without claiming delivery, worker counts or completion", () => {
  expect(automaticBackgroundNote(undefined)).toBe("");
  expect(automaticBackgroundNote("accepted")).toBe("");
  expect(automaticBackgroundNote("not-needed")).toBe("");
  for (const outcome of ["failed", "unavailable", "unknown"] as const) {
    const note = automaticBackgroundNote(outcome);
    expect(note).not.toContain("Steer accepted");
    expect(note).not.toContain("Continue");
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
  expect(notices.text("parent")).toBe(automaticBackgroundNote(outcome));
  expect(notices.text("other-parent")).toBe("");
  notices.record("parent", "source", "accepted");
  expect(notices.text("parent")).toBe("");
});

test("primary-unknown guidance survives unrelated outcomes and repeated outcomes do not duplicate text", () => {
  const notices = new AutomaticBackgroundNotices();
  notices.unconfirmed("parent", "primary", "Acceptance unconfirmed; do not repeat.");
  notices.record("parent", "a", "unknown");
  notices.record("parent", "b", "unknown");
  expect(notices.text("parent")).toBe(`Acceptance unconfirmed; do not repeat. ${automaticBackgroundNote("unknown")}`);
});

test("successful acknowledgements never enter the readable notice band", () => {
  const notices = new AutomaticBackgroundNotices();
  notices.record("parent", "earlier-success", "accepted");
  notices.record("parent", "uncertain", "unknown");
  expect(notices.text("parent")).toBe(automaticBackgroundNote("unknown"));
});

test("withdrawal uncertainty permits only explicit cancellation retry, not message resubmission", () => {
  const notices = new AutomaticBackgroundNotices();
  notices.unconfirmed("parent", "withdraw", "Remove pending message", "Original", "withdrawal");
  expect(notices.text("parent")).toContain("do not resubmit; you may retry withdrawal");
  notices.checked("parent", "withdraw", true);
  expect(notices.text("parent")).toContain("withdrawal still unconfirmed. Do not resubmit; you may retry withdrawal.");
  notices.unconfirmed("parent", "primary", "Steer", "Admission unknown");
  expect(notices.text("parent")).toContain("Checking conversation status; do not repeat.");
});

test("failures and uncertainty keep operation order and successful resolution removes only its source", () => {
  const notices = new AutomaticBackgroundNotices();
  notices.record("parent", "first", "failed");
  notices.record("parent", "second", "unknown");
  notices.record("parent", "third", "unavailable");
  expect(notices.text("parent")).toBe((["failed", "unknown", "unavailable"] as const).map(automaticBackgroundNote).join(" "));
  notices.record("parent", "second", "accepted");
  expect(notices.text("parent")).toBe(`${automaticBackgroundNote("failed")} ${automaticBackgroundNote("unavailable")}`);
  expect(notices.text("other")).toBe("");
});
