import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { agentLoginCommand, hubServed, loginActionElement, loginActionFor, loginActionMarkup } from "./login-action";

describe("login action", () => {
  test("a Hub-served session links to the agent's card in the Hub's Settings", () => {
    expect(hubServed("/s/my-workspace/")).toBe(true);
    expect(loginActionFor("claude", "Claude Code", "/s/my-workspace/")).toEqual({ agentName: "Claude Code", href: "/settings#agent-accounts/claude", command: "claude auth login" });
  });

  test("anywhere else names the agent's own login command", () => {
    expect(hubServed("/")).toBe(false);
    expect(loginActionFor("opencode", "OpenCode", "/")).toEqual({ agentName: "OpenCode", href: null, command: "opencode auth login" });
    expect(agentLoginCommand("other")).toBe("other login");
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
