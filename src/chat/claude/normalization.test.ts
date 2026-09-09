import { describe, expect, test } from "bun:test";

import { describeSessionScopedUpdates, sessionScopedSuggestions } from "./normalization";

// What "Allow always" lists must be what the reply forwards. One filter
// feeds both, and these pin what that filter keeps and drops.
describe("Claude Code session-scoped permission updates", () => {
  const session = (update: Record<string, unknown>) => ({ destination: "session", ...update });

  test("rules render in Claude Code's rule syntax under the behavior they change", () => {
    expect(describeSessionScopedUpdates([
      session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "git status:*" }] }),
      session({ type: "replaceRules", behavior: "allow", rules: [{ toolName: "Read" }, { toolName: "Edit", ruleContent: "src/**" }] }),
      // Restrictive updates in the same bundle are forwarded and said too:
      // applying only the additions would leave a more permissive state
      // than Claude Code's own "always allow" produces.
      session({ type: "addRules", behavior: "deny", rules: [{ toolName: "Bash", ruleContent: "rm:*" }] }),
      session({ type: "removeRules", behavior: "allow", rules: [{ toolName: "WebFetch" }] }),
      session({ type: "addRules", behavior: "ask", rules: [{ toolName: "Write" }] }),
    ])).toEqual([
      "Allow: Bash(git status:*)",
      "Replace allow rules with: Read, Edit(src/**)",
      "Deny: Bash(rm:*)",
      "Remove allow rule: WebFetch",
      "Ask before: Write",
    ]);
  });

  test("directory grants, withdrawals, and mode switches are said in words", () => {
    expect(describeSessionScopedUpdates([
      session({ type: "addDirectories", directories: ["/tmp/work"] }),
      session({ type: "removeDirectories", directories: ["/tmp/old"] }),
      session({ type: "setMode", mode: "acceptEdits" }),
    ])).toEqual(["Working directory: /tmp/work", "Withdraw working directory: /tmp/old", "Permission mode: acceptEdits"]);
  });

  test("a suggestion bound for a settings file is neither listed nor forwarded", () => {
    const persisting = { type: "addRules", behavior: "allow", destination: "userSettings", rules: [{ toolName: "Write" }] };
    const suggestions = [persisting, session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Write" }] })];
    expect(describeSessionScopedUpdates(suggestions)).toEqual(["Allow: Write"]);
    expect(sessionScopedSuggestions(suggestions)).toEqual([suggestions[1]]);
  });

  test("malformed suggestions are dropped whole", () => {
    const suggestions = [
      session({ type: "addRules", behavior: "allow", rules: [] }),
      session({ type: "addRules", behavior: "sometimes", rules: [{ toolName: "Bash" }] }),
      session({ type: "addDirectories", directories: [] }),
      // One bad rule drops the whole suggestion: the reply would otherwise
      // forward a rule the card never showed.
      session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "git status:*" }, { toolName: 42 }] }),
      session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "" }] }),
      { destination: "session" },
      null,
      "addRules",
    ];
    expect(describeSessionScopedUpdates(suggestions)).toEqual([]);
    expect(sessionScopedSuggestions(suggestions)).toEqual([]);
  });

  test("no suggestions at all is an empty list for both", () => {
    expect(describeSessionScopedUpdates(undefined)).toEqual([]);
    expect(sessionScopedSuggestions(undefined)).toEqual([]);
  });

  test("the listed lines and the forwarded updates agree one to one", () => {
    const suggestions = [
      session({ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }] }),
      { type: "addRules", behavior: "allow", destination: "projectSettings", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }] },
      session({ type: "addDirectories", directories: ["/workspace"] }),
    ];
    expect(describeSessionScopedUpdates(suggestions)).toHaveLength(sessionScopedSuggestions(suggestions).length);
  });
});
