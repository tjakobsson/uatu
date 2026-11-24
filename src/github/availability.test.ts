import { describe, expect, test } from "bun:test";

import { githubWritesPausedReason, retryNoticeText, sendBlockedReason, staleNotice } from "./availability";

const NOW = 1_000_000;

describe("sendBlockedReason", () => {
  test("lets an open pull request take writes while GitHub answers", () => {
    expect(sendBlockedReason({ status: "ready" }, { number: 7, state: "OPEN" }, NOW)).toBeNull();
    expect(sendBlockedReason({ status: "no-pull-request" }, { number: 7, state: "OPEN" }, NOW)).toBeNull();
  });

  test("pauses sending for every pull request while GitHub can't take writes", () => {
    expect(sendBlockedReason({ status: "rate-limited", retryAt: NOW + 4 * 60_000 }, { number: 7, state: "OPEN" }, NOW))
      .toBe("GitHub's API rate limit is exhausted; sending is paused until it resets in 4 min.");
    expect(sendBlockedReason({ status: "unavailable" }, { number: 7, state: "OPEN" }, NOW)).toContain("paused");
    expect(sendBlockedReason({ status: "no-credential" }, null, NOW)).toContain("isn't connected");
  });

  test("closes a merged or closed pull request to new comments", () => {
    expect(sendBlockedReason({ status: "ready" }, { number: 7, state: "MERGED" }, NOW)).toBe("#7 is merged; new comments are closed here.");
    expect(sendBlockedReason({ status: "ready" }, { number: 7, state: "CLOSED" }, NOW)).toBe("#7 is closed; new comments are closed here.");
  });

  test("says nothing before the session has answered", () => {
    expect(githubWritesPausedReason(null, NOW)).toBeNull();
  });
});

describe("staleNotice", () => {
  test("tells a refusal (rate limit) from an outage, and says nothing else", () => {
    expect(staleNotice({ status: "rate-limited", retryAt: NOW + 60_000 }, NOW))
      .toEqual({ title: "GitHub rate limit reached", why: "GitHub refused more API requests for now; the limit resets in 1 min." });
    expect(staleNotice({ status: "unavailable", message: "timed out" }, NOW)).toEqual({ title: "Couldn't reach GitHub", why: "timed out" });
    expect(staleNotice({ status: "ready" }, NOW)).toBeNull();
    expect(staleNotice({ status: "no-credential" }, NOW)).toBeNull();
  });
});

describe("retryNoticeText", () => {
  const clock = (ms: number) => `t${ms}`;
  test("says Retrying while it runs, then when it ran and that it still failed", () => {
    expect(retryNoticeText({ status: "running" }, "unavailable", clock)).toBe("Retrying…");
    expect(retryNoticeText({ status: "done", at: 5, recovered: false }, "unavailable", clock)).toBe("Retried at t5: GitHub still didn't answer.");
    expect(retryNoticeText({ status: "done", at: 6, recovered: false }, "rate-limited", clock)).toBe("Retried at t6: the rate limit still holds.");
  });

  test("is quiet before any retry and once GitHub answered", () => {
    expect(retryNoticeText(null, "unavailable", clock)).toBeNull();
    expect(retryNoticeText({ status: "done", at: 5, recovered: true }, "ready", clock)).toBeNull();
  });
});
