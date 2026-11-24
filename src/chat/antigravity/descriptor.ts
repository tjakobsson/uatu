/**
 * Antigravity's registration descriptor: the identity and declared login that
 * chat, the Hub's Agent accounts and the e2e harness all read. The login is
 * the one `agy` holds; the Hub does not manage it, so Agent accounts has no
 * Antigravity entry and login guidance names `agy` itself.
 */

import type { ChatAgentDescriptor } from "../types";

export const ANTIGRAVITY_AGENT = {
  id: "antigravity",
  name: "Antigravity",
  login: { command: "agy", hubManaged: false },
} as const satisfies ChatAgentDescriptor;
