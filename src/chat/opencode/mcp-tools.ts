/**
 * Which MCP server and tool an OpenCode permission action names.
 *
 * OpenCode asks permission for an MCP tool under the tool's registry name,
 * `<server>_<tool>` with each half sanitized (anything outside
 * `[A-Za-z0-9_-]` becomes `_`): 1.x `McpCatalog.toolName`, 2.x
 * `McpTool.name`. The name alone cannot be split, since a server may be
 * called `my_tools`, but both generations report the connected servers, and the
 * action matched against `<sanitized server>_` for each of them is exact.
 * The card names the server as the user registered it and the tool as it
 * resolved; the raw action stays what the persistent-approval confirmation
 * names, since that string is the rule OpenCode installs.
 */

import type { NormalizedProviderUpdate } from "../provider";

export type McpToolReference = { server: string; tool: string };

/** OpenCode's own sanitization of a server or tool name, on both generations. */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// OpenCode's own permission actions, on either generation. None of them is
// an MCP tool, whatever server names are registered.
const BUILT_IN_ACTIONS: ReadonlySet<string> = new Set([
  "bash", "shell", "edit", "write", "read", "list", "glob", "grep", "patch", "apply_patch", "webfetch", "websearch",
  "external_directory", "doom_loop", "skill", "task", "subagent", "question", "todowrite", "todoread", "execute", "permission",
]);

/**
 * Whether a permission looks like OpenCode's ask for an MCP tool call: a
 * non-built-in action with nothing but wildcards for resources, which is
 * all an MCP tool's ask carries on either generation (1.x `patterns:
 * ["*"]`, 2.x `resources: ["*"]`). A built-in ask names a path, a command,
 * or a tool, so a server registered as `external` cannot turn
 * `external_directory` on `/etc/*` into an MCP call.
 */
export function looksLikeMcpPermission(action: string, resources: readonly string[]): boolean {
  return !BUILT_IN_ACTIONS.has(action) && resources.every(resource => resource.trim() === "*");
}

/**
 * The server and tool an action resolves to among `servers`, or undefined
 * when it matches none, or more than one. With `github` and
 * `github_enterprise` both registered, `github_enterprise_create_issue` is
 * either server's; naming one would be a guess, and a wrong server on an
 * approval is worse than the raw action. The tool half must be non-empty.
 */
export function mcpToolFromAction(action: string, servers: Iterable<string>): McpToolReference | undefined {
  const matches: McpToolReference[] = [];
  for (const server of servers) {
    const prefix = `${sanitizeMcpName(server)}_`;
    if (!action.startsWith(prefix) || action.length === prefix.length) continue;
    if (!matches.some(match => match.server === server)) matches.push({ server, tool: action.slice(prefix.length) });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The reported MCP server names, fetched on first need and kept until an
 * `mcp.*` event says the set changed. A miss refetches once before giving
 * up, so a server registered after the last fetch is still seen; a fetch
 * failure yields the empty set rather than an error, since the card only
 * loses its label.
 */
export class McpServerNames {
  private names: Promise<string[]> | undefined;

  constructor(private readonly fetch: () => Promise<string[]>) {}

  /** Forget the cached set; the next resolution fetches again. */
  invalidate(): void {
    this.names = undefined;
  }

  /** Whether an event means the set of servers may have changed. */
  static changedBy(eventType: string): boolean {
    return eventType.startsWith("mcp.");
  }

  async resolve(action: string): Promise<McpToolReference | undefined> {
    const first = mcpToolFromAction(action, await this.current());
    if (first) return first;
    this.invalidate();
    return mcpToolFromAction(action, await this.current());
  }

  private current(): Promise<string[]> {
    this.names ??= this.fetch().catch(() => []);
    return this.names;
  }
}

/**
 * A pending permission upsert with its MCP server and tool filled in, when
 * the action resolves to one. Everything else passes through untouched.
 * Async because the first resolution of a session fetches the server list.
 */
export async function annotateMcpPermission(update: NormalizedProviderUpdate, names: McpServerNames): Promise<NormalizedProviderUpdate> {
  if (update.kind !== "upsert" || update.item.type !== "permission" || update.item.status !== "pending" || update.item.mcp !== undefined) return update;
  if (!looksLikeMcpPermission(update.item.action, update.item.resources)) return update;
  const mcp = await names.resolve(update.item.action);
  return mcp ? { ...update, item: { ...update.item, mcp } } : update;
}
