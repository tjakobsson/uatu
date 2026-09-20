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
import { awaitConfirmedLive, holdManualReload, liveChannel } from "./live";
import { setCurrentSessionRunning } from "./session-running";

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

// Whether the hub's list says the current session runs. Unlisted is
// unknown, not stopped: a forgotten workspace has no session to start, and
// the indicator must not offer one.
export function currentSessionRunning(workspaces: HubWorkspaceSummary[], currentId: string | null): boolean | null {
  const current = workspaces.find(workspace => workspace.id === currentId);
  return current ? current.running : null;
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

// One start, shared by the switcher's rows and the connection indicator.
// Asks the hub to start the workspace's session; the caller decides what
// happens after. A locked-credential refusal is handed to the dashboard's
// credential-aware start flow, which has the passphrase surface this page
// lacks — the navigation happens here so both callers behave alike.
//
// A start of the CURRENT workspace also owns the page's way back to
// `Connected`: the wait for the channel to confirm live is armed before the
// hub is asked (a quick start confirms before the answer lands), and the
// manual recovery's reload fallback is held until that wait settles, so a
// recovery requested meanwhile — from the indicator, from Chat's Reconnect —
// cannot reload the page whose state the in-place start preserves. Both
// live here so every caller gets them. `confirmed` is that wait.
export type WorkspaceStartOutcome =
  | { ok: true; confirmed: Promise<"live" | "timeout" | "cancelled"> }
  | { ok: false; unlock: true }
  | { ok: false; unlock: false; message: string };

// Every navigation the switcher performs goes through here, so a test can
// observe one without a `window.location`.
let hubNavigation = (href: string): void => { window.location.href = href; };

// Test seam: an injected navigation. `null` restores the default.
export function installHubNavigationForTests(navigate: ((href: string) => void) | null): void {
  hubNavigation = navigate ?? (href => { window.location.href = href; });
}

// How long the switcher waits between re-reads of the hub list while the
// stream says the current session is not running but the list still says it
// is (see `reconcileStop` in initHubNav). The first read is immediate.
export const STOP_RECONCILE_DELAYS_MS: readonly number[] = [0, 500, 1_000, 2_000, 4_000, 8_000];

let reconcileDelays: readonly number[] = STOP_RECONCILE_DELAYS_MS;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

// Test seam: a faster schedule, and a way to cancel a pending re-read so
// one test's timer cannot read another test's hub. `null` restores defaults.
export function installStopReconcileForTests(delays: readonly number[] | null): void {
  reconcileDelays = delays ?? STOP_RECONCILE_DELAYS_MS;
  if (reconcileTimer !== null) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }
}

export async function startWorkspaceSession(workspaceId: string): Promise<WorkspaceStartOutcome> {
  const current = workspaceId === workspaceIdFromBasePath(appBasePath());
  const wait = current ? awaitConfirmedLive() : null;
  // The hold lasts exactly as long as the wait, however the request fares:
  // a stalled answer must not keep the page's recovery from reloading once
  // the wait has run out, and a refusal cancels the wait.
  if (wait) {
    const releaseReload = holdManualReload();
    void wait.outcome.finally(releaseReload);
  }
  const refuse = (outcome: Exclude<WorkspaceStartOutcome, { ok: true }>): WorkspaceStartOutcome => {
    wait?.cancel();
    return outcome;
  };
  let response: Response;
  try {
    response = await fetch(`/api/hub/sessions/${encodeURIComponent(workspaceId)}/start`, { method: "POST" });
  } catch {
    return refuse({ ok: false, unlock: false, message: "start failed" });
  }
  if (response.ok) {
    return { ok: true, confirmed: wait ? wait.outcome : Promise.resolve("live" as const) };
  }
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  const message = typeof body.error === "string" && body.error !== "" ? body.error : `start failed (${response.status})`;
  if (startFailureNeedsHubUnlock(message)) {
    hubNavigation("/");
    return refuse({ ok: false, unlock: true });
  }
  return refuse({ ok: false, unlock: false, message });
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
  // What the hub's list last said about the current session, apart from
  // `latest`, which folds the stream's activity in. `Stopped` is asserted
  // from this, never from a fold.
  let listedRunning: boolean | null = null;
  // Activity reports, counted, and the count each workspace was last
  // reported at: what tells a list answer from a report newer than it.
  let reports = 0;
  const reportedAt = new Map<string, number>();

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

  // What a stopped row's start is up to, by workspace id: the menu is
  // re-rendered whenever the list or the stream changes, so a row's own
  // node cannot carry it. Cleared once the workspace runs.
  const rowStart = new Map<string, "starting" | "unlock" | "failed">();
  const rowStartWords = { starting: "starting…", unlock: "unlock in Hub…", failed: "start failed" } as const;

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
      // For the current workspace the word "stopped" and its Start follow
      // the hub's list, as the connection indicator does — the folded
      // value (the dot) also goes dark for an unreachable child of a
      // running session, which a start cannot help.
      const stopped = workspace.id === currentId ? listedRunning === false : !workspace.running;
      const menuState = workspaceMenuState(stopped ? { ...workspace, running: false } : { ...workspace, running: true }, activity);
      if (menuState !== null) {
        const state = document.createElement("span");
        state.className = `hub-menu-state is-${menuState.tone}`;
        state.textContent = menuState.text;
        item.appendChild(state);
      }
      if (!stopped) {
        rowStart.delete(workspace.id);
      } else {
        const state = item.querySelector<HTMLSpanElement>(".hub-menu-state.is-stopped")!;
        const pending = rowStart.get(workspace.id);
        if (pending) state.textContent = rowStartWords[pending];
        // A stopped target's session URL answers 503; Start it instead of
        // navigating into an unavailable page. Only a successful start of
        // ANOTHER workspace navigates: the current one is already on
        // screen, and its page recovers from the stream once the session
        // is back (the connection indicator offers the same start).
        item.addEventListener("click", event => {
          event.preventDefault();
          if (rowStart.get(workspace.id) === "starting") return;
          rowStart.set(workspace.id, "starting");
          state.textContent = rowStartWords.starting;
          void startWorkspaceSession(workspace.id).then(outcome => {
            if (outcome.ok) {
              rowStart.delete(workspace.id);
              if (workspace.id !== currentId) hubNavigation(item.href);
              return;
            }
            rowStart.set(workspace.id, outcome.unlock ? "unlock" : "failed");
            // The row may have been re-rendered meanwhile; say it on
            // whichever node the menu shows now.
            if (!menu.hidden) renderMenu();
          });
        });
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
  let outstanding = 0;
  const isListed = (ws: string) => latest.some(workspace => workspace.id === ws);
  // The list is the authority on whether the current session runs: it is
  // what the shell's `Stopped` state and the manual recovery's no-reload
  // rule are keyed on, so it is published only from the hub's own answer
  // (and from a running report, which is never stale the wrong way).
  // A list answer speaks for the moment it was asked. A running report for
  // the current workspace that arrived after that (`reportsBefore` is the
  // report count when the request went out) is newer than the answer, and
  // the hub only reports running for a session in its table: the answer
  // must not put the fact back to stopped. Boot's probe has no earlier
  // reports to defer to.
  const applyListedRunning = (workspaces: HubWorkspaceSummary[], reportsBefore = -1) => {
    const listed = currentSessionRunning(workspaces, currentId);
    const facts = activity.get(currentId);
    const newerRunning = facts?.running === true && (reportedAt.get(currentId) ?? 0) > reportsBefore;
    listedRunning = listed === false && newerRunning ? true : listed;
    setCurrentSessionRunning(listedRunning);
  };
  // A list answer replaces the folded list, but the stream's word on the
  // current workspace can outlive it: that the child is gone (the list says
  // running for as long as a stop is in progress, and the chip must not
  // blink live meanwhile), or that the session runs again, reported after
  // the answer was asked for.
  const foldCurrent = (workspaces: HubWorkspaceSummary[], reportsBefore: number): HubWorkspaceSummary[] => {
    const facts = activity.get(currentId);
    if (!facts) return workspaces;
    const keep = !facts.running || (reportedAt.get(currentId) ?? 0) > reportsBefore;
    return keep ? applyWorkspaceActivity(workspaces, currentId, facts) : workspaces;
  };
  // Resolves whether the hub answered.
  const refreshHubState = async (): Promise<boolean> => {
    const request = ++requested;
    const reportsBefore = reports;
    outstanding += 1;
    const fresh = await fetchHubState().finally(() => { outstanding -= 1; });
    if (fresh === null) {
      resumeReconcile();
      return false;
    }
    if (request < applied) {
      resumeReconcile();
      return true;
    }
    applied = request;
    latest = foldCurrent(fresh.workspaces, reportsBefore);
    for (const ws of [...activity.keys()]) {
      if (!isListed(ws) && (reportedAt.get(ws) ?? 0) <= reportsBefore) {
        activity.delete(ws);
        reportedAt.delete(ws);
      }
    }
    applyListedRunning(fresh.workspaces, reportsBefore);
    updateChip();
    if (!menu.hidden) {
      renderMenu();
    }
    resumeReconcile();
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

  // The stream said the current workspace is not running. That is also what
  // it says for a running session whose child is momentarily unreachable,
  // so `Stopped` is asserted only from the list — and the list lags a stop:
  // the child is gone (and the stream says so) before the hub's session
  // table records the stop, so a read in that window still says running,
  // and the table's later change repeats a value the stream already sent.
  // While the two disagree the list is re-read on a short backoff, until it
  // says stopped, the stream says running again, or the schedule runs out
  // (an unreachable child of a running session: `Reconnecting` is right,
  // and the next reconnect, menu open, or page-cache restore reads again).
  // An answer already on its way counts as a read.
  let reconcileAttempt = 0;
  // Set while the reconcile is waiting for a read it did not issue; that
  // read's settling resumes it, whatever it answered.
  let reconcileWaiting = false;
  const disagree = () => activity.get(currentId)?.running === false && listedRunning === true;
  const reconcileStop = () => {
    if (reconcileTimer !== null || reconcileWaiting) return;
    if (!disagree()) {
      reconcileAttempt = 0;
      return;
    }
    const delay = reconcileDelays[reconcileAttempt];
    if (delay === undefined) {
      reconcileAttempt = 0;
      return;
    }
    reconcileAttempt += 1;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      if (!disagree()) {
        reconcileAttempt = 0;
        return;
      }
      if (outstanding > 0) {
        // A read is on its way: its answer counts as this attempt's. The
        // slot is given back so a slow answer does not use up the schedule.
        reconcileAttempt -= 1;
        reconcileWaiting = true;
        return;
      }
      void refreshHubState().then(reconcileStop);
    }, delay);
  };
  const resumeReconcile = () => {
    if (!reconcileWaiting) return;
    reconcileWaiting = false;
    reconcileStop();
  };

  // One probe decides hub-ness; only a hub origin answers this at the root.
  void fetchHubState().then(state => {
    if (state === null) {
      return;
    }
    latest = state.workspaces;
    applyListedRunning(state.workspaces);
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
      // Before the chip and menu render: the current row reads the fact.
      if (ws === currentId) {
        // A running report is the hub's own: the feed only says so for a
        // session in its table.
        if (facts.running) {
          listedRunning = true;
          setCurrentSessionRunning(true);
        } else {
          reconcileStop();
        }
      }
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
