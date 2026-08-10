// Client/server build-identity handshake (client-freshness capability).
// The server's identity rides every state payload; this module compares it
// against the identity embedded in the client bundle — on boot and on every
// SSE (re)connect, since a reconnect is exactly when a server restart with a
// new build becomes observable. On mismatch the page reloads itself once per
// observed server identity (a sessionStorage marker is the loop guard); if
// the mismatch persists after that reload, a visible stale-client notice
// renders instead of a reload loop.

import type { BuildSummary } from "../shared/types";
import { API_REVISION, BUILD } from "../shared/version";

export type FreshnessDecision = "in-sync" | "reload" | "notice";

export type ClientBuildIdentity = {
  version: string;
  commitSha: string;
  apiRevision: number;
};

// The identity baked into this bundle at build time (`__UATU_BUILD__` via
// scripts/build.ts reaches the client chunks too). Dev serving has no
// injected identity and the browser fallback can't run git, so commitSha
// degrades to "unknown" there — the comparison below treats that as
// "commit unknowable", not as a mismatch.
export const CLIENT_BUILD_IDENTITY: ClientBuildIdentity = {
  version: BUILD.version,
  commitSha: BUILD.commitSha,
  apiRevision: API_REVISION,
};

export const FRESHNESS_RELOAD_MARKER_KEY = "uatu:freshness-reloaded-for";

export function serverIdentityKey(server: BuildSummary): string {
  return `${server.version}@${server.commitSha}#${server.apiRevision}`;
}

export function buildsMismatch(client: ClientBuildIdentity, server: BuildSummary): boolean {
  if (client.apiRevision !== server.apiRevision) {
    return true;
  }
  if (client.version !== server.version) {
    return true;
  }
  if (client.commitSha === "unknown" || server.commitSha === "unknown") {
    return false;
  }
  return client.commitSha !== server.commitSha;
}

// Pure decision core, unit-tested separately from the DOM/storage effects:
// a mismatch reloads unless this page already reloaded for exactly this
// server identity — a NEW server identity re-arms the automatic reload.
export function evaluateFreshness(
  client: ClientBuildIdentity,
  server: BuildSummary,
  reloadedForIdentity: string | null,
): FreshnessDecision {
  if (!buildsMismatch(client, server)) {
    return "in-sync";
  }
  return reloadedForIdentity === serverIdentityKey(server) ? "notice" : "reload";
}

function readReloadMarker(): string | null {
  try {
    return window.sessionStorage.getItem(FRESHNESS_RELOAD_MARKER_KEY);
  } catch {
    return null;
  }
}

function writeReloadMarker(identity: string): boolean {
  try {
    window.sessionStorage.setItem(FRESHNESS_RELOAD_MARKER_KEY, identity);
    return true;
  } catch {
    // No usable sessionStorage means no loop guard — surfacing the notice
    // is safer than risking an unbounded reload loop.
    return false;
  }
}

function clearReloadMarker(): void {
  try {
    window.sessionStorage.removeItem(FRESHNESS_RELOAD_MARKER_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

const NOTICE_ID = "stale-client-notice";

function showStaleClientNotice(server: BuildSummary): void {
  if (document.getElementById(NOTICE_ID)) {
    return;
  }
  const notice = document.createElement("div");
  notice.id = NOTICE_ID;
  notice.className = "stale-client-notice";
  notice.setAttribute("role", "alert");

  const message = document.createElement("span");
  message.className = "stale-client-notice-message";
  message.textContent = `This page is running a different build than the server (${server.identifier}). Reload to update.`;

  const action = document.createElement("button");
  action.type = "button";
  action.className = "stale-client-notice-action";
  action.textContent = "Reload";
  action.addEventListener("click", () => {
    window.location.reload();
  });

  notice.append(message, action);
  document.body.appendChild(notice);
}

function removeStaleClientNotice(): void {
  document.getElementById(NOTICE_ID)?.remove();
}

// Entry point, called from the SSE state reducer for every payload (boot
// applies its initial payload through the same funnel).
export function checkBuildFreshness(server: BuildSummary): void {
  const decision = evaluateFreshness(CLIENT_BUILD_IDENTITY, server, readReloadMarker());
  if (decision === "in-sync") {
    clearReloadMarker();
    removeStaleClientNotice();
    return;
  }
  if (decision === "reload" && writeReloadMarker(serverIdentityKey(server))) {
    window.location.reload();
    return;
  }
  showStaleClientNotice(server);
}
