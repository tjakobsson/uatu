/**
 * Claude Code's registration descriptor: the identity and declared login that
 * chat, the Hub's Agent accounts and the e2e harness all read. The Hub
 * manages Claude Code's login, so login guidance links there when the page is
 * Hub-served.
 */

import type { ChatAgentDescriptor } from "../types";

export const CLAUDE_CODE_AGENT = {
  id: "claude",
  name: "Claude Code",
  login: { command: "claude auth login", hubManaged: true },
} as const satisfies ChatAgentDescriptor;
