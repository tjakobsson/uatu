// The hub's upstream source for the live broker: internal session routes
// reached through the session link, which applies the Hub-held token and the
// same loopback header shaping the proxy uses — the session's localhost
// origin gate holds and the token never leaves the hub.

import type { WorkspaceRegistry } from "./registry";
import type { SessionManager } from "./sessions";
import type { LiveUpstreamSource } from "./live-broker";

export function createHubUpstreamSource(deps: {
  sessions: Pick<SessionManager, "get" | "isRunning" | "onChange">;
  registry: Pick<WorkspaceRegistry, "list"> & Partial<Pick<WorkspaceRegistry, "onRemoved">>;
}): LiveUpstreamSource {
  const onRemoved = deps.registry.onRemoved?.bind(deps.registry);
  return {
    isRunning: workspaceId => deps.sessions.isRunning(workspaceId),
    workspaceIds: () => deps.registry.list().map(entry => entry.id),
    open({ workspaceId, path, signal }) {
      const session = deps.sessions.get(workspaceId);
      if (!session) return Promise.reject(new Error("workspace session is not running"));
      // The session serves under its base path (/s/<id>/); `path` is
      // session-relative and already carries its query.
      return fetch(session.link.url(path), { headers: session.link.requestHeaders(), signal, redirect: "manual" });
    },
    onSessionChange: listener => deps.sessions.onChange(listener),
    ...(onRemoved ? { onWorkspaceRemoved: (listener: (workspaceId: string) => void) => onRemoved(listener) } : {}),
  };
}
