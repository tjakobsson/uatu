import type { RegisteredChatAgent } from "./agents";
import { ANTIGRAVITY_AGENT } from "./antigravity/descriptor";
import { AntigravityProvider } from "./antigravity/provider";
import { AntigravityRuntime } from "./antigravity/runtime";
import type { ChatEventMetrics } from "./adapter";
import { CLAUDE_CODE_AGENT } from "./claude/descriptor";
import { ClaudeProvider } from "./claude/provider";
import { ClaudeRuntime } from "./claude/runtime";
import { openCodeAgentRuntime } from "./opencode/agent-runtime";
import { OPENCODE_AGENT } from "./opencode/descriptor";
import { pathAgentRuntime } from "./path-agent-runtime";
import { LazyChatService } from "./service";

/**
 * The agents a workspace offers, each with its own runtime nature (D4 of
 * the multi-agent change): OpenCode as a spawned loopback server, Claude
 * Code as probe-only with per-conversation SDK sessions, Antigravity as
 * probe-only with a per-conversation `agy acp` process. Registration order
 * is the picker order, and the first is the server default.
 */
export function registeredChatAgents(options: { workspacePath: string; metrics?: ChatEventMetrics }): RegisteredChatAgent[] {
  const { workspacePath, metrics } = options;
  return [
    {
      descriptor: OPENCODE_AGENT,
      service: new LazyChatService({ workspacePath, metrics, agentName: OPENCODE_AGENT.name, runtime: openCodeAgentRuntime({ workspacePath }) }),
    },
    {
      descriptor: CLAUDE_CODE_AGENT,
      service: new LazyChatService({
        workspacePath, metrics, agentName: CLAUDE_CODE_AGENT.name,
        runtime: pathAgentRuntime(new ClaudeRuntime({ workspacePath }), executable => new ClaudeProvider({ workspacePath, executable })),
      }),
    },
    {
      descriptor: ANTIGRAVITY_AGENT,
      service: new LazyChatService({
        workspacePath, metrics, agentName: ANTIGRAVITY_AGENT.name,
        runtime: pathAgentRuntime(new AntigravityRuntime({ workspacePath }), executable => new AntigravityProvider({ workspacePath, executable })),
      }),
    },
  ];
}
