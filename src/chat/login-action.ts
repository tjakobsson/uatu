/**
 * Where the chat sends someone whose agent has no usable login.
 *
 * In a Hub-served session (base path `/s/<id>/`) that is the Hub's Settings,
 * opened at the agent's Agent accounts card. The Hub answers `/settings` at
 * the origin root, outside the session's base path, which is why this is an
 * origin-rooted URL and not an `appUrl()`. Anywhere else there is no Settings
 * page, so the action names the agent's own login command to run where
 * UatuCode runs.
 */

import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appBasePath, workspaceIdFromBasePath } from "../shared/app-url";

export type LoginAction = {
  agentName: string;
  /** The Hub's Settings, at this agent's card; null outside a Hub. */
  href: string | null;
  /** The agent's own login command. */
  command: string;
};

const LOGIN_COMMANDS: Record<string, string> = {
  opencode: "opencode auth login",
  claude: "claude auth login",
};

export function agentLoginCommand(agentId: string): string {
  return LOGIN_COMMANDS[agentId] ?? `${agentId} login`;
}

export function hubServed(basePath = appBasePath()): boolean {
  return workspaceIdFromBasePath(basePath) !== null;
}

export function loginActionFor(agentId: string, agentName: string, basePath = appBasePath()): LoginAction {
  return {
    agentName,
    href: hubServed(basePath) ? `/settings#agent-accounts/${encodeURIComponent(agentId)}` : null,
    command: agentLoginCommand(agentId),
  };
}

/** The action as markup, for the timeline renderer (escaped here). */
export function loginActionMarkup(action: LoginAction): string {
  if (action.href) {
    return `<a class="chat-login-link" href="${escapeHtmlAttribute(action.href)}">Log in to ${escapeHtml(action.agentName)}</a>`;
  }
  return `<span class="chat-login-command">Run <code>${escapeHtml(action.command)}</code> where UatuCode runs.</span>`;
}

/** The action as DOM, for surfaces built from elements. */
export function loginActionElement(document: Document, action: LoginAction): HTMLElement {
  if (action.href) {
    const link = document.createElement("a");
    link.className = "chat-login-link";
    link.href = action.href;
    link.textContent = `Log in to ${action.agentName}`;
    return link;
  }
  const hint = document.createElement("span");
  hint.className = "chat-login-command";
  hint.append("Run ");
  const code = document.createElement("code");
  code.textContent = action.command;
  hint.append(code, " where UatuCode runs.");
  return hint;
}
