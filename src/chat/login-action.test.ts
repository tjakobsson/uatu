import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { CLAUDE_CODE_AGENT } from "./claude/descriptor";
import { loginActionElement, loginActionFor, loginActionMarkup } from "./login-action";
import { OPENCODE_AGENT } from "./opencode/descriptor";

const UNMANAGED = { id: "stub", name: "Stub Agent", login: { command: "stub-agent login --device", hubManaged: false } };

describe("login action", () => {
  test("a Hub-served session links a Hub-managed agent to its card in the Hub's Settings", () => {
    expect(loginActionFor(CLAUDE_CODE_AGENT, true)).toEqual({ agentName: "Claude Code", href: "/settings#agent-accounts/claude", command: "claude auth login" });
    expect(loginActionFor(OPENCODE_AGENT, true)).toEqual({ agentName: "OpenCode", href: "/settings#agent-accounts/opencode", command: "opencode auth login" });
  });

  test("a Hub-served session names the command of an agent whose login the Hub does not manage", () => {
    expect(loginActionFor(UNMANAGED, true)).toEqual({ agentName: "Stub Agent", href: null, command: "stub-agent login --device" });
  });

  test("anywhere else names the agent's own login command", () => {
    expect(loginActionFor(OPENCODE_AGENT, false)).toEqual({ agentName: "OpenCode", href: null, command: "opencode auth login" });
    expect(loginActionFor(CLAUDE_CODE_AGENT, false)).toEqual({ agentName: "Claude Code", href: null, command: "claude auth login" });
    expect(loginActionFor(UNMANAGED, false)).toEqual({ agentName: "Stub Agent", href: null, command: "stub-agent login --device" });
  });

  test("the Hub check is the Hub's page marker, not a Hub-shaped base path", async () => {
    const { isHubPage, resetAppBasePathForTests } = await import("../shared/app-url");
    const { document } = parseHTML('<!doctype html><html><head><meta name="uatu-base-path" content="/s/demo/"></head><body></body></html>');
    // Restored exactly in teardown: absent stays absent, so a later file's
    // `Reflect.set(globalThis, "document", …)` still works.
    const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: document });
    try {
      resetAppBasePathForTests();
      // A standalone run under `--base-path /s/demo/` has no Settings page.
      expect(isHubPage()).toBe(false);
      expect(loginActionFor(CLAUDE_CODE_AGENT).href).toBeNull();
      const marker = document.createElement("meta");
      marker.setAttribute("name", "uatu-hub");
      marker.setAttribute("content", "true");
      document.head.append(marker);
      expect(loginActionFor(CLAUDE_CODE_AGENT).href).toBe("/settings#agent-accounts/claude");
    } finally {
      if (saved) Object.defineProperty(globalThis, "document", saved);
      else Reflect.deleteProperty(globalThis, "document");
      resetAppBasePathForTests();
    }
  });

  test("markup and DOM escape the agent name and command", () => {
    const action = { agentName: "<b>Agent</b>", href: null, command: "a && b" };
    expect(loginActionMarkup(action)).toBe("<span class=\"chat-login-command\">Run <code>a &amp;&amp; b</code> where UatuCode runs.</span>");
    expect(loginActionMarkup({ ...action, href: "/settings#agent-accounts/x" })).toContain("Log in to &lt;b&gt;Agent&lt;/b&gt;");
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    const link = loginActionElement(document as unknown as Document, { ...action, href: "/settings#agent-accounts/x" });
    expect(link.tagName).toBe("A");
    expect(link.textContent).toBe("Log in to <b>Agent</b>");
  });
});
