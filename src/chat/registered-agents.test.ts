import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MultiAgentChatService } from "./agents";
import { AntigravityProvider } from "./antigravity/provider";
import { registeredChatAgents } from "./registered-agents";
import { VisualStore } from "./visual-store";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

test("chat status lists OpenCode, Claude Code and Antigravity in that order, with OpenCode the default, starting nothing", async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "uatu-registered-agents-"));
  temporary.push(workspacePath);
  const router = new MultiAgentChatService({ workspacePath, agents: registeredChatAgents({ workspacePath }), visualStore: new VisualStore(workspacePath, path.join(workspacePath, ".visual-state")) });
  try {
    expect(router.agents().map(agent => agent.id)).toEqual(["opencode", "claude", "antigravity"]);
    expect(router.defaultAgentId()).toBe("opencode");
    const statuses = await router.status();
    expect(statuses.map(status => [status.agent.id, status.agent.name, status.availability.state])).toEqual([
      ["opencode", "OpenCode", "idle"], ["claude", "Claude Code", "idle"], ["antigravity", "Antigravity", "idle"],
    ]);
    expect(statuses[2]!.agent.login).toEqual({ command: "agy", hubManaged: false });
  } finally { await router.dispose(); }
});

test("Antigravity declares the capabilities its spec lists, and none it does not", () => {
  const provider = new AntigravityProvider({ workspacePath: "/workspace", executable: "/nonexistent/agy" });
  const declared = provider.describe();
  expect(declared).toEqual({ id: "antigravity", name: "Antigravity", capabilities: ["models", "variants", "modes", "commands", "permissions", "context", "immediate-steering", "send-now"] });
  for (const absent of ["steering", "conversation-rename", "reversible-history", "background-tasks", "questions", "subagents", "scheduled-wakeups", "side-generation", "usage", "custom-model-id"]) {
    expect(declared.capabilities).not.toContain(absent as never);
  }
  expect(declared.permissionScopeNote).toBeUndefined();
});
