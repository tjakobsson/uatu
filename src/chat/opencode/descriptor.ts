/**
 * OpenCode's registration descriptor: the identity and declared login that
 * chat, the Hub's Agent accounts and the e2e harness all read. The Hub
 * manages OpenCode's provider logins, so login guidance links there when the
 * page is Hub-served.
 */

import type { ChatAgentDescriptor } from "../types";

export const OPENCODE_AGENT = {
  id: "opencode",
  name: "OpenCode",
  login: { command: "opencode auth login", hubManaged: true },
} as const satisfies ChatAgentDescriptor;
