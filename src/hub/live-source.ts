// The hub's upstream source for the live broker: child routes reached over
// the session's loopback endpoint through the brokered token, with the same
// loopback header shaping the proxy applies — the child's localhost origin
// gate holds and the token never leaves the hub.

import { childRequestHeaders, childUrlFor } from "./proxy";
import type { WorkspaceRegistry } from "./registry";
import type { SessionManager } from "./sessions";
import type { LiveUpstreamSource } from "./live-broker";

export function createHubUpstreamSource(deps: {
  sessions: Pick<SessionManager, "get" | "isRunning" | "onChange">;
  registry: Pick<WorkspaceRegistry, "list">;
}): LiveUpstreamSource {
  return {
    isRunning: workspaceId => deps.sessions.isRunning(workspaceId),
    workspaceIds: () => deps.registry.list().map(entry => entry.id),
    open({ workspaceId, path, signal }) {
      const session = deps.sessions.get(workspaceId);
      if (!session) return Promise.reject(new Error("workspace session is not running"));
      // The child serves under its base path (/s/<id>/); `path` is
      // child-relative and already carries its query.
      const target = childUrlFor(session, new URL(session.basePath.replace(/\/$/, "") + path, "http://child.invalid"));
      return fetch(target, { headers: childRequestHeaders(session), signal, redirect: "manual" });
    },
    onSessionChange: listener => deps.sessions.onChange(listener),
  };
}
