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
// whether its session is running, whether an agent is working in it,
// whether an interaction awaits the user, and whether work there finished
// since this user last viewed its chat. The collapsed chip carries a badge
// while another workspace is waiting on the user, a distinct one while work
// finished unviewed, both distinct from mere agent activity; the open menu
// names each workspace's state and updates in place. Nothing here reveals
// conversation content or titles — the topic carries four booleans and a
// workspace id. The one write back is the viewed acknowledgement: while
// this page has the chat in view and its own workspace reads finished, it
// tells the hub, which clears the mark for this user on every device.
//
// The hub API URLs here are deliberately origin-rooted, NOT appUrl()-based:
// they belong to the hub (outside the session's base path), which is why
// this file is allowlisted in shared/app-url-discipline.test.ts. The viewed
// acknowledgement is the exception: it is a session-path route the hub
// answers itself (`/s/<ws>/api/activity-viewed`), so it goes through
// appUrl() like any other session URL.

import { CHAT_SURFACE_ACTIVE_EVENT, chatSurfaceInView } from "../chat/surface-visibility";
import { appBasePath, appUrl, workspaceIdFromBasePath } from "../shared/app-url";
import type { WorkspaceActivity } from "../shared/live-protocol";
import { AttentionNotices, attentionNoticeHref, renderAttentionNotices } from "./attention-notice";
import { awaitConfirmedLive, holdManualReload, liveChannel } from "./live";
import { setCurrentSessionRunning } from "./session-running";
import { openWorktreeFork, worktreeForkIcon, worktreeProvenanceLabel } from "./worktree-dialog";
import { watchWorktreeInventory, WORKTREES_CHANGED_EVENT } from "./worktree-live";

export type HubWorkspaceSummary = {
  id: string;
  // Mutable human label; the id stays the routing identity. Pre-display-name
  // hubs are tolerated by falling back to the id.
  displayName: string;
  path: string;
  running: boolean;
  parentId?: string;
  repositoryId?: string;
  branch?: string;
  detached?: boolean;
  availability?: "missing" | "replaced";
  readonly sourceRef?: string;
  // Verified provenance of a registered child checkout, as the Hub decided
  // it: never inferred from names or paths here.
  ownership?: "main" | "uatu" | "external" | "uncertain";
  // Present and true on a main checkout that can host linked worktrees.
  createWorktree?: boolean;
  // The workspace's own credential assignments, flattened for display. On a
  // main checkout these ARE the policy its children inherit live, which the
  // worktree dialog discloses at registration.
  authentication?: string;
  signing?: string;
};

export function workspaceMenuLabel(workspace: HubWorkspaceSummary): string {
  return (workspace.parentId && workspace.branch) || workspace.displayName || workspace.id;
}

// Duplicate display names are legal; the menu disambiguates them with the
// workspace path (or stable id when no path is known).
export function workspaceMenuDetail(
  workspaces: HubWorkspaceSummary[],
  workspace: HubWorkspaceSummary,
): string | null {
  const label = workspaceMenuLabel(workspace);
  const duplicates = workspaces.filter(candidate => workspaceMenuLabel(candidate) === label
    && (!workspace.parentId || (candidate.parentId === workspace.parentId && candidate.repositoryId === workspace.repositoryId)));
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
// outranks finished, which outranks working: a question the user has to
// answer is the thing worth a glance; work done that they have not seen is
// worth a look; agents merely busy elsewhere are a quieter note.
export type SwitcherBadge =
  | { kind: "awaiting"; count: number }
  | { kind: "finished"; count: number }
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
  let finished = 0;
  let working = 0;
  for (const workspace of workspaces) {
    if (workspace.id === currentId) continue;
    const facts = activity.get(workspace.id);
    if (!facts?.running) continue;
    if (facts.awaiting) awaiting += 1;
    else if (facts.working) working += 1;
    else if (facts.finished) finished += 1;
  }
  if (awaiting > 0) return { kind: "awaiting", count: awaiting };
  if (finished > 0) return { kind: "finished", count: finished };
  if (working > 0) return { kind: "working", count: working };
  return null;
}

// The badge's spoken form — the chip's accessible name and tooltip carry it,
// so the state is never colour alone.
export function switcherBadgeLabel(badge: SwitcherBadge): string {
  if (badge === null) return "";
  const plural = badge.count === 1 ? "workspace" : "workspaces";
  switch (badge.kind) {
    case "awaiting":
      return `${badge.count} ${plural} awaiting your reply`;
    case "finished":
      return `Work finished in ${badge.count} ${plural}`;
    case "working":
      return `Agents working in ${badge.count} ${plural}`;
  }
}

// A menu entry's state text. Running and idle needs no word — the live dot
// says it — so the column only speaks when there is something to say. The
// running states are exclusive by construction: finished requires neither
// working nor awaiting. Within one workspace the order is awaiting, working,
// finished — unlike the chip's ranking across workspaces — because work
// starting again clears finished: a workspace that is both is working.
export type WorkspaceMenuState = { text: string; tone: "stopped" | "working" | "awaiting" | "finished" } | null;

export function workspaceMenuState(workspace: HubWorkspaceSummary, activity: WorkspaceActivityMap): WorkspaceMenuState {
  if (workspace.availability === "missing") return { text: "Missing checkout", tone: "stopped" };
  if (workspace.availability === "replaced") return { text: "Identity conflict", tone: "stopped" };
  if (!workspace.running) return { text: "stopped", tone: "stopped" };
  const facts = activity.get(workspace.id);
  if (!facts?.running) return null;
  if (facts.awaiting) return { text: "awaiting you", tone: "awaiting" };
  if (facts.working) return { text: "working", tone: "working" };
  if (facts.finished) return { text: "finished", tone: "finished" };
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

// The chip names the checkout in two parts, the same way for EVERY checkout
// in a repository family: the repository (a child's parent, a main
// checkout's own name) and then that checkout's branch — a child reads
// `atlas probe/first-attempt` exactly as its main checkout reads
// `atlas main`. A workspace outside any repository family has no repository
// and no branch to name, so it keeps its display name alone.
export function chipLabel(workspaces: HubWorkspaceSummary[], currentId: string): string {
  const current = workspaces.find(workspace => workspace.id === currentId);
  if (!current) return currentId;
  return repositoryTitle(workspaces, currentId) ?? workspaceMenuLabel(current);
}

export function chipBranchLabel(workspaces: HubWorkspaceSummary[], currentId: string): string | null {
  const current = workspaces.find(workspace => workspace.id === currentId);
  if (!current || repositoryTitle(workspaces, currentId) === null) return null;
  return checkoutBranchLabel(current);
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
  const sorted = [...workspaces].sort((a, b) =>
    rank(a) - rank(b)
    || workspaceMenuLabel(a).localeCompare(workspaceMenuLabel(b))
     || a.id.localeCompare(b.id));
  const children = new Map<string, HubWorkspaceSummary[]>();
  for (const workspace of sorted) {
    if (!workspace.parentId || !workspace.repositoryId) continue;
    const parent = workspaces.find(candidate => candidate.id === workspace.parentId && !candidate.parentId && candidate.repositoryId === workspace.repositoryId);
    if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), workspace]);
  }
  const nested = new Set([...children.values()].flat().map(workspace => workspace.id));
  return sorted.filter(workspace => !nested.has(workspace.id)).flatMap(workspace => [workspace, ...(children.get(workspace.id) ?? [])]);
}

// The repository family the selector groups by, in the order
// sortHubWorkspaces already produced: a main checkout that owns a Git
// repository (the Hub sets createWorktree only for a real `.git` directory)
// with its registered children beneath it. A workspace with no repository
// family — no `.git` directory of its own and no parent — stays a plain row,
// exactly as before.
export type HubMenuEntry =
  | { kind: "repository"; main: HubWorkspaceSummary; children: HubWorkspaceSummary[] }
  | { kind: "plain"; workspace: HubWorkspaceSummary };

export function groupHubWorkspaces(
  workspaces: HubWorkspaceSummary[],
  currentId: string | null,
): HubMenuEntry[] {
  const sorted = sortHubWorkspaces(workspaces, currentId);
  const nested = new Set<string>();
  const entries: HubMenuEntry[] = [];
  for (const workspace of sorted) {
    if (nested.has(workspace.id)) continue;
    const children = workspace.parentId
      ? []
      : sorted.filter(candidate => candidate.parentId === workspace.id && candidate.repositoryId === workspace.repositoryId);
    if (!workspace.parentId && (workspace.createWorktree === true || children.length > 0)) {
      for (const child of children) nested.add(child.id);
      entries.push({ kind: "repository", main: workspace, children });
      continue;
    }
    entries.push({ kind: "plain", workspace });
  }
  return entries;
}

// The repository a workspace belongs to: for a child checkout its parent's
// display name, for a main checkout its own. A workspace outside any
// repository family has none — which is also what tells the chip it has no
// branch to name. This is what the chip's leading half reads.
export function repositoryTitle(
  workspaces: HubWorkspaceSummary[],
  currentId: string | null,
): string | null {
  const current = workspaces.find(workspace => workspace.id === currentId);
  if (!current) return null;
  if (current.parentId) {
    const parent = workspaces.find(candidate => candidate.id === current.parentId);
    return parent ? parent.displayName || parent.id : null;
  }
  return current.createWorktree === true ? current.displayName || current.id : null;
}

// A checkout's current branch, as a label. Detached and unknown are explicit;
// neither is ever guessed to be main.
export function checkoutBranchLabel(workspace: HubWorkspaceSummary): string {
  return workspace.detached ? "Detached HEAD" : workspace.branch || "Branch unknown";
}

// The one muted provenance line a child row carries, in the picker exactly as
// in the dashboard and the register list: the shared rule in
// worktree-dialog.ts, so "External worktree" never reads as "origin unknown".
export function childProvenanceLabel(workspace: HubWorkspaceSummary): string {
  return worktreeProvenanceLabel({
    ...(workspace.ownership === undefined ? {} : { ownership: workspace.ownership }),
    ...(workspace.sourceRef === undefined ? {} : { sourceRef: workspace.sourceRef }),
  });
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

// Whether a click on a link is its ordinary same-tab activation — a plain
// primary click, or a keyboard activation (which dispatches a click with no
// modifiers) — as opposed to a gesture asking the browser to open the link
// elsewhere: a modifier held, or a button other than the primary one.
export function isPlainActivation(event: {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  return (event.button ?? 0) === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
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
  worktreeApi?: string;
};

// The Hub publishes assignment names per role; the dialog shows them as one
// readable value, or omits the field so it reads "none".
function credentialSummary(value: unknown): { authentication?: string; signing?: string } {
  const record = value as { authentication?: unknown; signing?: unknown } | null | undefined;
  const join = (list: unknown) => Array.isArray(list)
    ? list.filter((name): name is string => typeof name === "string" && name !== "").join(", ")
    : "";
  const authentication = join(record?.authentication);
  const signing = join(record?.signing);
  return {
    ...(authentication === "" ? {} : { authentication }),
    ...(signing === "" ? {} : { signing }),
  };
}

export function parseHubState(payload: unknown): HubStateSummary | null {
  const record = payload as { workspaces?: unknown; worktreeApi?: unknown } | null;
  const workspaces = record?.workspaces;
  if (!Array.isArray(workspaces)) {
    return null;
  }
  return {
    ...(typeof record?.worktreeApi === "string" ? { worktreeApi: record.worktreeApi } : {}),
    workspaces: workspaces
      .filter(
        (entry): entry is { id: string; running: boolean; displayName?: unknown; path?: unknown; parentId?: unknown; repositoryId?: unknown; branch?: unknown; detached?: unknown; availability?: unknown; sourceRef?: unknown; ownership?: unknown; createWorktree?: unknown; credentialAssignments?: unknown } =>
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
        ...(typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}),
        ...(typeof entry.repositoryId === "string" ? { repositoryId: entry.repositoryId } : {}),
        ...(typeof entry.branch === "string" ? { branch: entry.branch } : {}),
        ...(typeof entry.sourceRef === "string" && entry.sourceRef !== "" ? { sourceRef: entry.sourceRef } : {}),
        ...(entry.ownership === "main" || entry.ownership === "uatu" || entry.ownership === "external" || entry.ownership === "uncertain"
          ? { ownership: entry.ownership }
          : {}),
        ...(entry.detached === true ? { detached: true } : {}),
        ...(entry.availability === "missing" || entry.availability === "replaced" ? { availability: entry.availability } : {}),
        ...(entry.createWorktree === true ? { createWorktree: true } : {}),
        ...credentialSummary(entry.credentialAssignments),
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
  let worktreeApi: string | undefined;
  const activity = new Map<string, WorkspaceActivity>();
  // What the hub's list last said about the current session, apart from
  // `latest`, which folds the stream's activity in. `Stopped` is asserted
  // from this, never from a fold.
  let listedRunning: boolean | null = null;
  // Activity reports, counted, and the count each workspace was last
  // reported at: what tells a list answer from a report newer than it.
  let reports = 0;
  const reportedAt = new Map<string, number>();
  // Questions raised in other workspaces while this page is open
  // (src/shell/attention-notice.ts). Named as the switcher names them.
  const renderNotices = () => renderAttentionNotices(document, attention.notices(), {
    label: ws => {
      const workspace = latest.find(entry => entry.id === ws);
      return workspace ? workspaceMenuLabel(workspace) : ws;
    },
    open: ws => {
      attention.dismiss(ws);
      hubNavigation(attentionNoticeHref(ws));
    },
    dismiss: ws => attention.dismiss(ws),
  });
  const attention = new AttentionNotices(currentId, renderNotices);

  const chipDot = toggle.querySelector<HTMLSpanElement>(".indicator-dot");
  const chipBadge = toggle.querySelector<HTMLSpanElement>("#hub-activity-badge");
  const baseToggleLabel = toggle.getAttribute("aria-label") ?? "Switch workspace or open the hub dashboard";
  const updateChip = () => {
    label.textContent = chipLabel(latest, currentId);
    // The chip is the only place the repository is named: it says the
    // repository, then this checkout's branch. A child reads the same shape
    // as its main checkout, so one line answers both "which repository" and
    // "which checkout" — a separate title line above would only repeat it.
    const branchText = chipBranchLabel(latest, currentId);
    if (branchText !== null) {
      const branch = document.createElement("span");
      branch.className = "hub-toggle-branch";
      branch.textContent = branchText;
      label.appendChild(branch);
    }
    if (chipDot) {
      chipDot.className = chipDotClass(latest, currentId);
    }
    const badge = switcherBadge(latest, activity, currentId);
    const spoken = switcherBadgeLabel(badge);
    if (chipBadge) {
      chipBadge.hidden = badge === null;
      chipBadge.className = `hub-activity-badge${badge ? ` is-${badge.kind}` : ""}`;
      chipBadge.textContent = badge?.kind === "awaiting" || badge?.kind === "finished" ? String(badge.count) : "";
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
    // Background inventory/activity refresh must not discard keyboard focus or
    // the anchor of an open fork menu.
    if (document.querySelector('[role="menu"][aria-label="Create worktree"]')) return;
    const focusedLabel = menu.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : null;
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

    // The fork control of ONE main checkout, which is what a repository's
    // group header owns: children never have one.
    const forkButton = (workspace: HubWorkspaceSummary): HTMLButtonElement => {
      const fork = document.createElement("button");
      fork.className = "hub-menu-fork";
      // The one shared glyph (F11), never a second spelling of it here.
      fork.innerHTML = worktreeForkIcon;
      fork.setAttribute("aria-label", `Add worktree to ${workspaceMenuLabel(workspace)}`);
      fork.title = `Add worktree to ${workspaceMenuLabel(workspace)}`;
      fork.setAttribute("aria-haspopup", "menu");
      fork.addEventListener("click", () => openWorktreeFork(
        {
          // The published family's base path, straight from Hub state —
          // never a literal, and never relocated under the session's base
          // path, because the Hub API lives outside it.
          api: worktreeApi!,
          source: {
            id: workspace.id,
            name: workspaceMenuLabel(workspace),
            ...(workspace.authentication === undefined ? {} : { authentication: workspace.authentication }),
            ...(workspace.signing === undefined ? {} : { signing: workspace.signing }),
          },
        },
        fork,
        toggle,
      ));
      return fork;
    };

    // One workspace row. `label` lets a repository's own main checkout read
    // as `main checkout` under the group header that already names the
    // repository, instead of repeating that name.
    // A child is NOT indented: the group header above already says which
    // repository these rows belong to, so every row in the menu shares one
    // left edge and the eye reads the header, not a tree.
    const appendWorkspace = (workspace: HubWorkspaceSummary, options: { label?: string } = {}): void => {
      const item = document.createElement("a");
      item.className = "hub-menu-item";
      item.dataset.workspaceId = workspace.id;
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
      itemLabel.textContent = options.label ?? workspaceMenuLabel(workspace);
      if (!workspace.parentId && workspace.createWorktree) {
        const branch = document.createElement("span");
        branch.className = "hub-menu-branch";
        branch.textContent = checkoutBranchLabel(workspace);
        branch.title = `Current checkout: ${branch.textContent}`;
        itemLabel.appendChild(branch);
      }
      if (workspace.parentId) {
        // Ownership first: a tree Uatu did not create says so, instead of
        // claiming an unknown origin for a branch it never created.
        const provenance = document.createElement("span");
        provenance.className = "hub-menu-provenance";
        provenance.textContent = childProvenanceLabel(workspace);
        provenance.title = provenance.textContent;
        itemLabel.appendChild(provenance);
      }
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
      if (workspace.availability) {
        item.setAttribute("aria-disabled", "true");
        item.title = workspace.availability === "missing"
          ? "Checkout missing. Restore it externally, then reopen the picker to refresh."
          : "A different checkout occupies this path. Resolve the identity conflict before opening.";
        item.addEventListener("click", event => event.preventDefault());
      } else if (!stopped) {
        rowStart.delete(workspace.id);
        if (workspace.id === currentId) {
          // Ordinary activation of the workspace already on screen is a
          // no-op: the page, its document URL and its terminal connections
          // stay exactly as they are, and the menu closes as it does on
          // Escape. Matched on the stable id, never the display name — a
          // sibling that shares the name is a different workspace. Modified
          // clicks and middle-click keep the anchor's open-elsewhere
          // behaviour, which is why the anchor and its href are kept.
          item.addEventListener("click", event => {
            if (!isPlainActivation(event)) return;
            event.preventDefault();
            close();
            toggle.focus();
          });
        }
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
    };

    groupHubWorkspaces(latest, currentId).forEach((entry, index) => {
      if (entry.kind === "plain") {
        appendWorkspace(entry.workspace);
        return;
      }
      // A repository: a non-interactive header naming it (and owning its one
      // fork control, at its trailing edge), then its main checkout, then its
      // children — all on the same left edge. Grouping is explicit
      // parent/repository identity from Hub state, never a display-name
      // match. A group that follows anything else is preceded by its own
      // divider, so the eye lands on the repository boundary before the
      // rows; the menu's first entry needs none, because the divider under
      // Hub dashboard is already there.
      if (index > 0) menu.appendChild(Object.assign(document.createElement("hr"), { className: "hub-menu-divider is-group" }));
      const header = document.createElement("div");
      header.className = "hub-menu-group";
      header.dataset.repository = entry.main.id;
      const name = document.createElement("span");
      name.className = "hub-menu-label";
      name.textContent = entry.main.displayName || entry.main.id;
      header.appendChild(name);
      if (worktreeApi && entry.main.createWorktree) header.appendChild(forkButton(entry.main));
      menu.appendChild(header);
      appendWorkspace(entry.main, { label: "main checkout" });
      for (const child of entry.children) appendWorkspace(child);
    });

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
    if (focusedLabel) [...menu.querySelectorAll<HTMLElement>("[aria-label]")].find(item => item.getAttribute("aria-label") === focusedLabel)?.focus();
  };

  // The menu grows with the number of checkouts, and in touch mode it lives
  // inside a fullscreen, `overflow: hidden` Files pane pinned above the tab
  // bar — so a repository or two was enough to push its last rows, Sign out
  // among them, below the visible area with no way to reach them. Bound the
  // open menu to what is actually visible BELOW its own top edge (which
  // depends on the header above it, so it is measured rather than guessed)
  // and let it scroll; the stylesheet owns the scrolling itself, with a
  // viewport-based fallback for the moment before this runs.
  const sizeMenu = () => {
    if (menu.hidden || typeof menu.getBoundingClientRect !== "function") return;
    const top = menu.getBoundingClientRect().top;
    // The pane the menu is clipped by, when there is one: in touch mode the
    // sidebar is fixed above the tab bar, so its bottom is the real limit.
    const pane = control.closest(".sidebar")?.getBoundingClientRect().bottom;
    const viewport = window.innerHeight || 0;
    const bottom = Math.min(viewport || Number.POSITIVE_INFINITY, pane ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(bottom) || !Number.isFinite(top)) return;
    // Never smaller than a few rows: an unreadable sliver would be worse
    // than a scroll.
    menu.style.setProperty("--hub-menu-max-height", `${Math.round(Math.max(160, bottom - top - 16))}px`);
  };

  const close = () => {
    toggle.setAttribute("aria-expanded", "false");
    menu.hidden = true;
  };

  // Tab (and the focus restored after a background re-render) must bring its
  // target into the scrolled menu rather than leave it just out of sight.
  menu.addEventListener("focusin", event => {
    const target = event.target;
    if (target instanceof HTMLElement && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest" });
    }
  });

  // A rotation or a software keyboard changes what is visible under the menu
  // while it is open.
  window.addEventListener("resize", sizeMenu);

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
    worktreeApi = fresh.worktreeApi;
    for (const ws of [...activity.keys()]) {
      if (!isListed(ws) && (reportedAt.get(ws) ?? 0) <= reportsBefore) {
        activity.delete(ws);
        reportedAt.delete(ws);
        attention.forget(ws);
      }
    }
    // A rename reaches the notices' labels too.
    if (attention.notices().length) renderNotices();
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
  window.addEventListener(WORKTREES_CHANGED_EVENT, () => { void refreshHubState(); });
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
    worktreeApi = state.worktreeApi;
    updateChip();
    control.hidden = false;

    // A Hub that serves worktree operations publishes inventory
    // invalidations on the page's existing live stream. The real Hub and the
    // isolated review host are told apart by nothing but this state field:
    // the same picker code runs against both.
    if (worktreeApi) watchWorktreeInventory(liveChannel(), window);

    // The viewed acknowledgement. Posted when this workspace reads finished
    // and the chat is in view — on the activity update that says so, or on
    // the chat surface coming into view while it says so. Once per finished
    // state: the hub's answer to the POST is an update with finished
    // cleared, which re-arms it; a failed POST re-arms it too, so the next
    // cue retries. Never more than one in flight. Only a hub page reaches
    // here, so a page without a hub never posts.
    //
    // A cue that lands while a POST is in flight is not dropped: the hub's
    // clearing update can arrive before the POST's own answer, and a new
    // turn can finish in that gap too, after which nothing else would cue
    // while the user simply keeps looking. So a successful POST checks once
    // more on settling. A failed one does not: it has re-armed for the next
    // cue, and checking at once would turn a hub that keeps refusing into a
    // tight loop of POSTs.
    let viewedPosted = false;
    let viewedInFlight = false;
    const maybeAcknowledgeViewed = () => {
      if (viewedPosted || viewedInFlight) return;
      if (!activity.get(currentId)?.finished) return;
      if (!chatSurfaceInView()) return;
      viewedPosted = true;
      viewedInFlight = true;
      void fetch(appUrl("/api/activity-viewed"), { method: "POST" })
        .then(response => response.ok, () => false)
        .then(ok => {
          viewedInFlight = false;
          if (!ok) {
            viewedPosted = false;
            return;
          }
          maybeAcknowledgeViewed();
        });
    };
    document.addEventListener(CHAT_SURFACE_ACTIVE_EVENT, maybeAcknowledgeViewed);

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
      attention.report(ws, facts);
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
        if (!facts.finished) viewedPosted = false;
        maybeAcknowledgeViewed();
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
      menu.scrollTop = 0;
      sizeMenu();
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
