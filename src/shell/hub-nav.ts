// Hub workspace switcher — the way back out of a session. When the SPA is
// served through a uatu hub (base path /s/<id>/, hub APIs answering at the
// origin root), the sidebar header grows a chip naming the current
// workspace whose dropdown links to the hub dashboard and to every other
// workspace. Everywhere else — the desktop wrapper, the e2e harness — the
// probe fails or the base path is "/", and the control stays hidden with
// zero cost beyond one fetch in hub-shaped sessions.
//
// The chip and menu are live: the brokered stream's `activity` topic
// (shell/live-channel.ts) says, for every workspace the user may access,
// whether its session is running, whether an agent is working in it, and
// whether an interaction awaits the user. The collapsed chip carries a badge
// while another workspace is waiting on the user, distinct from mere agent
// activity; the open menu names each workspace's state and updates in place.
// Nothing here reveals conversation content or titles — the topic carries
// three booleans and a workspace id.
//
// The hub API URLs here are deliberately origin-rooted, NOT appUrl()-based:
// they belong to the hub (outside the session's base path), which is why
// this file is allowlisted in shared/app-url-discipline.test.ts.

import { appBasePath, workspaceIdFromBasePath } from "../shared/app-url";
import type { WorkspaceActivity } from "../shared/live-protocol";
import { liveChannel } from "./live";

export type HubWorkspaceSummary = {
  id: string;
  // Mutable human label; the id stays the routing identity. Pre-display-name
  // hubs are tolerated by falling back to the id.
  displayName: string;
  path: string;
  running: boolean;
};

export function workspaceMenuLabel(workspace: HubWorkspaceSummary): string {
  return workspace.displayName || workspace.id;
}

// Duplicate display names are legal; the menu disambiguates them with the
// workspace path (or stable id when no path is known).
export function workspaceMenuDetail(
  workspaces: HubWorkspaceSummary[],
  workspace: HubWorkspaceSummary,
): string | null {
  const label = workspaceMenuLabel(workspace);
  const duplicates = workspaces.filter(candidate => workspaceMenuLabel(candidate) === label);
  if (duplicates.length < 2) return null;
  return workspace.path || workspace.id;
}

// The base-path parser lives with the URL chokepoint (the live channel keys
// its stream by the same id); re-exported so the switcher's callers and
// tests keep one import.
export { workspaceIdFromBasePath };

// Live facts per workspace, from the activity topic. Absent means "not
// reported yet": the hub state list still says whether it runs.
export type WorkspaceActivityMap = ReadonlyMap<string, WorkspaceActivity>;

// Folds an activity update into the hub state list: `running` is the fact
// the two sources share, and the chip's dot reads the list. Unknown
// workspaces are left to the caller (a refetch of the list adds them).
export function applyWorkspaceActivity(
  workspaces: HubWorkspaceSummary[],
  ws: string,
  activity: WorkspaceActivity,
): HubWorkspaceSummary[] {
  return workspaces.map(workspace => (
    workspace.id === ws && workspace.running !== activity.running
      ? { ...workspace, running: activity.running }
      : workspace
  ));
}

// What the collapsed chip's badge says about OTHER workspaces. Awaiting
// outranks working: a question the user has to answer is the thing worth a
// glance; agents merely busy elsewhere are a quieter note.
export type SwitcherBadge =
  | { kind: "awaiting"; count: number }
  | { kind: "working"; count: number }
  | null;

// Counts only workspaces the hub list has: the stream never reports a
// workspace being forgotten, so activity for one the list no longer names is
// left over from before and must not claim anything.
export function switcherBadge(
  workspaces: HubWorkspaceSummary[],
  activity: WorkspaceActivityMap,
  currentId: string | null,
): SwitcherBadge {
  let awaiting = 0;
  let working = 0;
  for (const workspace of workspaces) {
    if (workspace.id === currentId) continue;
    const facts = activity.get(workspace.id);
    if (!facts?.running) continue;
    if (facts.awaiting) awaiting += 1;
    else if (facts.working) working += 1;
  }
  if (awaiting > 0) return { kind: "awaiting", count: awaiting };
  if (working > 0) return { kind: "working", count: working };
  return null;
}

// The badge's spoken form — the chip's accessible name and tooltip carry it,
// so the state is never colour alone.
export function switcherBadgeLabel(badge: SwitcherBadge): string {
  if (badge === null) return "";
  const plural = badge.count === 1 ? "workspace" : "workspaces";
  return badge.kind === "awaiting"
    ? `${badge.count} ${plural} awaiting your reply`
    : `Agents working in ${badge.count} ${plural}`;
}

// A menu entry's state text. Running and idle needs no word — the live dot
// says it — so the column only speaks when there is something to say.
export type WorkspaceMenuState = { text: string; tone: "stopped" | "working" | "awaiting" } | null;

export function workspaceMenuState(workspace: HubWorkspaceSummary, activity: WorkspaceActivityMap): WorkspaceMenuState {
  if (!workspace.running) return { text: "stopped", tone: "stopped" };
  const facts = activity.get(workspace.id);
  if (!facts?.running) return null;
  if (facts.awaiting) return { text: "awaiting you", tone: "awaiting" };
  if (facts.working) return { text: "working", tone: "working" };
  return null;
}

// The chip's indicator class for the current workspace. Live only when the
// hub reports the session running: a stopped session's page can outlive its
// server (back/forward-cache restores, a stop from the dashboard), and a
// hard-coded live dot there contradicts both reality and the menu. Unknown
// (absent from the list, e.g. forgotten) reads as not running.
export function chipDotClass(workspaces: HubWorkspaceSummary[], currentId: string | null): string {
  const current = workspaces.find(workspace => workspace.id === currentId);
  return current?.running ? "indicator-dot is-live" : "indicator-dot";
}

export function chipLabel(workspaces: HubWorkspaceSummary[], currentId: string): string {
  const current = workspaces.find(workspace => workspace.id === currentId);
  return current ? workspaceMenuLabel(current) : currentId;
}

// Menu order: the current workspace first, then other running sessions,
// then stopped workspaces, alphabetical within each group.
export function sortHubWorkspaces(
  workspaces: HubWorkspaceSummary[],
  currentId: string | null,
): HubWorkspaceSummary[] {
  const rank = (workspace: HubWorkspaceSummary): number => {
    if (workspace.id === currentId) return 0;
    return workspace.running ? 1 : 2;
  };
  return [...workspaces].sort((a, b) =>
    rank(a) - rank(b)
    || workspaceMenuLabel(a).localeCompare(workspaceMenuLabel(b))
    || a.id.localeCompare(b.id));
}

// Signs out by submitting a real form POST, exactly as the hub dashboard's
// Sign out does, rather than by firing a background request and replacing the
// page. Two reasons: a native wrapper that owns hub credentials (UatuCode
// Desktop keeps them in the Keychain) can observe a navigation but not a
// background fetch, so this is what lets it revoke its own copies; and the
// page is never replaced before the request that clears the cookie has
// actually gone out. Same-origin form posts send Origin, satisfying the hub's
// CSRF check the same way the dashboard's does.
// Whether a failed switcher start is the locked-credential rejection from
// credential-context resolution — normal after a Hub restart, when every
// encrypted assigned credential starts locked. The switcher has no masked
// passphrase surface, so this failure routes to the dashboard's
// credential-aware start flow instead of dead-ending at "start failed".
export function startFailureNeedsHubUnlock(message: string): boolean {
  return /locked|unlock/i.test(message);
}

export function submitHubSignOut(doc: Document): void {
  const form = doc.createElement("form");
  form.method = "post";
  form.action = "/logout";
  form.hidden = true;
  doc.body.appendChild(form);
  form.submit();
}

export type HubStateSummary = {
  workspaces: HubWorkspaceSummary[];
};

export function parseHubState(payload: unknown): HubStateSummary | null {
  const record = payload as { workspaces?: unknown } | null;
  const workspaces = record?.workspaces;
  if (!Array.isArray(workspaces)) {
    return null;
  }
  return {
    workspaces: workspaces
      .filter(
        (entry): entry is { id: string; running: boolean; displayName?: unknown; path?: unknown } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          typeof (entry as { running?: unknown }).running === "boolean",
      )
      .map(entry => ({
        id: entry.id,
        displayName: typeof entry.displayName === "string" && entry.displayName !== "" ? entry.displayName : entry.id,
        path: typeof entry.path === "string" ? entry.path : "",
        running: entry.running,
      })),
  };
}

async function fetchHubState(): Promise<HubStateSummary | null> {
  try {
    const response = await fetch("/api/hub/state");
    if (!response.ok) {
      return null;
    }
    return parseHubState(await response.json());
  } catch {
    return null;
  }
}

export function initHubNav(): void {
  const control = document.querySelector<HTMLDivElement>("#hub-control");
  const toggle = document.querySelector<HTMLButtonElement>("#hub-toggle");
  const menu = document.querySelector<HTMLDivElement>("#hub-menu");
  const label = document.querySelector<HTMLSpanElement>("#hub-current");
  if (!control || !toggle || !menu || !label) {
    return;
  }

  const currentId = workspaceIdFromBasePath(appBasePath());
  if (currentId === null) {
    return;
  }

  let latest: HubWorkspaceSummary[] = [];
  const activity = new Map<string, WorkspaceActivity>();

  const chipDot = toggle.querySelector<HTMLSpanElement>(".indicator-dot");
  const chipBadge = toggle.querySelector<HTMLSpanElement>("#hub-activity-badge");
  const baseToggleLabel = toggle.getAttribute("aria-label") ?? "Switch workspace or open the hub dashboard";
  const updateChip = () => {
    label.textContent = chipLabel(latest, currentId);
    if (chipDot) {
      chipDot.className = chipDotClass(latest, currentId);
    }
    const badge = switcherBadge(latest, activity, currentId);
    const spoken = switcherBadgeLabel(badge);
    if (chipBadge) {
      chipBadge.hidden = badge === null;
      chipBadge.className = `hub-activity-badge${badge ? ` is-${badge.kind}` : ""}`;
      chipBadge.textContent = badge?.kind === "awaiting" ? String(badge.count) : "";
    }
    // The button's own name is what assistive technology reads; the badge
    // is decoration over it.
    toggle.setAttribute("aria-label", spoken ? `${baseToggleLabel}. ${spoken}.` : baseToggleLabel);
    toggle.title = spoken ? `${baseToggleLabel} — ${spoken}` : baseToggleLabel;
  };

  const renderMenu = () => {
    menu.replaceChildren();

    const dashboard = document.createElement("a");
    dashboard.className = "hub-menu-item";
    dashboard.href = "/";
    const dashboardLabel = document.createElement("span");
    dashboardLabel.className = "hub-menu-label";
    dashboardLabel.textContent = "Hub dashboard";
    dashboard.appendChild(dashboardLabel);
    menu.appendChild(dashboard);

    if (latest.length > 0) {
      menu.appendChild(Object.assign(document.createElement("hr"), { className: "hub-menu-divider" }));
    }

    for (const workspace of sortHubWorkspaces(latest, currentId)) {
      const item = document.createElement("a");
      item.className = "hub-menu-item";
      item.href = `/s/${encodeURIComponent(workspace.id)}/`;
      if (workspace.id === currentId) {
        item.setAttribute("aria-current", "true");
      }
      const dot = document.createElement("span");
      dot.className = `indicator-dot${workspace.running ? " is-live" : ""}`;
      dot.setAttribute("aria-hidden", "true");
      item.appendChild(dot);
      const itemLabel = document.createElement("span");
      itemLabel.className = "hub-menu-label";
      itemLabel.textContent = workspaceMenuLabel(workspace);
      item.appendChild(itemLabel);
      const detail = workspaceMenuDetail(latest, workspace);
      if (detail !== null) {
        const detailSpan = document.createElement("span");
        detailSpan.className = "hub-menu-state";
        detailSpan.textContent = detail;
        item.appendChild(detailSpan);
      }
      const menuState = workspaceMenuState(workspace, activity);
      if (menuState !== null) {
        const state = document.createElement("span");
        state.className = `hub-menu-state is-${menuState.tone}`;
        state.textContent = menuState.text;
        item.appendChild(state);
      }
      if (!workspace.running) {
        const state = item.querySelector<HTMLSpanElement>(".hub-menu-state.is-stopped")!;
        // A stopped target's session URL answers 503; Start it instead of
        // navigating into an unavailable page. Only a successful start
        // navigates.
        if (workspace.id !== currentId) {
          item.addEventListener("click", event => {
            event.preventDefault();
            state.textContent = "starting…";
            void fetch(`/api/hub/sessions/${encodeURIComponent(workspace.id)}/start`, { method: "POST" })
              .then(async response => {
                if (response.ok) {
                  window.location.href = item.href;
                  return;
                }
                const body = (await response.json().catch(() => ({}))) as { error?: unknown };
                const message = typeof body.error === "string" ? body.error : "";
                if (startFailureNeedsHubUnlock(message)) {
                  // The switcher has no passphrase surface; the dashboard's
                  // credential-aware start flow collects it.
                  state.textContent = "unlock in Hub…";
                  window.location.href = "/";
                  return;
                }
                state.textContent = "start failed";
              })
              .catch(() => {
                state.textContent = "start failed";
              });
          });
        }
      }
      menu.appendChild(item);
    }

    menu.appendChild(Object.assign(document.createElement("hr"), { className: "hub-menu-divider" }));
    const signOut = document.createElement("a");
    signOut.className = "hub-menu-item";
    signOut.href = "/login";
    const signOutLabel = document.createElement("span");
    signOutLabel.className = "hub-menu-label";
    signOutLabel.textContent = "Sign out";
    signOut.appendChild(signOutLabel);
    signOut.addEventListener("click", event => {
      event.preventDefault();
      submitHubSignOut(document);
    });
    menu.appendChild(signOut);
  };

  const close = () => {
    toggle.setAttribute("aria-expanded", "false");
    menu.hidden = true;
  };

  // Every refresh of the hub list goes through here. The list is the
  // authority on which workspaces exist, so activity for any it no longer
  // names is dropped: the stream never says a workspace was forgotten, and a
  // stream reopened afterwards simply leaves it out of its snapshot. Two
  // races are guarded. An answer issued before one already applied describes
  // an older hub and must not put back what the newer list dropped. And
  // activity reported while a request was out is kept even when its answer
  // does not list the workspace: that answer may predate it.
  let requested = 0;
  let applied = 0;
  let reports = 0;
  const reportedAt = new Map<string, number>();
  const isListed = (ws: string) => latest.some(workspace => workspace.id === ws);
  // Resolves whether the hub answered.
  const refreshHubState = async (): Promise<boolean> => {
    const request = ++requested;
    const reportsBefore = reports;
    const fresh = await fetchHubState();
    if (fresh === null) return false;
    if (request < applied) return true;
    applied = request;
    latest = fresh.workspaces;
    for (const ws of [...activity.keys()]) {
      if (!isListed(ws) && (reportedAt.get(ws) ?? 0) <= reportsBefore) {
        activity.delete(ws);
        reportedAt.delete(ws);
      }
    }
    updateChip();
    if (!menu.hidden) {
      renderMenu();
    }
    return true;
  };

  // Activity named a workspace the list lacks (one registered since the
  // last read): read the list again, and again while an answer still lacks
  // one reported after that request went out. The next answer lists it or,
  // no longer predating the report, prunes it.
  let refreshPending = false;
  const refreshForUnlisted = () => {
    if (refreshPending || [...activity.keys()].every(isListed)) return;
    refreshPending = true;
    void refreshHubState().then(answered => {
      refreshPending = false;
      if (answered) refreshForUnlisted();
    });
  };

  // One probe decides hub-ness; only a hub origin answers this at the root.
  void fetchHubState().then(state => {
    if (state === null) {
      return;
    }
    latest = state.workspaces;
    updateChip();
    control.hidden = false;

    // Live facts from the stream. The channel replays the latest facts per
    // workspace as this registers, so the snapshot the hub sent while the
    // probe was in flight is not lost. A workspace the list does not know
    // (one registered since the probe) triggers a list refresh; the activity
    // is kept meanwhile so the badge is right as soon as the entry exists.
    liveChannel().onActivity((ws, facts) => {
      reports += 1;
      reportedAt.set(ws, reports);
      activity.set(ws, facts);
      latest = applyWorkspaceActivity(latest, ws, facts);
      updateChip();
      if (!menu.hidden) {
        renderMenu();
      }
      refreshForUnlisted();
    });

    // A replacement stream (after the page was hidden and shown again, the
    // connection was lost and regained, or the hub restarted) cannot tell
    // the page what happened to the list while it held none: a workspace
    // forgotten meanwhile is simply absent from its snapshot, and nothing
    // says it went. Re-read the list as each replacement says hello, not
    // when the stream is confirmed live: a stopped current workspace leaves
    // the document topic unavailable, so the stream would never count as
    // live. The page's first stream is skipped, since the probe above read
    // the list. The hub writes hello before any envelope, so the request goes
    // out before the new snapshot is dispatched. Whether its answer lands
    // before or after the snapshot, it drops only activity reported before
    // it was asked (see refreshHubState).
    liveChannel().onStreamOpened(stream => {
      if (stream.replacement) void refreshHubState();
    });

    // A back/forward-cache restore revives this page exactly as it was —
    // possibly for a session that was stopped in the meantime. Re-fetch so
    // the chip tells the truth before the user opens the menu.
    window.addEventListener("pageshow", event => {
      if (!event.persisted) {
        return;
      }
      void refreshHubState();
    });

    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      if (expanded) {
        close();
        return;
      }
      renderMenu();
      toggle.setAttribute("aria-expanded", "true");
      menu.hidden = false;
      // Refresh in the background so the open menu reflects sessions
      // started or stopped elsewhere; re-render only while still open.
      void refreshHubState();
    });

    document.addEventListener("click", event => {
      if (menu.hidden) {
        return;
      }
      if (event.target instanceof Node && !control.contains(event.target)) {
        close();
      }
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !menu.hidden) {
        close();
        toggle.focus();
      }
    });
  });
}
