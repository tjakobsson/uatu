import type { CoverageAnnotations } from "../coverage-annotations";

/**
 * Claude Code coverage annotations (see coverage-annotations.ts). Message
 * entries are named `type` or `type/subtype`; tools by the name Claude Code
 * calls them on the wire.
 */
export const claudeCoverageAnnotations: CoverageAnnotations & {
  // `sdk-tools.d.ts` declares one `<Name>Input` per tool; the wire name is
  // `<Name>` except where listed here. Several names: every one is probed.
  toolNames: Readonly<Record<string, string | readonly string[]>>;
} = {
  reasons: {
    "system/background_tasks_changed": "Read by the provider as the level signal for which tasks run in the background; the rows come from the task_* edges.",
    "system/commands_changed": "Read by the provider to refresh the slash-command list; nothing for the timeline.",
    "system/control_request_progress": "Progress for client-originated side questions; uatu sends none.",
    "system/mirror_error": "Reports SessionStore mirror failures; uatu configures no SessionStore.",
    "system/thinking_tokens": "A spinner estimate during redacted thinking; the reasoning row appears when its block completes.",
    prompt_suggestion: "Emitted only when promptSuggestions is enabled; uatu does not enable it.",
    "system/hook_started": "Hook lifecycle chatter: uatu leaves includeHookEvents off, so only SessionStart and Setup hooks report, and hooks have no timeline presence.",
    "system/hook_progress": "Hook lifecycle chatter: uatu leaves includeHookEvents off, so only SessionStart and Setup hooks report, and hooks have no timeline presence.",
    "system/hook_response": "Hook lifecycle chatter: uatu leaves includeHookEvents off, so only SessionStart and Setup hooks report, and hooks have no timeline presence.",
    "system/plugin_install": "Headless plugin install progress, emitted only under CLAUDE_CODE_SYNC_PLUGIN_INSTALL, which uatu does not set.",
    "system/session_state_changed": "Turn state comes from the result message and the background_tasks_changed level signal.",
    "system/worker_shutting_down": "Emitted by the remote-worker bridge; uatu runs the CLI locally through the SDK.",
    tool_use_summary: "A one-line summary of tool calls the timeline already shows as rows.",
  },
  behaviorMissing: {},
  toolNames: {
    AgentInput: ["Agent", "Task"],
    FileEditInput: "Edit",
    FileReadInput: "Read",
    FileWriteInput: "Write",
    ListMcpResourcesInput: "ListMcpResourcesTool",
    ReadMcpResourceInput: "ReadMcpResourceTool",
    McpInput: "mcp__<server>__<tool>",
  },
};
