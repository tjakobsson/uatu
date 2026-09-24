import type { CoverageAnnotations } from "../coverage-annotations";

/**
 * OpenCode coverage annotations (see coverage-annotations.ts). Entries are
 * named by their generation's wire type, prefixed by generation: `1.x:` for
 * `@opencode-ai/sdk`, `2.x:` for `@opencode/schema` — the two SDKs share
 * event names that the two mappers treat differently. A key ending in `*`
 * gives the reason for every ignored entry under that prefix; the most
 * specific key wins.
 */
export const openCodeCoverageAnnotations: CoverageAnnotations = {
  reasons: {
    "1.x:step-start": "Marks a step boundary; carries only a snapshot hash.",
    "1.x:step-finish": "Its cost and tokens are restated on the message's message.updated, which the usage carrier reads.",
    "1.x:snapshot": "An internal git tree hash; nothing to show.",

    // Streaming progress whose endpoints carry what is shown.
    "1.x:session.next.tool.input.*": "Streams the tool's input; the call event carries it whole.",
    "2.x:session.tool.input.*": "Streams the tool's input; the call event carries it whole.",
    "1.x:session.next.compaction.delta": "Streams compaction progress; the started and ended events bracket the one compaction row.",
    "2.x:session.compaction.delta": "Streams compaction progress; the started and ended events bracket the one compaction row.",
    "2.x:session.step.streamed": "Streams step progress; the step's started and ended events carry what is shown.",

    // Session bookkeeping with nothing new for the timeline.
    "2.x:session.usage.*": "The session's running total; per-message figures ride session.step.ended.",
    "2.x:session.inbox.*": "Delivery bookkeeping for a prompt already shown when session.inbox.enqueued accepted it.",
    "2.x:session.instructions.updated": "Which instruction files the session loaded; uatu does not present the agent's system context.",
    "2.x:session.viewed": "A client marked the session read; nothing happened in the conversation.",
    "2.x:session.permissions": "The session's standing permission rules; each request arrives as permission.asked.",

    // The server's own surfaces, not the conversation.
    "1.x:tui.*": "Instructions for OpenCode's own terminal UI, which uatu is not.",
    "2.x:tui.*": "Instructions for OpenCode's own terminal UI, which uatu is not.",
    "1.x:pty.*": "Terminal sessions on the OpenCode server, not the conversation's; the agent's shell runs arrive as session.next.shell.* events.",
    "2.x:pty.*": "Terminal sessions on the OpenCode server, not the conversation's; the agent's shell runs arrive as session.shell.* events.",
    "2.x:persistent-pty.*": "Terminal sessions on the OpenCode server, not the conversation's; the agent's shell runs arrive as session.shell.* events.",
    "2.x:shell.*": "Terminal sessions on the OpenCode server, not the conversation's; the agent's shell runs arrive as session.shell.* events.",
    "1.x:mcp.*": "MCP server bookkeeping; MCP tool calls themselves arrive as tool events.",
    "2.x:mcp.*": "MCP server bookkeeping; MCP tool calls themselves arrive as tool events.",
    "1.x:server.*": "Server connection lifecycle; uatu tracks the server through its own connection.",
    "2.x:server.*": "Server connection lifecycle; uatu tracks the server through its own connection.",
    "1.x:global.disposed": "Server connection lifecycle; uatu tracks the server through its own connection.",
    "2.x:location.shutdown": "Server connection lifecycle; uatu tracks the server through its own connection.",

    // Installation, configuration, and catalogs.
    "1.x:installation.*": "The OpenCode installation's own lifecycle; not conversation activity.",
    "2.x:installation.*": "The OpenCode installation's own lifecycle; not conversation activity.",
    "2.x:models-dev.refreshed": "The model catalog refreshed; uatu fetches models through the API when it needs them.",
    "1.x:catalog.updated": "The model catalog changed; uatu fetches models through the API when it needs them.",
    "1.x:integration.*": "Server configuration changed; not conversation activity.",
    "2.x:integration.*": "Server configuration changed; not conversation activity.",
    "1.x:plugin.*": "Server configuration changed; not conversation activity.",
    "2.x:plugin.*": "Server configuration changed; not conversation activity.",
    "2.x:config.*": "Server configuration changed; not conversation activity.",
    "2.x:credential.*": "Server configuration changed; not conversation activity.",
    "2.x:agent.*": "Server configuration changed; uatu reads agents through the API.",
    "2.x:model.*": "Server configuration changed; uatu reads models through the API.",
    "2.x:provider.*": "Server configuration changed; uatu reads models through the API.",
    "2.x:command.*": "Server configuration changed; uatu reads commands through the API.",
    "2.x:skill.*": "Server configuration changed; not conversation activity.",
    "2.x:websearch.*": "Server configuration changed; not conversation activity.",

    // Project and filesystem state, which uatu watches itself.
    "1.x:project.*": "Project state on the server; uatu watches the workspace itself.",
    "2.x:project.*": "Project state on the server; uatu watches the workspace itself.",
    "1.x:workspace.*": "Project state on the server; uatu watches the workspace itself.",
    "1.x:worktree.*": "Project state on the server; uatu watches the workspace itself.",
    "2.x:worktree.*": "Project state on the server; uatu watches the workspace itself.",
    "1.x:reference.*": "Project state on the server; uatu watches the workspace itself.",
    "2.x:reference.*": "Project state on the server; uatu watches the workspace itself.",
    "1.x:vcs.*": "Project state on the server; uatu watches the workspace itself.",
    "2.x:vcs.*": "Project state on the server; uatu watches the workspace itself.",
    "1.x:file.watcher.updated": "Project state on the server; uatu watches the workspace itself.",
    "2.x:filesystem.*": "Project state on the server; uatu watches the workspace itself.",
    "1.x:lsp.*": "Language-server state on the server; not conversation activity.",
  },
  behaviorMissing: {},
};
