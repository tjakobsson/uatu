import { describe, expect, test } from "bun:test";

import {
  classifySessionPath,
  classifySessionRequest,
  INTERNAL_SESSION_PATHS,
  parseSessionPath,
  sessionBasePath,
  sessionConversationEventsPath,
  sessionPath,
  sessionSuffix,
  sessionWorkerEvidencePath,
  snapshotConversationSegment,
  type SessionPathClass,
} from "./paths";

describe("session base path", () => {
  test("a workspace session lives under /s/<id>/", () => {
    expect(sessionBasePath("uatu")).toBe("/s/uatu/");
  });

  test("a Hub request path splits into the encoded id and the session-relative suffix", () => {
    expect(parseSessionPath("/s/uatu/api/state")).toEqual({ workspaceId: "uatu", suffix: "/api/state" });
    expect(parseSessionPath("/s/uatu/")).toEqual({ workspaceId: "uatu", suffix: "/" });
    expect(parseSessionPath("/s/uatu")).toEqual({ workspaceId: "uatu", suffix: "" });
    expect(parseSessionPath("/s/a%2Fb/x")).toEqual({ workspaceId: "a%2Fb", suffix: "/x" });
    expect(parseSessionPath("/s/")).toBeNull();
    expect(parseSessionPath("/api/hub/state")).toBeNull();
    expect(parseSessionPath("/sx/uatu/")).toBeNull();
  });

  test("one join puts a relative path, with its query, under a base path", () => {
    expect(sessionPath("/s/uatu/", "/api/events?cursor=1")).toBe("/s/uatu/api/events?cursor=1");
    expect(sessionPath("/s/uatu/", "api/terminal/sessions")).toBe("/s/uatu/api/terminal/sessions");
    expect(sessionPath("/", "/api/events")).toBe("/api/events");
  });

  test("the suffix of a path under a base path keeps its leading slash", () => {
    expect(sessionSuffix("/s/uatu/api/media", "/s/uatu/")).toBe("/api/media");
    expect(sessionSuffix("/s/other/api/media", "/s/uatu/")).toBeNull();
  });

  test("conversation ids are encoded into their internal paths", () => {
    expect(sessionConversationEventsPath("opencode:a/b")).toBe("/api/chat/conversations/opencode%3Aa%2Fb/events");
    expect(sessionWorkerEvidencePath("opencode:a/b")).toBe("/api/chat/conversations/opencode%3Aa%2Fb/worker-evidence");
  });
});

// Pins the Hub's answer for every session path it handles specially today,
// and for their near misses.
const TABLE: [method: string, suffix: string, expected: SessionPathClass][] = [
  // The per-stream sources `hub/server.ts` refused by regex, on any method.
  ["GET", "/api/events", "refused-stream"],
  ["POST", "/api/events", "refused-stream"],
  ["GET", "/api/activity", "refused-stream"],
  ["GET", "/api/chat/notifications/events", "refused-stream"],
  ["GET", "/api/chat/conversations/events", "refused-stream"],
  ["GET", "/api/chat/conversations/opencode%3Aone/events", "refused-stream"],
  ["DELETE", "/api/chat/conversations/opencode%3Aone/events", "refused-stream"],
  ["GET", "/api/events/", "forward"],
  ["GET", "/api/eventsx", "forward"],
  ["GET", "/x/api/events", "forward"],
  ["GET", "/api/chat/conversations/a/b/events", "forward"],
  ["GET", "/api/activity-viewed", "forward"],
  // Discard of an unconfirmed queued message.
  ["POST", "/api/chat/conversations/c/queue/m/discard-unconfirmed", "local-discard"],
  ["PATCH", "/api/chat/conversations/c/queue/m/discard-unconfirmed", "forward"],
  ["GET", "/api/chat/conversations/c/queue/m/discard-unconfirmed", "forward"],
  // Policy-signed chat actions.
  ["POST", "/api/chat/conversations/c/prompts", "policy-action"],
  ["POST", "/api/chat/conversations/c/queue/m/send-now", "policy-action"],
  ["PATCH", "/api/chat/conversations/c/queue/m", "policy-action"],
  ["GET", "/api/chat/conversations/c/prompts", "forward"],
  ["DELETE", "/api/chat/conversations/c/queue/m", "forward"],
  ["POST", "/api/chat/conversations/c/queue/m", "forward"],
  ["POST", "/api/chat/conversations/c/background", "forward"],
  ["POST", "/api/chat/conversations/c/prompt", "forward"],
  // Conversation snapshot reads.
  ["GET", "/api/chat/conversations/opencode%3Aparent", "conversation-snapshot"],
  ["DELETE", "/api/chat/conversations/opencode%3Aparent", "forward"],
  ["GET", "/api/chat/conversations", "forward"],
  ["GET", "/api/chat/conversations/c/worker-evidence", "forward"],
  // Media.
  ["GET", "/api/media", "media"],
  ["HEAD", "/api/media", "media"],
  ["GET", "/api/media/x", "forward"],
  // Internal routes the Hub calls directly: refused to browsers, on any
  // method.
  ["POST", "/api/internal/hub-policy-proof", "refused-internal"],
  ["GET", "/api/internal/hub-policy-proof", "refused-internal"],
  ["POST", "/api/chat/accounts-changed", "refused-internal"],
  ["DELETE", "/api/chat/accounts-changed", "refused-internal"],
  ["POST", "/api/internal/hub-policy-proof/", "forward"],
  ["POST", "/api/chat/accounts-changedx", "forward"],
  // The terminal-session inventory is internal to the dashboard's summary
  // but browsers reach it too, through the proxy.
  ["GET", "/api/terminal/sessions", "forward"],
  // Ordinary traffic.
  ["GET", "/api/state", "forward"],
  ["GET", "/api/terminal", "forward"],
  ["GET", "/", "forward"],
  ["GET", "", "forward"],
];

describe("classifySessionPath", () => {
  for (const [method, suffix, expected] of TABLE) {
    test(`${method} ${suffix || "(no suffix)"} is ${expected}`, () => {
      expect(classifySessionPath(method, suffix)).toBe(expected);
    });
  }

  test("agrees with the regex the Hub used to keep by hand", () => {
    const previous = /^\/api\/(events|activity|chat\/notifications\/events|chat\/conversations\/(events|[^/]+\/events))$/;
    for (const [method, suffix] of TABLE) {
      expect(classifySessionPath(method, suffix) === "refused-stream").toBe(previous.test(suffix));
    }
  });

  test("a full request path is classified under its session's base path only", () => {
    expect(classifySessionRequest("POST", "/s/uatu/api/chat/conversations/c/prompts", "/s/uatu/")).toBe("policy-action");
    expect(classifySessionRequest("POST", "/s/other/api/chat/conversations/c/prompts", "/s/uatu/")).toBe("forward");
    expect(classifySessionRequest("GET", "/s/uatu/api/media", "/s/uatu/")).toBe("media");
  });

  test("a snapshot suffix yields its still-encoded conversation segment", () => {
    expect(snapshotConversationSegment("/api/chat/conversations/opencode%3Aparent")).toBe("opencode%3Aparent");
    expect(snapshotConversationSegment("/api/chat/conversations/c/prompts")).toBeNull();
  });

  test("the internal list's routes without a replacement are refused as internal", () => {
    const refused = INTERNAL_SESSION_PATHS.filter(item => classifySessionPath(item.method, item.path) === "refused-internal").map(item => item.path);
    expect(refused).toEqual(["/api/chat/accounts-changed", "/api/internal/hub-policy-proof"]);
  });

  test("every per-stream source in the internal list is refused", () => {
    const refused = INTERNAL_SESSION_PATHS.filter(item => classifySessionPath(item.method, item.path) === "refused-stream").map(item => item.path);
    expect(refused).toEqual([
      "/api/events",
      "/api/chat/conversations/events",
      "/api/chat/conversations/sample/events",
      "/api/activity",
      "/api/chat/notifications/events",
    ]);
  });
});
