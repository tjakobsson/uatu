import { describe, expect, test } from "bun:test";
import { McpServerNames, looksLikeMcpPermission, mcpToolFromAction, sanitizeMcpName } from "./mcp-tools";

describe("mcpToolFromAction", () => {
  test("splits a registered server's sanitized prefix off the action", () => {
    expect(mcpToolFromAction("tracker_create_issue", ["tracker"])).toEqual({ server: "tracker", tool: "create_issue" });
    expect(mcpToolFromAction("github_create_pull_request", ["github", "tracker"])).toEqual({ server: "github", tool: "create_pull_request" });
  });

  test("matches the server as OpenCode sanitizes it and reports it as the user named it", () => {
    expect(sanitizeMcpName("my tools.v2")).toBe("my_tools_v2");
    expect(mcpToolFromAction("my_tools_v2_search", ["my tools.v2"])).toEqual({ server: "my tools.v2", tool: "search" });
    expect(mcpToolFromAction("my-tools_search", ["my-tools"])).toEqual({ server: "my-tools", tool: "search" });
  });

  test("an action two registered servers could have produced is left unresolved", () => {
    // `github` with tool `enterprise_create_issue`, or `github_enterprise`
    // with `create_issue`: no way to know, so no label rather than a guess.
    expect(mcpToolFromAction("github_enterprise_create_issue", ["github", "github_enterprise"])).toBeUndefined();
    expect(mcpToolFromAction("github_enterprise_create_issue", ["github_enterprise", "github"])).toBeUndefined();
    // Two names that sanitize to the same prefix are the same ambiguity.
    expect(mcpToolFromAction("my_tools_search", ["my-tools", "my.tools"])).toBeUndefined();
    // With one of them registered, either resolves.
    expect(mcpToolFromAction("github_enterprise_create_issue", ["github_enterprise", "tracker"])).toEqual({ server: "github_enterprise", tool: "create_issue" });
    expect(mcpToolFromAction("github_enterprise_create_issue", ["github", "tracker"])).toEqual({ server: "github", tool: "enterprise_create_issue" });
    // The same server listed twice is one match.
    expect(mcpToolFromAction("tracker_create_issue", ["tracker", "tracker"])).toEqual({ server: "tracker", tool: "create_issue" });
  });

  test("a built-in action, an unknown prefix, or a bare server name resolves to nothing", () => {
    expect(mcpToolFromAction("bash", ["tracker"])).toBeUndefined();
    expect(mcpToolFromAction("external_directory", ["external"])).toEqual({ server: "external", tool: "directory" });
    expect(mcpToolFromAction("tracker", ["tracker"])).toBeUndefined();
    expect(mcpToolFromAction("tracker_", ["tracker"])).toBeUndefined();
    expect(mcpToolFromAction("tracker_create_issue", [])).toBeUndefined();
  });
});

describe("looksLikeMcpPermission", () => {
  test("an MCP tool's ask is a non-built-in action over wildcards only", () => {
    expect(looksLikeMcpPermission("tracker_create_issue", ["*"])).toBe(true);
    expect(looksLikeMcpPermission("github_create_issue", ["*", "*"])).toBe(true);
    // A server registered as `external` must not claim the built-in
    // external_directory ask, which names a path rather than a wildcard.
    expect(looksLikeMcpPermission("external_directory", ["/etc/*"])).toBe(false);
    expect(looksLikeMcpPermission("external_directory", ["*"])).toBe(false);
    expect(looksLikeMcpPermission("bash", ["*"])).toBe(false);
    expect(looksLikeMcpPermission("tracker_create_issue", ["src/app.ts"])).toBe(false);
    expect(looksLikeMcpPermission("tracker_create_issue", [])).toBe(true);
  });
});

describe("McpServerNames", () => {
  test("fetches once, refetches on a miss, and forgets on an mcp event", async () => {
    const answers = [["tracker"], ["tracker", "github"], ["github"]];
    let fetches = 0;
    const names = new McpServerNames(async () => answers[Math.min(fetches++, answers.length - 1)]!);
    expect(await names.resolve("tracker_create_issue")).toEqual({ server: "tracker", tool: "create_issue" });
    expect(await names.resolve("tracker_list")).toEqual({ server: "tracker", tool: "list" });
    expect(fetches).toBe(1);
    // A miss refetches once: a server registered since the last fetch.
    expect(await names.resolve("github_create_issue")).toEqual({ server: "github", tool: "create_issue" });
    expect(fetches).toBe(2);
    // A miss that stays a miss costs one more fetch and yields nothing.
    expect(await names.resolve("bash")).toBeUndefined();
    expect(fetches).toBe(3);
    expect(McpServerNames.changedBy("mcp.updated")).toBe(true);
    expect(McpServerNames.changedBy("session.idle")).toBe(false);
    names.invalidate();
    expect(await names.resolve("github_x")).toEqual({ server: "github", tool: "x" });
    expect(fetches).toBe(4);
  });

  test("a failed fetch is an empty set, not an error", async () => {
    const names = new McpServerNames(async () => { throw new Error("offline"); });
    expect(await names.resolve("tracker_create_issue")).toBeUndefined();
  });
});
