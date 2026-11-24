/**
 * Where the chat sends someone whose agent has no usable login.
 *
 * Each agent declares its login on its descriptor: its own login command,
 * and whether the Hub's Settings manages that login. On a Hub-served page
 * (the `uatu-hub` marker the Hub proxy injects) a Hub-managed login is fixed
 * in the Hub's Settings, opened at the agent's Agent accounts card. The Hub answers `/settings` at
 * the origin root, outside the session's base path, which is why this is an
 * origin-rooted URL and not an `appUrl()`. Anywhere else, and for an agent the
 * Hub does not manage, the action names the agent's own login command to run
 * where UatuCode runs.
 */

import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { isHubPage } from "../shared/app-url";
import type { ChatAgentDescriptor } from "./types";

export type LoginAction = {
  agentName: string;
  /** The Hub's Settings, at this agent's card; null outside a Hub or for a login the Hub does not manage. */
  href: string | null;
  /** The agent's own login command. */
  command: string;
};

// `hubPage` is the Hub's own marker on the page (`isHubPage()`), not the base
// path's shape: a standalone run under a Hub-shaped `--base-path` has no
// Settings to link to.
export function loginActionFor(agent: ChatAgentDescriptor, hubPage = isHubPage()): LoginAction {
  return {
    agentName: agent.name,
    href: agent.login.hubManaged && hubPage ? `/settings#agent-accounts/${encodeURIComponent(agent.id)}` : null,
    command: agent.login.command,
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
