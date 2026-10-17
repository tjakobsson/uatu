import type { CoverageAnnotations } from "../coverage-annotations";

/**
 * OpenCode coverage annotations (see coverage-annotations.ts). Entries are
 * named by their generation's wire type, prefixed by generation: `1.x:` for
 * `@opencode-ai/sdk`, `2.x:` for `@opencode/schema` — the two SDKs share
 * event names that the two mappers treat differently. A key ending in `*`
 * gives the reason for every ignored entry under that prefix; the most
 * specific key wins.
 *
 * The 2.x inbox needs no reason any more (opencode-v2-steering D3, D4): the
 * user's entries are the dock's pending steers until `session.inbox.delivered`
 * puts the message on the timeline, and `cancelled` and `delivery.changed`
 * move the dock. The report has no operations axis, so the inbox operations
 * are recorded here: `session.inbox.list` (reconcile on attach and reconnect),
 * `session.inbox.cancel` (withdraw a steer), and `session.interrupt` with
 * `resume` are used; `session.inbox.update` is deliberately not — switching
 * delivery through it would leave the message in OpenCode's queue, where it
 * loses the configuration frozen at submission (D1).
 *
 * V2 native background work additionally uses `session.background` (all
 * eligible parent blockers), `session.active`/`session.get`/`message.list`
 * and all synthetic `session.inbox.list` entries for read-only recovery.
 * Verified personal Hub steering may make one `session.background` call
 * after acknowledged native prompt/resume; it adds no job-start automation
 * or SDK endpoint. Composite unknowns retain receipts and reconcile read-only.
 * `/btw` separately uses native `session.generate`: one inference from current
 * context, no prompt admission, interruption or agent tool execution loop.
 * `session.interrupt({resume:false})` targets a verified child occurrence;
 * `shell.get`/`shell.output`/`shell.remove` inspect or remove owned shell work.
 * Removal deletes output and may fail pending capture; neither shell exit nor
 * deletion establishes a terminal worker result. Source-shaped synthetic
 * metadata establishes that outcome. No generic jobs endpoint, synthetic
 * injection, explicit parent resume or shell-list polling is used.
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
    "2.x:session.instructions.updated": "Which instruction files the session loaded; uatu does not present the agent's system context.",
    "2.x:session.viewed": "A client marked the session read; nothing happened in the conversation.",
    "2.x:session.permissions": "The session's standing permission rules; each request arrives as permission.asked.",

    // The server's own surfaces, not the conversation.
    "1.x:tui.*": "Instructions for OpenCode's own terminal UI, which uatu is not.",
    "2.x:tui.*": "Instructions for OpenCode's own terminal UI, which uatu is not.",
    "1.x:pty.*": "Terminal sessions on the OpenCode server, not the conversation's; the agent's shell runs arrive as session.next.shell.* events.",
    "2.x:pty.*": "Terminal sessions on the OpenCode server, not the conversation's; the agent's shell runs arrive as session.shell.* events.",
    "2.x:persistent-pty.*": "Terminal sessions on the OpenCode server, not the conversation's; the agent's shell runs arrive as session.shell.* events.",
    "2.x:shell.*": "Shell registry/process edges are not background job settlement: confirmed results arrive as correlated source:shell synthetic inbox/history metadata. Owned shell get/output/remove operations support inspection and Stop; deletion can remove final capture, not guarantee cancellation.",
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
    "1.x:integration.*": "Login changes; a workspace learns of them from the Hub's Agent accounts (accounts-changed), which re-reads and replays them, not from these events.",
    "2.x:integration.*": "Login changes; a workspace learns of them from the Hub's Agent accounts (accounts-changed), which re-reads and replays them, not from these events.",
    "1.x:plugin.*": "Server configuration changed; not conversation activity.",
    "2.x:plugin.*": "Server configuration changed; not conversation activity.",
    "2.x:config.*": "Server configuration changed; not conversation activity.",
    "2.x:credential.*": "Login changes; a workspace learns of them from the Hub's Agent accounts (accounts-changed), which re-reads and replays them, not from these events.",
    "2.x:agent.*": "Server configuration changed; uatu reads agents through the API.",
    "2.x:model.*": "Server configuration changed; uatu reads models through the API.",
    "2.x:provider.*": "Server configuration changed; uatu reads models through the API.",
    "2.x:command.*": "Server configuration changed; uatu reads commands through the API.",
    "2.x:skill.*": "Server configuration changed; uatu reads skills through the API.",
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
