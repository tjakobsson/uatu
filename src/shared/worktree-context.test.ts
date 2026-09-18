import { describe, expect, test } from "bun:test";

import {
  formatWorktreeHubContext,
  isWorktreeCapabilityToken,
  isWorktreeHubContextExpired,
  parseWorktreeHubContext,
  WORKTREE_API_PATH,
  WORKTREE_CAPABILITY_PREFIX,
  WORKTREE_CONTEXT_ENV,
  WorktreeContextError,
  type WorktreeHubContext,
} from "./worktree-context";

const context: WorktreeHubContext = {
  version: 1,
  hubOrigin: "http://127.0.0.1:4700",
  workspaceId: "atlas",
  token: `${WORKTREE_CAPABILITY_PREFIX}handle.secret`,
  expiresAt: 2_000,
};

describe("worktree hub context", () => {
  test("round-trips through its file body", () => {
    expect(parseWorktreeHubContext(JSON.parse(formatWorktreeHubContext(context)))).toEqual(context);
  });

  test("the environment carries a path, never the credential", () => {
    // The whole point of the transport: the variable's VALUE is a filename.
    expect(WORKTREE_CONTEXT_ENV).toBe("UATU_HUB_CONTEXT");
    expect(formatWorktreeHubContext(context)).toContain("hubOrigin");
  });

  test("normalizes the origin and refuses a non-http one", () => {
    expect(parseWorktreeHubContext({ ...context, hubOrigin: "https://hub.example.test:8443/dashboard" }).hubOrigin)
      .toBe("https://hub.example.test:8443");
    expect(() => parseWorktreeHubContext({ ...context, hubOrigin: "file:///etc/passwd" })).toThrow(WorktreeContextError);
    expect(() => parseWorktreeHubContext({ ...context, hubOrigin: "not a url" })).toThrow(WorktreeContextError);
  });

  test("refuses anything that is not a worktree capability", () => {
    // A Hub session id must never be usable here: it is not least privilege.
    expect(() => parseWorktreeHubContext({ ...context, token: "an-ordinary-hub-session-id" })).toThrow(WorktreeContextError);
    expect(isWorktreeCapabilityToken("an-ordinary-hub-session-id")).toBe(false);
    expect(isWorktreeCapabilityToken(context.token)).toBe(true);
  });

  test("refuses missing, malformed and unversioned contexts", () => {
    for (const value of [null, [], "text", 7]) {
      expect(() => parseWorktreeHubContext(value)).toThrow(WorktreeContextError);
    }
    expect(() => parseWorktreeHubContext({ ...context, version: 2 })).toThrow(WorktreeContextError);
    expect(() => parseWorktreeHubContext({ ...context, workspaceId: "" })).toThrow(WorktreeContextError);
    expect(() => parseWorktreeHubContext({ ...context, expiresAt: "soon" })).toThrow(WorktreeContextError);
  });

  test("expiry is a comparison the caller makes explicitly", () => {
    expect(isWorktreeHubContextExpired(context, 1_999)).toBe(false);
    expect(isWorktreeHubContextExpired(context, 2_000)).toBe(true);
  });

  test("names the one route family a capability may reach", () => {
    expect(WORKTREE_API_PATH).toBe("/api/hub/worktrees");
  });
});
