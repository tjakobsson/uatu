// The Hub's part of the workspace switcher (shell/switcher.ts). When the SPA
// is served through a uatu hub (base path /s/<id>/, hub APIs answering at
// the origin root), this reads the Hub's workspace list and the brokered
// activity, and gives the switcher what it says about them: the status
// card's facts and Start, the badge, the Checkouts rows (two lines each,
// ordered by who needs you, grouped under repository headings when there is
// more than one repository; the current workspace is the status card, not
// a row), `+ New` for the current repository, and the footer's Hub links.
// Everywhere else — the desktop wrapper, the e2e harness — the probe fails
// or the base path is "/", and nothing registers.
//
// The facts are live: the brokered stream's `activity` topic
// (shell/live-channel.ts) says, for every workspace the user may access,
// whether its session is running, whether an agent is working in it,
// whether an interaction awaits the user, and whether work there finished
// since this user last viewed its chat. The collapsed chip and the touch
// button carry a badge while another workspace is waiting on the user, a
// distinct one while work finished unviewed, both distinct from mere agent
// activity; the open switcher names each workspace's state and updates in
// place. Nothing here reveals conversation content or titles — the topic
// carries four booleans and a workspace id. The one write back is the
// viewed acknowledgement: while this page has the chat in view and its own
// workspace reads finished, it tells the hub, which clears the mark for
// this user on every device.
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
import { AttentionNotices, renderAttentionNotices } from "./attention-notice";
import { awaitConfirmedLive, holdManualReload, liveChannel } from "./live";
import { setCurrentSessionRunning } from "./session-running";
import { openWorktreeFork, workspaceIsCheckout } from "./worktree-dialog";
import { closeSwitcher, refreshSwitcher, registerSwitcherHub, type SwitcherHub, type SwitcherHubFacts } from "./switcher";
import { matchesSearch } from "./switcher-model";
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

// A Checkouts row's state word (line 2). Running and idle needs no word — the
// live dot says it — so the row only speaks when there is something to say. The
// running states are exclusive by construction: finished requires neither
// working nor awaiting. Within one workspace the order is awaiting, working,
// finished — unlike the chip's ranking across workspaces — because work
// starting again clears finished: a workspace that is both is working.
export type WorkspaceMenuState = { text: string; tone: "stopped" | "working" | "awaiting" | "finished" } | null;

// `workspaces` is the Hub list the entry belongs to: a missing registration is
// named a checkout or a folder by the same rule the dashboard uses.
export function workspaceMenuState(
  workspace: HubWorkspaceSummary,
  activity: WorkspaceActivityMap,
  workspaces: readonly HubWorkspaceSummary[],
): WorkspaceMenuState {
  if (workspace.availability === "missing") {
    return { text: workspaceIsCheckout(workspace, workspaces) ? "Missing checkout" : "Missing folder", tone: "stopped" };
  }
  if (workspace.availability === "replaced") return { text: "Identity conflict", tone: "stopped" };
  if (!workspace.running) return { text: "Stopped", tone: "stopped" };
  const facts = activity.get(workspace.id);
  if (!facts?.running) return null;
  if (facts.awaiting) return { text: "Awaiting you", tone: "awaiting" };
  if (facts.working) return { text: "Working", tone: "working" };
  if (facts.finished) return { text: "Finished", tone: "finished" };
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

// What a menu entry was rendered as, plus the data its listeners captured:
// two entries with equal signatures behave identically, so the one already
// on screen can stay.
function menuEntrySignature(node: Element, source: unknown): string {
  return `${node.outerHTML}\u0000${JSON.stringify(source ?? null)}`;
}

// What a menu entry stands for, independent of its node and its place in the
// list: a repository header by its main checkout's id, and otherwise what
// `menuFocusKey` says. Dividers have none.
function menuEntryKey(element: Element): string | null {
  const repository = element.getAttribute("data-repository");
  if (repository !== null) return `repository:${repository}`;
  return menuFocusKey(element);
}

// Brings `container`'s children to `next`, keeping every existing child whose
// signature matches the entry built for the same thing. Entries are matched
// by identity (`menuEntryKey`), never by position: a background refresh that
// inserts, removes or regroups a workspace above the row being pressed must
// not replace that row between mousedown and mouseup, or the click is lost.
// Entries without an identity (dividers) are matched by signature, and a
// duplicated identity pairs off in document order. Kept entries already in
// order stay where they are and only the rest are moved, so an insert or a
// removal touches no kept node at all.
// The switcher re-renders on every list answer and activity report while it
// is open, including the refresh its own opening starts; replacing every
// node each time would drop a click, hover, or keyboard focus that landed on
// an entry meanwhile.
export function reconcileMenuEntries(container: Element, next: Element[], signatures: WeakMap<Element, string>): void {
  const matchKey = (node: Element): string | null => {
    const key = menuEntryKey(node);
    if (key !== null) return `key:${key}`;
    const signature = signatures.get(node);
    return signature === undefined ? null : `signature:${signature}`;
  };
  const pool = new Map<string, Element[]>();
  const oldIndex = new Map<Element, number>();
  [...container.children].forEach((child, index) => {
    oldIndex.set(child, index);
    const key = matchKey(child);
    if (key === null) return;
    const bucket = pool.get(key);
    if (bucket) bucket.push(child);
    else pool.set(key, [child]);
  });
  const resolved = next.map(node => {
    const key = matchKey(node);
    const existing = key === null ? undefined : pool.get(key)?.shift();
    if (existing === undefined) return node;
    const signature = signatures.get(node);
    return signature !== undefined && signatures.get(existing) === signature ? existing : node;
  });
  const keep = new Set(resolved);
  for (const child of [...container.children]) {
    if (!keep.has(child)) child.remove();
  }
  // The kept children that may stay put: the longest run of them already in
  // the new relative order (a longest increasing subsequence of their old
  // indices). Everything else is inserted around them.
  const kept = resolved.filter(node => oldIndex.has(node));
  const tails: number[] = [];
  const previous: number[] = [];
  kept.forEach((node, index) => {
    const value = oldIndex.get(node)!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (oldIndex.get(kept[tails[middle]!]!)! < value) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  });
  const stable = new Set<Element>();
  for (let index = tails.length > 0 ? tails[tails.length - 1]! : -1; index >= 0; index = previous[index]!) {
    stable.add(kept[index]!);
  }
  let anchor: Element | null = null;
  for (let index = resolved.length - 1; index >= 0; index -= 1) {
    const node = resolved[index]!;
    if (!stable.has(node)) container.insertBefore(node, anchor);
    anchor = node;
  }
}

// What a focusable menu entry stands for, independent of its node: a
// workspace row by its stable id, a fork control by the stable id of the
// main checkout it forks, the dashboard and sign-out links by their target.
// Never a spoken name: display names may repeat across repositories, so two
// fork controls can both read "Add worktree to docs", and a refresh would
// hand focus (and the next Enter) to the wrong repository's control. A fork
// control and its main checkout's row share an id, so they key apart by kind.
function menuFocusKey(element: Element | null): string | null {
  if (!element) return null;
  const workspaceId = element.getAttribute("data-workspace-id");
  if (workspaceId !== null) return `workspace:${workspaceId}`;
  const forkFor = element.getAttribute("data-fork-for");
  if (forkFor !== null) return `fork:${forkFor}`;
  const label = element.getAttribute("aria-label");
  if (label !== null) return `label:${label}`;
  const href = element.getAttribute("href");
  return href === null ? null : `href:${href}`;
}

// Where a Checkouts row ranks: who needs you first, stopped and unavailable
// last (the order Navigator's board uses).
export function checkoutRank(
  workspace: HubWorkspaceSummary,
  activity: WorkspaceActivityMap,
): number {
  if (workspace.availability) return 6;
  if (!workspace.running) return 5;
  const facts = activity.get(workspace.id);
  if (facts?.running && facts.awaiting) return 0;
  if (facts?.running && facts.working) return 1;
  if (facts?.running && facts.finished) return 2;
  return 3;
}

// The Checkouts list: every workspace but the current one (the status card
// names it), by rank, then by name, then by id.
export function orderCheckouts(
  workspaces: HubWorkspaceSummary[],
  activity: WorkspaceActivityMap,
  currentId: string | null,
): HubWorkspaceSummary[] {
  return workspaces.filter(workspace => workspace.id !== currentId)
    .map(workspace => ({ workspace, rank: checkoutRank(workspace, activity), name: checkoutName(workspaces, workspace) }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.workspace.id.localeCompare(b.workspace.id))
    .map(entry => entry.workspace);
}

// A checkout's own name: the repository for a main checkout (one that owns a
// Git repository or has children), the branch for a worktree, the display
// name for a workspace outside any repository.
export function checkoutName(workspaces: readonly HubWorkspaceSummary[], workspace: HubWorkspaceSummary): string {
  if (workspace.parentId) return checkoutBranchLabel(workspace);
  return workspace.displayName || workspace.id;
}

function isRepositoryMain(workspaces: readonly HubWorkspaceSummary[], workspace: HubWorkspaceSummary): boolean {
  return !workspace.parentId && (workspace.createWorktree === true || workspaces.some(candidate => candidate.parentId === workspace.id));
}

// The repository family a workspace belongs to, by its main checkout's id: a
// child's parent, a main checkout itself. Null outside any repository family.
// Read from the Hub's explicit links, never from names.
export function checkoutRepositoryKey(workspaces: readonly HubWorkspaceSummary[], workspace: HubWorkspaceSummary): string | null {
  if (workspace.parentId) return workspace.parentId;
  return isRepositoryMain(workspaces, workspace) || workspace.repositoryId !== undefined ? workspace.id : null;
}

// The heading of the folders outside any repository family.
export const OTHER_FOLDERS_HEADING = "Other folders";

export type CheckoutGroup = { key: string | null; name: string; workspaces: HubWorkspaceSummary[] };

// The Checkouts list in groups, one per repository (design: "Checkouts by
// repository"). Headings show only when more than one group is present,
// counting the current checkout's own repository even when it has no other
// row: a list that is all another repository's must say so. The current
// repository's group comes first, then the others by name, then the folders
// outside any repository; rows keep `orderCheckouts`' order within a group.
export function groupCheckouts(
  workspaces: HubWorkspaceSummary[],
  activity: WorkspaceActivityMap,
  currentId: string | null,
): { headings: boolean; groups: CheckoutGroup[] } {
  const current = workspaces.find(workspace => workspace.id === currentId);
  const currentKey = current ? checkoutRepositoryKey(workspaces, current) : undefined;
  const byKey = new Map<string | null, HubWorkspaceSummary[]>();
  for (const workspace of orderCheckouts(workspaces, activity, currentId)) {
    const key = checkoutRepositoryKey(workspaces, workspace);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(workspace);
    else byKey.set(key, [workspace]);
  }
  const keys = new Set(byKey.keys());
  if (currentKey !== undefined) keys.add(currentKey);
  const name = (key: string | null) => {
    if (key === null) return OTHER_FOLDERS_HEADING;
    const main = workspaces.find(workspace => workspace.id === key);
    return main ? main.displayName || main.id : key;
  };
  const rank = (key: string | null) => key === currentKey ? 0 : key === null ? 2 : 1;
  const groups = [...byKey].map(([key, members]) => ({ key, name: name(key), workspaces: members }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name) || (a.key ?? "").localeCompare(b.key ?? ""));
  return { headings: keys.size > 1, groups };
}

export type CheckoutRow = {
  // Line 1: the checkout's pull request, or its name.
  pullRequest: { number: number; title: string } | null;
  name: string;
  // Line 2: muted facts; `state` is the one state word, if any.
  facts: string[];
  state: WorkspaceMenuState;
  // The status mark: a live dot, a hollow one, or a spinner while busy.
  mark: "live" | "hollow" | "busy";
};

// What one Checkouts row says (design: "What each row shows"). Its
// repository is its group's heading, never a fact on the row.
export function checkoutRow(
  workspaces: HubWorkspaceSummary[],
  workspace: HubWorkspaceSummary,
  activity: WorkspaceActivityMap,
  options: { pullRequest: { number: number; title: string } | null },
): CheckoutRow {
  const name = checkoutName(workspaces, workspace);
  const facts: string[] = [];
  const branch = workspace.parentId || isRepositoryMain(workspaces, workspace) || workspace.branch ? checkoutBranchLabel(workspace) : null;
  if (branch !== null && (options.pullRequest !== null || branch !== name) && (workspace.branch || workspace.detached || workspace.parentId || isRepositoryMain(workspaces, workspace))) facts.push(branch);
  const detail = workspaceMenuDetail(workspaces, workspace);
  if (detail !== null) facts.push(detail);
  const state = workspaceMenuState(workspace, activity, workspaces);
  const mark = !workspace.running || workspace.availability ? "hollow" : state?.tone === "working" ? "busy" : "live";
  return { pullRequest: options.pullRequest, name, facts, state, mark };
}

export function initHubNav(): void {
  const control = document.querySelector<HTMLDivElement>("#hub-control");
  if (!control) {
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
    dismiss: ws => attention.dismiss(ws),
  });
  const attention = new AttentionNotices(currentId, renderNotices);

  // The main checkout this session belongs to (itself, or its parent).
  const mainCheckout = (): HubWorkspaceSummary | undefined => {
    const current = latest.find(entry => entry.id === currentId);
    return current?.parentId ? latest.find(entry => entry.id === current.parentId) ?? current : current;
  };

  // What a stopped row's start is up to, by workspace id: the rows are
  // re-rendered whenever the list or the stream changes, so a row's own
  // node cannot carry it. Cleared once the workspace runs.
  const rowStart = new Map<string, "starting" | "unlock" | "failed">();
  const rowStartWords = { starting: "Starting…", unlock: "Unlock in Hub…", failed: "Start failed" } as const;
  const menuEntrySignatures = new WeakMap<Element, string>();

  // A start of `workspace` from the switcher: a row, the status card, or Go
  // to its worktree. Only a successful start of ANOTHER workspace navigates:
  // the current one is already on screen, and its page recovers from the
  // stream once the session is back (the connection indicator offers the
  // same start).
  const startAndGo = (workspace: HubWorkspaceSummary) => {
    if (rowStart.get(workspace.id) === "starting") return;
    rowStart.set(workspace.id, "starting");
    refreshSwitcher();
    void startWorkspaceSession(workspace.id).then(outcome => {
      if (outcome.ok) {
        rowStart.delete(workspace.id);
        if (workspace.id !== currentId) hubNavigation(`/s/${encodeURIComponent(workspace.id)}/`);
        refreshSwitcher();
        return;
      }
      rowStart.set(workspace.id, outcome.unlock ? "unlock" : "failed");
      // The row may have been re-rendered meanwhile; say it on whichever
      // node the switcher shows now.
      refreshSwitcher();
    });
  };

  // The Checkouts rows. Built detached and reconciled into the list, so a
  // row whose rendering did not change stays the same node: a click or
  // press on it survives a background refresh.
  const renderCheckouts = (container: HTMLElement, query: string, pullRequestFor: (branch: string) => { number: number; title: string } | null) => {
    const mainId = mainCheckout()?.id ?? null;
    // One row, or null when the search leaves it out. A search matches the
    // row's repository too, so typing a repository's name lists its rows.
    const buildRow = (workspace: HubWorkspaceSummary, repository: string | null): HTMLAnchorElement | null => {
      // A pull request names a checkout of this repository only: another
      // repository's branches are not in this session's list.
      const inRepository = mainId !== null && (workspace.id === mainId || workspace.parentId === mainId);
      const pullRequest = inRepository && workspace.branch && !workspace.detached ? pullRequestFor(workspace.branch) : null;
      const row = checkoutRow(latest, workspace, activity, { pullRequest });
      const pending = rowStart.get(workspace.id);
      if (workspace.running && !workspace.availability) rowStart.delete(workspace.id);
      const state = !workspace.running && !workspace.availability && pending
        ? { text: rowStartWords[pending], tone: "stopped" as const }
        : row.state;
      const line1 = row.pullRequest ? `#${row.pullRequest.number} ${row.pullRequest.title}` : row.name;
      if (!matchesSearch([line1, row.name, workspace.branch, workspace.displayName, workspace.id, ...row.facts, state?.text, repository], query)) return null;

      const item = document.createElement("a");
      item.className = "hub-menu-item switcher-row";
      item.id = `switcher-checkout-${workspace.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.tabIndex = -1;
      item.dataset.workspaceId = workspace.id;
      item.href = `/s/${encodeURIComponent(workspace.id)}/`;
      const mark = document.createElement("span");
      mark.className = row.mark === "busy" ? "indicator-dot switcher-spinner" : `indicator-dot${row.mark === "live" ? " is-live" : " is-hollow"}`;
      mark.setAttribute("aria-hidden", "true");
      item.appendChild(mark);
      const text = document.createElement("span");
      text.className = "switcher-row-text";
      const first = document.createElement("span");
      first.className = "hub-menu-label switcher-row-line1";
      if (row.pullRequest) {
        const number = document.createElement("span");
        number.className = "switcher-row-number";
        number.textContent = `#${row.pullRequest.number}`;
        const title = document.createElement("strong");
        title.textContent = row.pullRequest.title;
        first.append(number, " ", title);
      } else {
        const title = document.createElement("strong");
        title.textContent = row.name;
        first.append(title);
      }
      first.title = line1;
      text.appendChild(first);
      const second = document.createElement("span");
      second.className = "switcher-row-line2";
      const parts: Node[] = [];
      for (const fact of row.facts) {
        const span = document.createElement("span");
        span.className = "switcher-part";
        span.textContent = fact;
        parts.push(span);
      }
      if (state) {
        const span = document.createElement("span");
        span.className = `hub-menu-state switcher-part is-${state.tone}`;
        span.textContent = state.text;
        parts.push(span);
      }
      parts.forEach((part, index) => {
        if (index > 0) {
          const separator = document.createElement("span");
          separator.className = "switcher-sep";
          separator.setAttribute("aria-hidden", "true");
          separator.textContent = "·";
          second.appendChild(separator);
        }
        second.appendChild(part);
      });
      text.appendChild(second);
      item.appendChild(text);
      // Both lines and the state in words, then what Enter does.
      const spokenFirst = row.pullRequest ? `Pull request ${row.pullRequest.number}, ${row.pullRequest.title}` : row.name;
      const spokenState = state?.tone === "working" ? "Agent working" : state?.text;
      const action = workspace.availability ? "Not available" : !workspace.running ? "Start and go to checkout" : "Go to checkout";
      item.setAttribute("aria-label", `${[spokenFirst, ...row.facts, ...(spokenState ? [spokenState] : [])].join(", ")}. ${action}`);

      if (workspace.availability) {
        item.setAttribute("aria-disabled", "true");
        item.title = workspace.availability === "missing"
          ? `${workspaceIsCheckout(workspace, latest) ? "Checkout" : "Folder"} missing. Restore it externally, then reopen the switcher to refresh.`
          : "A different checkout occupies this path. Resolve the identity conflict before opening.";
        item.addEventListener("click", event => event.preventDefault());
      } else if (!workspace.running) {
        // A stopped target's session URL answers 503: Start it, then go.
        item.addEventListener("click", event => {
          event.preventDefault();
          startAndGo(workspace);
        });
      }
      // Listeners read the workspace they were built for, so an entry is only
      // kept while that is unchanged too.
      menuEntrySignatures.set(item, menuEntrySignature(item, workspace));
      return item;
    };
    const { headings, groups } = groupCheckouts(latest, activity, currentId);
    container.classList.toggle("is-grouped", headings);
    if (!headings) {
      // One repository: one flat list, no heading.
      const next = groups.flatMap(group => group.workspaces.map(workspace => buildRow(workspace, group.key === null ? null : group.name)))
        .filter((row): row is HTMLAnchorElement => row !== null);
      reconcileMenuEntries(container, next, menuEntrySignatures);
      return;
    }
    // Several: a group per repository, its heading sticky while its rows
    // scroll. A group is kept as the same node (keyed by its repository) and
    // its rows reconciled inside it, so a press on a row survives a refresh.
    const nextGroups: Element[] = [];
    for (const group of groups) {
      const rows = group.workspaces.map(workspace => buildRow(workspace, group.key === null ? null : group.name)).filter((row): row is HTMLAnchorElement => row !== null);
      if (rows.length === 0) continue;
      const key = group.key ?? "";
      let element = [...container.children].find(child => child.getAttribute("data-repository") === key && child.classList.contains("switcher-repo-group")) as HTMLElement | undefined;
      if (!element) {
        element = document.createElement("div");
        element.className = "switcher-repo-group";
        element.setAttribute("role", "group");
        element.dataset.repository = key;
        const heading = document.createElement("div");
        heading.className = "switcher-repo-heading";
        heading.setAttribute("aria-hidden", "true");
        const rowsElement = document.createElement("div");
        rowsElement.className = "switcher-repo-rows";
        element.append(heading, rowsElement);
        menuEntrySignatures.set(element, `repository:${key}`);
      }
      const heading = element.querySelector<HTMLElement>(".switcher-repo-heading")!;
      if (heading.textContent !== group.name) heading.textContent = group.name;
      if (element.getAttribute("aria-label") !== group.name) element.setAttribute("aria-label", group.name);
      reconcileMenuEntries(element.querySelector(".switcher-repo-rows")!, rows, menuEntrySignatures);
      nextGroups.push(element);
    }
    reconcileMenuEntries(container, nextGroups, menuEntrySignatures);
  };

  // `+ New` in the Checkouts heading: the worktree menu of the current
  // repository's main checkout. Other repositories' forks stay on the Hub
  // dashboard.
  let newControl: HTMLButtonElement | null = null;
  const newButton = (returnFocus: () => HTMLElement): HTMLButtonElement | null => {
    const main = mainCheckout();
    if (!worktreeApi || !main?.createWorktree) return null;
    const name = workspaceMenuLabel(main);
    const label = `New worktree in ${name}`;
    if (newControl && newControl.dataset.forkFor === main.id && newControl.getAttribute("aria-label") === label) return newControl;
    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "hub-menu-fork switcher-new";
    fork.dataset.forkFor = main.id;
    fork.innerHTML = `<span aria-hidden="true">+</span> New`;
    fork.setAttribute("aria-label", label);
    fork.title = label;
    fork.setAttribute("aria-haspopup", "menu");
    fork.setAttribute("aria-expanded", "false");
    fork.addEventListener("click", () => {
      const source = mainCheckout();
      if (!source || !worktreeApi) return;
      // The menu's items open the worktree dialog; the switcher closes
      // first, so the dialog is the one dialog on screen and gives focus
      // back to the control that opened the switcher.
      const opener = returnFocus();
      openWorktreeFork(
        {
          // The published family's base path, straight from Hub state —
          // never a literal, and never relocated under the session's base
          // path, because the Hub API lives outside it. Read when clicked.
          api: worktreeApi,
          source: {
            id: source.id,
            name: workspaceMenuLabel(source),
            ...(source.authentication === undefined ? {} : { authentication: source.authentication }),
            ...(source.signing === undefined ? {} : { signing: source.signing }),
          },
        },
        fork,
        opener,
      );
      document.querySelector('[role="menu"][aria-label="Create worktree"]')?.addEventListener("click", event => {
        if ((event.target as Element).closest('[role="menuitem"]')) closeSwitcher({ restoreFocus: false });
      }, { capture: true });
    });
    newControl = fork;
    return fork;
  };

  const facts = (): SwitcherHubFacts => {
    const current = latest.find(entry => entry.id === currentId);
    const repository = repositoryTitle(latest, currentId);
    const branch = chipBranchLabel(latest, currentId);
    const badge = switcherBadge(latest, activity, currentId);
    return {
      repository,
      name: branch ?? (current ? workspaceMenuLabel(current) : currentId),
      branchLike: branch !== null,
      running: listedRunning,
      dotClass: chipDotClass(latest, currentId),
      badge,
      badgeLabel: switcherBadgeLabel(badge),
      start: rowStart.get(currentId) ?? null,
    };
  };

  const hubPart: SwitcherHub = {
    facts,
    renderCheckouts,
    newControl: newButton,
    startCurrent: () => {
      const current = latest.find(entry => entry.id === currentId);
      if (current) startAndGo(current);
    },
    findCheckout: branch => {
      const main = mainCheckout();
      if (!main) return null;
      const match = latest.find(entry => (entry.id === main.id || entry.parentId === main.id) && entry.branch === branch && !entry.detached);
      if (!match) return null;
      const state = workspaceMenuState(match, activity, latest);
      return { id: match.id, label: checkoutBranchLabel(match), current: match.id === currentId, state: state?.text ?? null, tone: state?.tone ?? null };
    },
    goTo: id => {
      const workspace = latest.find(entry => entry.id === id);
      if (!workspace || workspace.availability) return;
      if (workspace.running) hubNavigation(`/s/${encodeURIComponent(workspace.id)}/`);
      else startAndGo(workspace);
    },
    repositoryName: () => {
      const main = mainCheckout();
      return main ? main.displayName || main.id : "this repository";
    },
    canCreateWorktree: () => Boolean(worktreeApi && mainCheckout()?.createWorktree),
    footerLinks: () => [
      { label: "Hub dashboard", href: "/" },
      { label: "Settings", href: "/settings#personal-chat-preferences-pane" },
    ],
    refresh: () => { void refreshHubState(); },
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
    if (listedRunning === true) rowStart.delete(currentId);
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
    refreshSwitcher();
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
    registerSwitcherHub(hubPart);

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
          rowStart.delete(currentId);
          setCurrentSessionRunning(true);
        } else {
          reconcileStop();
        }
        if (!facts.finished) viewedPosted = false;
        maybeAcknowledgeViewed();
      }
      refreshSwitcher();
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
    // the chip tells the truth before the user opens the switcher.
    window.addEventListener("pageshow", event => {
      if (!event.persisted) {
        return;
      }
      void refreshHubState();
    });
  });
}
