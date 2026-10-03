/**
 * Tells every running workspace that the machine's agent logins changed
 * (design D6). Each child re-reads and replays the change on its own agent
 * server, then ticks its clients. Best-effort and bounded: a workspace that
 * does not answer re-reads on its own when its agent next starts, and one
 * wedged child must not hold the others.
 */

import type { ChatAccountChange } from "../chat/types";
import type { AccountAgentId } from "./agent-account-types";
import { childRequestHeaders, childUrlFor } from "./proxy";
import type { SessionManager } from "./sessions";

const NOTIFY_TIMEOUT_MS = 10_000;

export type AccountChangeNotifier = (agent: AccountAgentId, change: ChatAccountChange) => Promise<void>;

export function createAccountChangeNotifier(options: {
  sessions: Pick<SessionManager, "get" | "runningIds">;
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): AccountChangeNotifier {
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  return async (agent, change) => {
    await Promise.allSettled(options.sessions.runningIds().map(async workspaceId => {
      const running = options.sessions.get(workspaceId);
      if (!running) return;
      const url = childUrlFor(running, new URL(`http://hub.invalid/s/${encodeURIComponent(workspaceId)}/api/chat/accounts-changed`));
      const headers = childRequestHeaders(running);
      headers.set("accept", "application/json");
      headers.set("content-type", "application/json");
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: agent, change }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
    }));
  };
}
