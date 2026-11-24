// The workspace switcher: one place that says which checkout this page works
// in (its files, terminal and agent) and what Files and Preview are viewing
// (a pull request that is not checked out, when there is one), and the way
// to move: to another checkout, or to a pull request. Design:
// pr-mockups/switcher/design.md; spec: workspace-switcher.
//
// Its faces: on touch, a fifth control in the bottom bar (outside the
// tablist: it opens a dialog and is never a tab); on desktop, the sidebar
// header's chip, whose second line says `Viewing #n · ← Back` while viewing.
// Both open one dialog (`#hub-menu`, a full-height sheet on touch, a panel
// under the chip on desktop): a status card (Working in, and Viewing with
// Back), one search over both lists, Checkouts (rendered by the Hub's part,
// shell/hub-nav.ts, which owns the Hub's list and live activity, grouped
// under repository headings when there is more than one), Pull requests (the
// repository's open pull requests, named in the heading, a selector when the
// workspace has more than one Git repository; a filter menu, the first three
// and "Show all n"), and a footer with the Hub's dashboard and Settings.
// Sign out is not here: it lives on the Hub's own pages.
//
// Choosing a pull request that is not checked out asks first: View here
// (show it in Files and Preview, nothing fetched or checked out) or Check
// out as a worktree…. With the Hub's worktree service, Create worktree
// really creates it (shell/pull-request-checkout.ts): you stay where you
// are, the new checkout is listed under Checkouts as `Creating…` (a failure
// stays there as `Couldn't create · Retry`), the pull request's row reads
// `Checking out…`, and a notice offers Go to once it is ready. Without that
// service, mocked GitHub data still gets the labelled simulation. One
// already checked out offers Go to its worktree first. "Viewing" also gets
// one strip at the top of Files and Preview on touch (and in the preview on
// desktop while the sidebar is collapsed), with ← Back to <branch>.
//
// The dialog is a body-level `role="dialog"` element rather than a modal
// <dialog>: a top-layer modal would make the worktree fork menu (a fixed
// menu appended to <body>) inert. Its focus stays inside by Tab wrapping;
// Escape steps back from a choice and then closes, returning focus to the
// control that opened it.
//
// Navigation in the preview is the Pull request pane's job (this module
// must not import shell/url.ts: hub-nav.ts, loaded early, imports this), so
// View here and Back are events the pane answers.

import { connectGithubHtml } from "../github/connect";
import { githubApi, GithubRequestError } from "../github/client";
import { errorMessage, pullRequestStore } from "../github/pull-request-store";
import { clockTime } from "../github/present";
import { pullRequestLocalBranch, type PullRequestList, type PullRequestListItem, type PullRequestSummary } from "../shared/github-contract";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import {
  filterPullRequests,
  LOOKUP_DELAY_MS,
  lookupText,
  middleTruncate,
  nextListSelection,
  otherRepositoryName,
  PULL_REQUEST_FILTERS,
  PULL_REQUESTS_FOLDED,
  pullRequestCheckout,
  pullRequestLine2,
  pullRequestMatches,
  pullRequestQueryTarget,
  pullRequestRowName,
  shouldLookUp,
  sortPullRequests,
  matchesSearch,
  switcherSpokenName,
  type LinePart,
  type Lookup,
  type PullRequestFilter,
} from "./switcher-model";
import { checkOutPullRequest } from "./pull-request-checkout";

// Asks the page to show a pull request here (View here). The Pull request
// pane, loaded from app.ts, performs the navigation.
export const OPEN_PULL_REQUEST_EVENT = "uatu:open-pull-request";
export type OpenPullRequestDetail = { repositoryId: string; number: number };

// Asks the page to stop viewing: Files and Preview show the checkout again.
// `focus` says where focus lands afterwards.
export const SHOW_BRANCH_EVENT = "uatu:show-branch";
export type ShowBranchDetail = { focus: "tree" | "heading" | "none" };

export const BRANCH_GLYPH = `<svg class="switcher-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-3.2 2.4-6.2 4"/></svg>`;
export const EYE_GLYPH = `<svg class="switcher-eye" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>`;

// What the Hub's part (hub-nav.ts) contributes. Outside a Hub there is none:
// the switcher then holds only the status card and Pull requests.
export type SwitcherCheckout = { id: string; label: string; current: boolean; state: string | null; tone: string | null };
export type SwitcherHubFacts = {
  // The repository's name (status card: `uatu · feat/view-pr`), null outside
  // a repository family.
  repository: string | null;
  // The checkout's name: its branch, or a plain workspace's display name.
  name: string;
  branchLike: boolean;
  // What the Hub's list says about the current session; null when unknown.
  running: boolean | null;
  dotClass: string;
  badge: { kind: "awaiting" | "finished" | "working"; count: number } | null;
  badgeLabel: string;
  start: "starting" | "unlock" | "failed" | null;
};
export type SwitcherHub = {
  facts(): SwitcherHubFacts;
  // Renders the Checkouts rows (role="option") into `list`, filtered by the
  // search. `pullRequestFor` names a branch's pull request, for line 1.
  renderCheckouts(list: HTMLElement, query: string, pullRequestFor: (branch: string) => { number: number; title: string } | null): void;
  // `+ New` for the current repository, or null.
  newControl(returnFocus: () => HTMLElement): HTMLButtonElement | null;
  startCurrent(): void;
  // The checkout that has `branch`, if any.
  findCheckout(branch: string): SwitcherCheckout | null;
  goTo(id: string): void;
  // The main checkout's name, for a new worktree's folder.
  repositoryName(): string;
  canCreateWorktree(): boolean;
  // The Hub's worktree family and the main checkout to create from, when
  // the Hub serves worktree operations; absent or null, checking a pull
  // request out is only simulated.
  worktreeSource?(): { api: string; sourceId: string } | null;
  footerLinks(): { label: string; href: string }[];
  refresh(): void;
};

let hub: SwitcherHub | null = null;
let root: Document | null = null;
let disposeStore: (() => void) | null = null;

// The Hub's part registers once it knows the page is Hub-served.
export function registerSwitcherHub(next: SwitcherHub): void {
  initSwitcher();
  hub = next;
  refreshSwitcher();
}

// Test seam: forget the Hub and the document.
export function resetSwitcherForTests(): void {
  hub = null;
  root = null;
  disposeStore?.();
  disposeStore = null;
}

const touchMode = () => document.documentElement.dataset.uiMode === "touch";

type Step =
  | { kind: "choice"; pr: ChosenPullRequest }
  | { kind: "confirm"; pr: ChosenPullRequest }
  | { kind: "done"; pr: ChosenPullRequest };
type ChosenPullRequest = Pick<PullRequestListItem, "number" | "title" | "headRefName" | "headOwner" | "isCrossRepository">;
// A pull request being checked out as a worktree, until the Hub's list has
// it. A failure stays here, with its reason, until retried.
type Creation = { pr: ChosenPullRequest; branch: string; status: "creating" | "failed"; message?: string };
// The notice that a created worktree is ready (the design's "Go to").
type ReadyNotice = { branch: string; workspaceId: string; differs: boolean };

// The dialog's state while open, and what it keeps between openings (the
// list, the filter).
const state = {
  open: false,
  opener: null as HTMLElement | null,
  query: "",
  settledQuery: "",
  settleTimer: null as ReturnType<typeof setTimeout> | null,
  active: null as string | null,
  expanded: false,
  filter: "open" as PullRequestFilter,
  // The heading's open menu: the filter, or the repository selector.
  menu: null as "filter" | "repository" | null,
  list: null as PullRequestList | null,
  // The repository the list (or its error) is for: a list of another than
  // the store's current one is not shown.
  listRepositoryId: null as string | null,
  listError: null as string | null,
  listNoCredential: false,
  loadingFor: null as string | null,
  lookups: new Map<number, Lookup>(),
  step: null as Step | null,
  // Opened at Pull requests: kept in view until its list has arrived, since
  // the rows that arrive later are what lets the lists scroll that far.
  revealPullRequests: false,
  // Checkouts being created from pull requests, by number. Closing the
  // dialog cancels nothing.
  creations: new Map<number, Creation>(),
  ready: null as ReadyNotice | null,
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);

export function initSwitcher(): void {
  if (root === document) return;
  // A new document (tests mount one each): nothing carries over.
  root = document;
  hub = null;
  Object.assign(state, { open: false, opener: null, query: "", settledQuery: "", active: null, expanded: false, filter: "open", menu: null, list: null, listRepositoryId: null, listError: null, listNoCredential: false, loadingFor: null, step: null, ready: null });
  state.lookups.clear();
  state.creations.clear();
  disposeStore?.();
  disposeStore = pullRequestStore.subscribe(() => {
    if (root !== document) return;
    refreshSwitcher();
  });
  // The URL's own pick and the store's first answer arrive later; the
  // chrome follows the store from here.
  const toggle = $<HTMLButtonElement>("#hub-toggle");
  const button = $<HTMLButtonElement>("#switcher-button");
  const panel = $<HTMLElement>("#hub-menu");
  toggle?.addEventListener("click", () => toggleSwitcher(toggle));
  button?.addEventListener("click", () => toggleSwitcher(button));
  for (const back of document.querySelectorAll<HTMLElement>("#switcher-chip-viewing, #viewing-strip-files, #viewing-strip-preview")) {
    back.addEventListener("click", event => {
      if (!(event.target as HTMLElement).closest("[data-switcher-back]")) return;
      const focus: ShowBranchDetail["focus"] = back.id === "viewing-strip-files" ? "tree" : back.id === "switcher-chip-viewing" ? "none" : "heading";
      showBranch(focus);
      if (back.id === "switcher-chip-viewing") requestAnimationFrame(() => toggle?.focus());
    });
  }
  $<HTMLElement>("#switcher-backdrop")?.addEventListener("click", () => closeSwitcher());
  if (!panel) return;
  wirePanel(panel);
  // Capture: a surface behind the dialog (the terminal) must not swallow
  // Escape or Tab while the dialog is open.
  document.addEventListener("keydown", onDocumentKeydown, true);
  // The dialog is modal: focus that a surface behind it takes (a terminal
  // attaching on its tab) comes back to it. The worktree menu and dialogs
  // opened from + New are its own.
  document.addEventListener("focusin", event => {
    if (!state.open) return;
    const target = event.target as Element | null;
    if (!target || panel.contains(target) || target.closest?.('[role="menu"][aria-label="Create worktree"], dialog')) return;
    if (target === toggle || target === button) return;
    panel.focus({ preventScroll: true });
  });
  document.addEventListener("click", event => {
    if (!state.open) return;
    const target = event.target;
    // A control the click itself re-rendered away was inside.
    if (!(target instanceof Node) || !target.isConnected || panel.contains(target)) return;
    // The click that opened it (the chip, the button, the Pull request
    // pane's search) is still bubbling.
    if (toggle?.contains(target) || button?.contains(target) || state.opener?.contains(target)) return;
    // The worktree fork menu opened from + New sits outside the panel.
    if ((target as Element).closest?.('[role="menu"][aria-label="Create worktree"], dialog')) return;
    closeSwitcher({ restoreFocus: false });
  });
  window.addEventListener("resize", () => { if (state.open) positionPanel(); });
  refreshSwitcher();
}

function toggleSwitcher(opener: HTMLElement): void {
  if (state.open) closeSwitcher();
  else openSwitcher({ opener });
}

// Whether the switcher is offered at all: in a Hub, or with GitHub data.
function offered(): boolean {
  return hub !== null || pullRequestStore.state.enabled === true;
}

function currentFacts(): SwitcherHubFacts {
  if (hub) return hub.facts();
  const branch = pullRequestStore.state.branch;
  const repository = pullRequestStore.state.summary?.repository?.name ?? null;
  return {
    repository,
    name: branch ?? "Branch unknown",
    branchLike: true,
    running: null,
    dotClass: "indicator-dot",
    badge: null,
    badgeLabel: "",
    start: null,
  };
}

function viewingNumber(): number | null {
  return pullRequestStore.scopedNumber();
}

// The checked-out branch, as Back names it.
function branchName(): string {
  return pullRequestStore.state.branch ?? currentFacts().name;
}

// --- The chrome: chip, button, strips -----------------------------------------

// Re-renders everything the switcher shows: called on every Hub list or
// activity change (hub-nav.ts) and every pull request store change.
export function refreshSwitcher(): void {
  if (root !== document) return;
  renderChrome();
  if (state.open) renderPanel();
}

function renderChrome(): void {
  const facts = currentFacts();
  const viewing = viewingNumber();
  const show = offered();
  const spoken = switcherSpokenName({ repository: facts.repository, name: facts.name, viewing, badge: facts.badgeLabel, stopped: facts.running === false });
  const back = `Back to ${branchName()}`;
  document.documentElement.toggleAttribute("data-switcher", show);
  document.documentElement.toggleAttribute("data-viewing-pr", show && viewing !== null);

  const control = $<HTMLElement>("#hub-control");
  const toggle = $<HTMLButtonElement>("#hub-toggle");
  if (control && toggle) {
    control.hidden = !show;
    const label = $<HTMLElement>("#hub-current");
    if (label) {
      if (facts.branchLike) {
        const span = label.querySelector(".hub-toggle-branch") ?? document.createElement("span");
        span.className = "hub-toggle-branch";
        span.textContent = facts.name;
        if (label.firstChild !== span || label.childNodes.length !== 1) label.replaceChildren(span);
      } else if (label.textContent !== facts.name || label.children.length) label.textContent = facts.name;
    }
    const dot = toggle.querySelector<HTMLElement>(".indicator-dot");
    if (dot) dot.className = facts.dotClass;
    toggle.toggleAttribute("data-stopped", facts.running === false);
    toggle.toggleAttribute("data-no-hub", hub === null);
    paintBadge(toggle.querySelector<HTMLElement>("#hub-activity-badge"), facts.badge);
    toggle.setAttribute("aria-label", spoken);
    toggle.title = spoken;
    const chipViewing = $<HTMLElement>("#switcher-chip-viewing");
    if (chipViewing) paintViewing(chipViewing, viewing, back, "← Back");
  }

  const button = $<HTMLButtonElement>("#switcher-button");
  if (button) {
    button.hidden = !show;
    const name = button.querySelector<HTMLElement>(".touch-switcher-name");
    if (name) {
      name.textContent = middleTruncate(facts.name, 18);
      name.title = facts.name;
    }
    const pill = button.querySelector<HTMLElement>(".switcher-eye-pill");
    if (pill) {
      pill.hidden = viewing === null;
      const text = pill.querySelector<HTMLElement>(".switcher-eye-pill-number");
      if (text) text.textContent = viewing === null ? "" : `#${viewing}`;
    }
    paintBadge(button.querySelector<HTMLElement>(".hub-activity-badge"), facts.badge);
    button.toggleAttribute("data-stopped", facts.running === false);
    button.setAttribute("aria-label", spoken);
  }

  for (const strip of document.querySelectorAll<HTMLElement>("#viewing-strip-files, #viewing-strip-preview")) {
    paintViewing(strip, show ? viewing : null, back, `← ${back}`);
  }
}

function paintBadge(badge: HTMLElement | null, value: SwitcherHubFacts["badge"]): void {
  if (!badge) return;
  badge.hidden = value === null;
  const className = `hub-activity-badge${value ? ` is-${value.kind}` : ""}`;
  if (badge.className !== className) badge.className = className;
  badge.textContent = value?.kind === "awaiting" || value?.kind === "finished" ? String(value.count) : "";
}

// The Viewing line: the chip's second line and the strips. Kept as the same
// nodes while unchanged, so a focused Back stays focused.
function paintViewing(element: HTMLElement, viewing: number | null, backName: string, backText: string): void {
  element.hidden = viewing === null;
  if (viewing === null) return;
  const html = `<span class="viewing-label">${EYE_GLYPH}<span>Viewing <strong>#${viewing}</strong></span></span><button type="button" class="gh-link-button viewing-back" data-switcher-back aria-label="${escapeHtmlAttribute(backName)}" title="Files and Preview show the checkout again; nothing on disk changes">${escapeHtml(backText)}</button>`;
  if (element.dataset.html === html) return;
  element.dataset.html = html;
  element.innerHTML = html;
}

// Back: Files and Preview show the checkout again.
function showBranch(focus: ShowBranchDetail["focus"]): void {
  document.dispatchEvent(new CustomEvent<ShowBranchDetail>(SHOW_BRANCH_EVENT, { detail: { focus } }));
  announce(`Back on ${branchName()}.`);
}

function announce(text: string): void {
  const live = $<HTMLElement>("#switcher-live");
  if (!live) return;
  live.textContent = "";
  // A new node each time: the same words twice are still read.
  requestAnimationFrame(() => { live.textContent = text; });
}

// --- Opening and closing --------------------------------------------------------

export function openSwitcher(options: { opener?: HTMLElement; section?: "pull-requests" } = {}): void {
  initSwitcher();
  const panel = $<HTMLElement>("#hub-menu");
  if (!panel || !offered()) return;
  const opener = options.opener ?? (touchMode() ? $<HTMLElement>("#switcher-button") : $<HTMLElement>("#hub-toggle"));
  state.opener = opener ?? null;
  state.query = "";
  state.settledQuery = "";
  state.active = null;
  state.expanded = false;
  state.step = null;
  state.menu = null;
  state.lookups.clear();
  const search = panel.querySelector<HTMLInputElement>("#switcher-search");
  if (search) search.value = "";
  state.open = true;
  panel.hidden = false;
  const backdrop = $<HTMLElement>("#switcher-backdrop");
  if (backdrop) backdrop.hidden = false;
  for (const control of document.querySelectorAll("#hub-toggle, #switcher-button")) control.setAttribute("aria-expanded", "true");
  positionPanel();
  renderPanel();
  const scroller = panel.querySelector<HTMLElement>(".switcher-scroll");
  if (scroller) scroller.scrollTop = 0;
  // Refresh in the background so the open dialog reflects sessions started
  // or stopped elsewhere, and the pull requests GitHub has now.
  hub?.refresh();
  void loadList(false);
  state.revealPullRequests = options.section === "pull-requests";
  revealPullRequests(panel);
  // On touch the search is not focused: the keyboard would cover the
  // lists. The dialog itself takes focus there.
  if (touchMode() || !search) panel.focus({ preventScroll: true });
  else search.focus({ preventScroll: true });
}

export function closeSwitcher(options: { restoreFocus?: boolean } = {}): void {
  const panel = $<HTMLElement>("#hub-menu");
  if (!panel || !state.open) return;
  state.open = false;
  state.revealPullRequests = false;
  state.step = null;
  state.menu = null;
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = null;
  panel.hidden = true;
  panel.removeAttribute("data-step");
  const backdrop = $<HTMLElement>("#switcher-backdrop");
  if (backdrop) backdrop.hidden = true;
  for (const control of document.querySelectorAll("#hub-toggle, #switcher-button")) control.setAttribute("aria-expanded", "false");
  if (options.restoreFocus !== false) {
    const opener = state.opener;
    const fallback = touchMode() ? $<HTMLElement>("#switcher-button") : $<HTMLElement>("#hub-toggle");
    for (const candidate of new Set([opener, fallback])) {
      if (!candidate?.isConnected) continue;
      candidate.focus({ preventScroll: true });
      if (document.activeElement === candidate) break;
    }
  }
}

export function switcherOpen(): boolean {
  return state.open;
}

// Desktop: a panel under the chip (or the control that opened it).
function positionPanel(): void {
  const panel = $<HTMLElement>("#hub-menu");
  if (!panel) return;
  if (touchMode()) {
    panel.style.removeProperty("--switcher-top");
    panel.style.removeProperty("--switcher-left");
    return;
  }
  const anchor = $<HTMLElement>("#hub-control");
  const rect = anchor && !anchor.hidden && typeof anchor.getBoundingClientRect === "function"
    ? anchor.querySelector<HTMLElement>(".switcher-chip")?.getBoundingClientRect() ?? anchor.getBoundingClientRect()
    : state.opener?.getBoundingClientRect?.();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;
  panel.style.setProperty("--switcher-top", `${Math.round(rect.bottom + 6)}px`);
  panel.style.setProperty("--switcher-left", `${Math.round(Math.max(8, rect.left))}px`);
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (!state.open) return;
  const panel = $<HTMLElement>("#hub-menu");
  if (!panel) return;
  if (event.key === "Escape") {
    // A modal dialog above (the worktree dialog) owns its own Escape.
    // So does the worktree menu opened from + New.
    if ((document.activeElement as Element | null)?.closest?.('dialog[open], [role="menu"][aria-label="Create worktree"]')) return;
    if (state.menu) {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    event.preventDefault();
    if (state.step) stepBack();
    else closeSwitcher();
    return;
  }
  if (event.key === "Tab" && panel.contains(document.activeElement)) {
    const focusables = [...panel.querySelectorAll<HTMLElement>("button, a[href]:not([tabindex='-1']), input, summary, [tabindex='0']")]
      .filter(element => !element.closest("[hidden]") && !(element as HTMLButtonElement).disabled && element.getClientRects?.().length !== 0);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

// --- The dialog ---------------------------------------------------------------

function wirePanel(panel: HTMLElement): void {
  panel.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-switcher-close]")) { closeSwitcher(); return; }
    if (target.closest("[data-switcher-step-back]")) { stepBack(); return; }
    if (target.closest("[data-switcher-status-back]")) {
      closeSwitcher();
      showBranch("none");
      return;
    }
    if (target.closest("[data-switcher-start]")) { hub?.startCurrent(); return; }
    if (target.closest("[data-switcher-show-all]")) {
      state.expanded = true;
      renderPanel();
      // The button is gone; focus goes where the lists are driven from.
      const search = $<HTMLInputElement>("#switcher-search");
      if (touchMode() || !search) panel.focus({ preventScroll: true });
      else search.focus({ preventScroll: true });
      return;
    }
    if (target.closest("[data-switcher-retry]")) {
      state.lookups.clear();
      void pullRequestStore.retry();
      void loadList(true);
      return;
    }
    const menuToggle = target.closest<HTMLElement>("[data-switcher-menu-toggle]");
    if (menuToggle) {
      const which = menuToggle.dataset.switcherMenuToggle as "filter" | "repository";
      if (state.menu === which) closeMenu(false);
      else openMenu(which);
      return;
    }
    const filterItem = target.closest<HTMLElement>("[data-switcher-filter]");
    if (filterItem) {
      state.filter = filterItem.dataset.switcherFilter as PullRequestFilter;
      state.expanded = false;
      closeMenu(true);
      renderPanel();
      return;
    }
    const repositoryItem = target.closest<HTMLElement>("[data-switcher-repository]");
    if (repositoryItem) {
      chooseRepository(repositoryItem.dataset.switcherRepository!);
      return;
    }
    const retry = target.closest<HTMLElement>("[data-creating-retry]");
    if (retry) {
      const creation = state.creations.get(Number(retry.dataset.creatingRetry));
      if (creation) startCreation(creation.pr);
      return;
    }
    const failed = target.closest<HTMLElement>("[data-creating-open]");
    if (failed) {
      const creation = state.creations.get(Number(failed.dataset.creatingOpen));
      if (creation) openChoice(creation.pr);
      return;
    }
    const row = target.closest<HTMLElement>("[data-pr-row]");
    if (row) { choosePullRequest(Number(row.dataset.prRow)); return; }
    const choice = target.closest<HTMLElement>("[data-choice]")?.dataset.choice;
    if (choice) runChoice(choice);
  });
  const search = panel.querySelector<HTMLInputElement>("#switcher-search");
  search?.addEventListener("input", () => {
    state.query = search.value;
    if (state.settleTimer) clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(() => {
      state.settleTimer = null;
      if (!state.open || state.settledQuery === state.query) return;
      state.settledQuery = state.query;
      renderPanel();
    }, LOOKUP_DELAY_MS);
    // A number or URL naming an open pull request makes its row active.
    const named = pullRequestQueryTarget(state.query);
    const list = currentList();
    if (named && list && !otherRepositoryName(named, list.repository) && list.pullRequests.some(item => item.number === named.number)) {
      state.active = `switcher-pr-${named.number}`;
    }
    renderPanel();
  });
  search?.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    const options = visibleOptions();
    if (event.key === "Enter") {
      event.preventDefault();
      const active = options.find(option => option.id === state.active);
      if (active) { active.click(); return; }
      const found = foundLookup();
      if (found) { choosePullRequest(found.number); return; }
      if (state.settledQuery !== state.query) {
        state.settledQuery = state.query;
        renderPanel();
      }
      return;
    }
    if (options.length === 0) return;
    event.preventDefault();
    state.active = nextListSelection(options.map(option => option.id), state.active, event.key);
    paintActive();
    options.find(option => option.id === state.active)?.scrollIntoView?.({ block: "nearest" });
  });
  panel.addEventListener("keydown", event => {
    if (!state.menu) return;
    const menu = panel.querySelector<HTMLElement>(`[data-switcher-menu="${state.menu}"]`);
    if (!menu || !menu.contains(document.activeElement)) return;
    const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitemradio]")];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === "Tab") {
      closeMenu(false);
    }
  });
}

function visibleOptions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("#switcher-checkouts [role=option], #switcher-pull-requests [role=option]")]
    .filter(option => option.getAttribute("aria-disabled") !== "true" && !option.closest("[hidden]"));
}

function paintActive(): void {
  const search = $<HTMLInputElement>("#switcher-search");
  const options = visibleOptions();
  if (state.active !== null && !options.some(option => option.id === state.active)) state.active = null;
  for (const option of document.querySelectorAll<HTMLElement>("#switcher-checkouts [role=option], #switcher-pull-requests [role=option]")) {
    const active = option.id === state.active;
    if (option.getAttribute("aria-selected") !== String(active)) option.setAttribute("aria-selected", String(active));
    option.classList.toggle("is-active", active);
  }
  if (!search) return;
  if (state.active) search.setAttribute("aria-activedescendant", state.active);
  else search.removeAttribute("aria-activedescendant");
}

function renderPanel(): void {
  const panel = $<HTMLElement>("#hub-menu");
  if (!panel) return;
  const lists = panel.querySelector<HTMLElement>(".switcher-lists");
  const stepElement = panel.querySelector<HTMLElement>("#switcher-step");
  if (state.step) {
    if (lists) lists.hidden = true;
    panel.setAttribute("data-step", state.step.kind);
    if (stepElement) renderStep(stepElement, state.step);
    return;
  }
  panel.removeAttribute("data-step");
  if (lists) lists.hidden = false;
  if (stepElement) { stepElement.hidden = true; stepElement.innerHTML = ""; }
  panel.toggleAttribute("data-searching", state.query.trim() !== "");
  renderStatus(panel);
  renderCheckouts(panel);
  renderPullRequests(panel);
  renderFooter(panel);
  paintActive();
  revealPullRequests(panel);
}

function revealPullRequests(panel: HTMLElement): void {
  if (!state.revealPullRequests) return;
  panel.querySelector<HTMLElement>("#switcher-pull-requests-section")?.scrollIntoView?.({ block: "start" });
  // Settled once the section says anything but that it is reading.
  if (!panel.querySelector("#switcher-pr-notes")?.textContent?.includes("Reading pull requests…")) state.revealPullRequests = false;
}

function renderStatus(panel: HTMLElement): void {
  const status = panel.querySelector<HTMLElement>("#switcher-status");
  if (!status) return;
  const facts = currentFacts();
  const viewing = viewingNumber();
  const branch = branchName();
  const stopped = facts.running === false;
  const startWords = { starting: "Starting…", unlock: "Unlock in Hub…", failed: "Start failed" } as const;
  const where = facts.repository && facts.repository !== facts.name
    ? `<span class="switcher-status-repo">${escapeHtml(facts.repository)}</span><span class="switcher-sep" aria-hidden="true">·</span><strong>${escapeHtml(facts.name)}</strong>`
    : `<strong>${escapeHtml(facts.name)}</strong>`;
  const html = `<div class="switcher-status-row">
      <span class="switcher-status-key">Working in</span>
      <span class="switcher-status-value">${where}${stopped ? `<span class="switcher-sep" aria-hidden="true">·</span><span class="switcher-status-stopped">Stopped</span>` : ""}</span>
      ${stopped && hub ? `<button type="button" class="gh-button switcher-start" data-switcher-start${facts.start === "starting" ? " aria-disabled=\"true\"" : ""}>${facts.start ? startWords[facts.start] : "Start"}</button>` : ""}
    </div>
    ${viewing !== null ? `<div class="switcher-status-viewing">
      <div class="switcher-status-row">
        <span class="switcher-status-key">Viewing</span>
        <span class="switcher-status-value">${pullRequestStore.otherRepositoryChosen() ? `<span class="switcher-status-repo">${escapeHtml(repositoryLabel(pullRequestStore.state.repositoryId))}</span> ` : ""}<strong>#${viewing}</strong></span>
        <button type="button" class="gh-link-button switcher-status-back" data-switcher-status-back aria-label="${escapeHtmlAttribute(`Back to ${branch}`)}">← Back</button>
      </div>
      <p class="switcher-status-note">Not checked out · terminal stays on ${escapeHtml(branch)}</p>
    </div>` : ""}`;
  if (status.dataset.html === html) return;
  status.dataset.html = html;
  status.innerHTML = html;
}

function pullRequestForBranch(branch: string): { number: number; title: string } | null {
  const items = currentList()?.pullRequests ?? [];
  const match = items.find(item => pullRequestLocalBranch(item) === branch);
  return match ? { number: match.number, title: match.title } : null;
}

function renderCheckouts(panel: HTMLElement): void {
  const section = panel.querySelector<HTMLElement>("#switcher-checkouts-section");
  const list = panel.querySelector<HTMLElement>("#switcher-checkouts");
  if (!section || !list) return;
  section.hidden = hub === null;
  if (!hub) { list.replaceChildren(); return; }
  hub.renderCheckouts(list, state.query, pullRequestForBranch);
  const searching = state.query.trim() !== "";
  // While searching, a section with nothing to show folds away.
  section.hidden = searching && list.querySelector("[role=option]") === null;
  const slot = panel.querySelector<HTMLElement>("#switcher-new-slot");
  if (slot) {
    const control = hub.newControl(() => state.opener ?? $<HTMLElement>("#hub-toggle")!);
    const existing = slot.firstElementChild as HTMLElement | null;
    if (!control) slot.replaceChildren();
    else if (!existing || existing.dataset.forkFor !== control.dataset.forkFor || existing.getAttribute("aria-label") !== control.getAttribute("aria-label")) slot.replaceChildren(control);
  }
  const empty = panel.querySelector<HTMLElement>("#switcher-checkouts-empty");
  if (empty) empty.hidden = true;
  renderCreations(panel);
  if (searching && !section.hidden) return;
  if (searching) section.hidden = panel.querySelector("#switcher-creating [data-creating-row]") === null;
}

// --- Checking a pull request out ----------------------------------------------

function creationFor(number: number): Creation | null {
  return hubForPullRequests() ? state.creations.get(number) ?? null : null;
}

function creationLinePart(creation: Creation): LinePart {
  return creation.status === "creating"
    ? { text: "Checking out…", tone: "progress" }
    : { text: "Couldn't create", tone: "danger" };
}

// The checkouts being created, under the Hub's own rows: listed at once as
// `Creating…`, not enterable until ready; a failure stays as `Couldn't
// create · Retry`, and its row opens the pull request's step with the reason.
function renderCreations(panel: HTMLElement): void {
  const container = panel.querySelector<HTMLElement>("#switcher-creating");
  if (!container) return;
  const rows = [...state.creations.values()]
    .filter(creation => hubForPullRequests() && matchesSearch([creation.branch, `#${creation.pr.number}`, String(creation.pr.number), creation.pr.title], state.query))
    .map(creation => {
      const line1 = `<span class="switcher-row-line1"><span class="switcher-row-number">#${creation.pr.number}</span> <strong>${escapeHtml(creation.pr.title)}</strong></span>`;
      if (creation.status === "creating") {
        return `<div class="switcher-row switcher-creating-row" role="listitem" data-creating-row="${creation.pr.number}" aria-label="${escapeHtmlAttribute(`${creation.branch}, creating. Pull request ${creation.pr.number}`)}">
          <span class="indicator-dot switcher-spinner" aria-hidden="true"></span>
          <span class="switcher-row-text">${line1}<span class="switcher-row-line2">${lineHtml([{ text: creation.branch }, { text: "Creating…", tone: "progress" }])}</span></span>
        </div>`;
      }
      return `<div class="switcher-row switcher-creating-row is-failed" role="listitem" data-creating-row="${creation.pr.number}">
          <span class="indicator-dot is-hollow" aria-hidden="true"></span>
          <button type="button" class="switcher-row-text switcher-creating-open" data-creating-open="${creation.pr.number}" aria-label="${escapeHtmlAttribute(`${creation.branch}, couldn't create. Pull request ${creation.pr.number}: show why`)}">${line1}<span class="switcher-row-line2">${lineHtml([{ text: creation.branch }, { text: "Couldn't create", tone: "danger" }])}</span></button>
          <button type="button" class="gh-link-button switcher-creating-retry" data-creating-retry="${creation.pr.number}" aria-label="${escapeHtmlAttribute(`Retry creating ${creation.branch}`)}">Retry</button>
        </div>`;
    }).join("");
  container.hidden = rows === "";
  if (container.dataset.html === rows) return;
  container.dataset.html = rows;
  container.innerHTML = rows;
}

// Create worktree, for real: you stay where you are. Called from the
// confirmation and from Retry.
function startCreation(pr: ChosenPullRequest): void {
  const source = hubForPullRequests()?.worktreeSource?.();
  if (!source || state.creations.get(pr.number)?.status === "creating") return;
  const branch = pullRequestLocalBranch(pr);
  state.creations.set(pr.number, { pr, branch, status: "creating" });
  const document_ = root;
  announce(`Checking out #${pr.number} as ${branch}. You stay here; a notice says when it's ready.`);
  refreshSwitcher();
  void checkOutPullRequest(source.api, source.sourceId, {
    number: pr.number,
    headRefName: pr.headRefName,
    isCrossRepository: pr.isCrossRepository,
    // The GitHub repository's local remote name, when the session says it.
    remote: currentList()?.remote ?? "origin",
  }).then(outcome => {
    if (root !== document_) return;
    if (outcome.ok) {
      state.creations.delete(pr.number);
      // The Hub's list is re-read so the new checkout is a row to go to.
      hub?.refresh();
      showReady({ branch: outcome.branch, workspaceId: outcome.workspaceId, differs: outcome.differsFromHead });
    } else {
      state.creations.set(pr.number, { pr, branch, status: "failed", message: outcome.message });
      announce(`Couldn't create ${branch}. ${outcome.message}`);
    }
    refreshSwitcher();
  });
}

function showReady(notice: ReadyNotice): void {
  state.ready = notice;
  let element = $<HTMLElement>("#switcher-ready");
  if (!element) {
    element = document.createElement("div");
    element.id = "switcher-ready";
    element.className = "switcher-ready";
    element.setAttribute("role", "status");
    element.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      const ready = state.ready;
      if (target.closest("[data-ready-go]") && ready) {
        dismissReady();
        hub?.goTo(ready.workspaceId);
      } else if (target.closest("[data-ready-dismiss]")) {
        dismissReady();
      }
    });
    document.body.appendChild(element);
  }
  const differs = notice.differs
    ? ` <span class="switcher-ready-note">It was already here and is not at the pull request's head; pull in its terminal to update it.</span>`
    : "";
  element.innerHTML = `<span class="switcher-ready-text"><strong>${escapeHtml(notice.branch)}</strong> is ready.${differs}</span>
    <button type="button" class="gh-button gh-button-primary" data-ready-go aria-label="${escapeHtmlAttribute(`Go to ${notice.branch}`)}">Go to</button>
    <button type="button" class="switcher-icon-button" data-ready-dismiss aria-label="Dismiss"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`;
  element.hidden = false;
}

function dismissReady(): void {
  state.ready = null;
  const element = $<HTMLElement>("#switcher-ready");
  if (element) { element.hidden = true; element.innerHTML = ""; }
}

function renderFooter(panel: HTMLElement): void {
  const footer = panel.querySelector<HTMLElement>("#switcher-footer");
  if (!footer) return;
  const links = hub?.footerLinks() ?? [];
  footer.hidden = links.length === 0;
  const html = links.map(link => `<a class="switcher-footer-link" href="${escapeHtmlAttribute(link.href)}">${escapeHtml(link.label)}</a>`).join("");
  if (footer.dataset.html === html) return;
  footer.dataset.html = html;
  footer.innerHTML = html;
}

// --- Pull requests -------------------------------------------------------------

async function loadList(manual: boolean): Promise<void> {
  const repositoryId = pullRequestStore.state.repositoryId;
  if (pullRequestStore.state.enabled !== true || !repositoryId || state.loadingFor === repositoryId) return;
  if (pullRequestStore.state.summary?.status === "no-credential") return;
  if (hub && hub.facts().running === false) return;
  state.loadingFor = repositoryId;
  if (manual) renderIfOpen();
  // An answer for a repository that is no longer the current one is dropped.
  const current = () => pullRequestStore.state.repositoryId === repositoryId;
  try {
    const list = await githubApi.pullRequests(repositoryId);
    if (!current()) return;
    state.list = list;
    state.listRepositoryId = repositoryId;
    state.listError = null;
    state.listNoCredential = false;
    // The Pull request pane marks pending reviews from it too.
    pullRequestStore.applyList(list);
  } catch (failure) {
    if (!current()) return;
    // A failed re-read keeps the repository's last list on screen.
    if (state.listRepositoryId !== repositoryId) state.list = null;
    state.listRepositoryId = repositoryId;
    state.listError = errorMessage(failure);
    state.listNoCredential = failure instanceof GithubRequestError && failure.status === 401;
  } finally {
    if (state.loadingFor === repositoryId) state.loadingFor = null;
  }
  renderIfOpen();
}

// The list, when it is the current repository's.
function currentList(): PullRequestList | null {
  return state.listRepositoryId === pullRequestStore.state.repositoryId ? state.list : null;
}

function renderIfOpen(): void {
  if (state.open) renderPanel();
}

function lookUp(number: number): void {
  const repositoryId = pullRequestStore.state.repositoryId;
  if (!repositoryId || state.lookups.has(number)) return;
  state.lookups.set(number, { status: "loading" });
  githubApi.pullRequest({ repository: repositoryId, number }).then(
    detail => { state.lookups.set(number, { status: "found", pr: detail.summary }); },
    failure => { state.lookups.set(number, { status: "error", message: errorMessage(failure), missing: failure instanceof GithubRequestError && failure.status === 404 }); },
  ).finally(renderIfOpen);
}

function foundLookup(): PullRequestSummary | null {
  const wanted = pullRequestQueryTarget(state.query);
  if (!wanted) return null;
  const lookup = state.lookups.get(wanted.number);
  return lookup?.status === "found" ? lookup.pr : null;
}

function workspaceName(): string {
  return hub?.repositoryName() ?? pullRequestStore.state.summary?.repository?.name ?? "this workspace";
}

function lineHtml(parts: LinePart[]): string {
  return parts.map(part => `<span class="switcher-part${part.tone ? ` is-${part.tone}` : ""}">${escapeHtml(part.text)}</span>`)
    .join(`<span class="switcher-sep" aria-hidden="true">·</span>`);
}

// The Hub's checkouts are its repository's: with another of the workspace's
// repositories chosen, none of them is a pull request's checkout, and none
// can be created from it.
function hubForPullRequests(): SwitcherHub | null {
  return hub && !pullRequestStore.otherRepositoryChosen() ? hub : null;
}

function rowFacts(item: PullRequestListItem) {
  const viewing = viewingNumber() === item.number;
  const own = pullRequestStore.branchNumber() === item.number;
  const checkout = hubForPullRequests()?.findCheckout(pullRequestLocalBranch(item)) ?? null;
  const pending = Math.max(item.viewerPendingComments, pullRequestStore.pendingCount(item.number));
  return { viewing, checkedOut: own || checkout !== null, pending, own, checkout };
}

function rowAction(facts: ReturnType<typeof rowFacts>): string {
  if (facts.own) return facts.viewing ? "Go back to it" : "Shown when not viewing another";
  if (facts.pending > 0 || !hubForPullRequests()) return "View here";
  if (facts.checkout && !facts.checkout.current) return "Choose: go to its worktree or view here";
  return "Choose: view here or check out";
}

function pullRequestRowHtml(item: PullRequestListItem): string {
  const facts = rowFacts(item);
  const mark = facts.viewing
    ? `<span class="switcher-row-mark is-viewing" title="Viewing">${EYE_GLYPH}</span>`
    : facts.checkedOut ? `<span class="switcher-row-mark is-checked-out" title="Checked out">${BRANCH_GLYPH}</span>` : "";
  // A checkout being created reads so on the pull request's row too, so the
  // same pull request is not checked out twice.
  const creation = creationFor(item.number);
  const creationPart: LinePart[] = creation ? [creationLinePart(creation)] : [];
  const name = `${pullRequestRowName(item, facts, rowAction(facts))}${creation ? `. ${creationLinePart(creation).text}` : ""}`;
  return `<div id="switcher-pr-${item.number}" class="switcher-row switcher-pr-row${facts.viewing ? " is-viewing" : ""}" role="option" aria-selected="false" data-pr-row="${item.number}" aria-label="${escapeHtmlAttribute(name)}">
      <span class="switcher-row-text">
        <span class="switcher-row-line1"><span class="switcher-row-number">#${item.number}</span> <strong>${escapeHtml(item.title)}</strong></span>
        <span class="switcher-row-line2">${lineHtml([...pullRequestLine2(item, facts.pending), ...creationPart])}</span>
      </span>
      ${mark}
    </div>`;
}

function lookupRowHtml(pr: PullRequestSummary): string {
  const state_ = pr.state === "OPEN" ? "Open" : pr.state === "MERGED" ? "Merged" : "Closed";
  return `<div id="switcher-pr-${pr.number}" class="switcher-row switcher-pr-row" role="option" aria-selected="false" data-pr-row="${pr.number}" aria-label="${escapeHtmlAttribute(`Pull request ${pr.number}, ${pr.title}. ${state_}, by ${pr.author}. View here`)}">
      <span class="switcher-row-text">
        <span class="switcher-row-line1"><span class="switcher-row-number">#${pr.number}</span> <strong>${escapeHtml(pr.title)}</strong></span>
        <span class="switcher-row-line2">${lineHtml([{ text: pr.author }, { text: state_ }])}</span>
      </span>
    </div>`;
}

// The repository the pull requests are from, as the section heading names it:
// `owner/name` once GitHub has said it, else the local repository's label.
function repositoryLabel(repositoryId: string | null): string {
  const known = pullRequestStore.githubName(repositoryId);
  if (known) return known;
  const summary = pullRequestStore.state.summary?.repository;
  if (summary && repositoryId === pullRequestStore.state.repositoryId) return `${summary.owner}/${summary.name}`;
  return pullRequestStore.repositories().find(repository => repository.id === repositoryId)?.label ?? "";
}

// `Pull requests · octo-org/uatu`: plain text with one repository, a compact
// selector when the workspace has more than one Git repository.
function renderRepository(slot: HTMLElement | null, menuSlot: HTMLElement | null, set: (element: HTMLElement, html: string) => void): void {
  if (!slot || !menuSlot) return;
  const current = pullRequestStore.state.repositoryId;
  const label = repositoryLabel(current);
  const repositories = pullRequestStore.repositories();
  if (repositories.length < 2) {
    set(slot, label ? `<span class="switcher-sep" aria-hidden="true">·</span><span class="switcher-pr-repo-name" title="${escapeHtmlAttribute(label)}">${escapeHtml(label)}</span>` : "");
    set(menuSlot, "");
    return;
  }
  const open = state.menu === "repository";
  set(slot, `<span class="switcher-sep" aria-hidden="true">·</span><button type="button" class="gh-link-button switcher-repo-toggle" data-switcher-menu-toggle="repository" aria-haspopup="menu" aria-expanded="${open}" aria-label="${escapeHtmlAttribute(`Repository: ${label}. Choose another`)}" title="${escapeHtmlAttribute(label)}"><span class="switcher-pr-repo-name">${escapeHtml(label)}</span> <span aria-hidden="true">▾</span></button>`);
  set(menuSlot, `<span class="switcher-filter-menu switcher-repo-menu" data-switcher-menu="repository" role="menu" aria-label="Pull requests from"${open ? "" : " hidden"}>${repositories.map(repository => {
    const name = repositoryLabel(repository.id);
    return `<button type="button" role="menuitemradio" aria-checked="${repository.id === current}" data-switcher-repository="${escapeHtmlAttribute(repository.id)}">${escapeHtml(name)}${name !== repository.label ? `<span class="switcher-repo-local">${escapeHtml(repository.label)}</span>` : ""}</button>`;
  }).join("")}</span>`);
}

function renderPullRequests(panel: HTMLElement): void {
  const section = panel.querySelector<HTMLElement>("#switcher-pull-requests-section");
  const notes = panel.querySelector<HTMLElement>("#switcher-pr-notes");
  const listbox = panel.querySelector<HTMLElement>("#switcher-pull-requests");
  const more = panel.querySelector<HTMLElement>("#switcher-pr-more");
  const filterSlot = panel.querySelector<HTMLElement>("#switcher-filter-slot");
  if (!section || !notes || !listbox || !more || !filterSlot) return;
  const storeState = pullRequestStore.state;
  const enabled = storeState.enabled === true && storeState.repositoryId !== null;
  section.hidden = !enabled;
  const set = (element: HTMLElement, html: string) => {
    if (element.dataset.html === html) return;
    element.dataset.html = html;
    element.innerHTML = html;
  };
  const repoSlot = panel.querySelector<HTMLElement>("#switcher-pr-repo");
  const repoMenuSlot = panel.querySelector<HTMLElement>("#switcher-repo-menu-slot");
  if (!enabled) {
    set(notes, ""); set(listbox, ""); set(more, ""); set(filterSlot, "");
    if (repoSlot) set(repoSlot, "");
    if (repoMenuSlot) set(repoMenuSlot, "");
    return;
  }
  renderRepository(repoSlot, repoMenuSlot, set);
  const searching = state.query.trim() !== "";
  const facts = currentFacts();
  const listIsCurrent = state.listRepositoryId === storeState.repositoryId;
  const noCredential = storeState.summary?.status === "no-credential" || (listIsCurrent && state.listNoCredential);
  if (hub && facts.running === false) {
    set(filterSlot, ""); set(listbox, ""); set(more, "");
    set(notes, `<p class="switcher-note">Start ${escapeHtml(workspaceName())} to list pull requests.</p>`);
    section.hidden = searching;
    return;
  }
  if (noCredential) {
    set(filterSlot, ""); set(listbox, ""); set(more, "");
    set(notes, connectGithubHtml("line", workspaceName()));
    section.hidden = searching;
    return;
  }
  const filterLabel = PULL_REQUEST_FILTERS.find(entry => entry.value === state.filter)?.label ?? "Open";
  set(filterSlot, `<span class="switcher-filter">
      <button type="button" class="gh-link-button switcher-filter-toggle" data-switcher-menu-toggle="filter" aria-haspopup="menu" aria-expanded="${state.menu === "filter"}" aria-label="${escapeHtmlAttribute(`Filter: ${filterLabel}`)}">${escapeHtml(filterLabel)} <span aria-hidden="true">▾</span></button>
      <span class="switcher-filter-menu" data-switcher-menu="filter" role="menu" aria-label="Filter pull requests"${state.menu === "filter" ? "" : " hidden"}>${PULL_REQUEST_FILTERS.map(entry =>
        `<button type="button" role="menuitemradio" aria-checked="${entry.value === state.filter}" data-switcher-filter="${entry.value}">${escapeHtml(entry.label)}</button>`).join("")}</span>
    </span>`);

  const summary = storeState.summary;
  const stale = summary && (summary.status === "rate-limited" || summary.status === "unavailable");
  const noteParts: string[] = [];
  if (stale) noteParts.push(`<p class="switcher-note" role="status">${summary.status === "rate-limited" ? "Rate-limited" : "GitHub unreachable"} · as of ${escapeHtml(clockTime(summary.checkedAt))} · <button type="button" class="gh-link-button" data-switcher-retry>Retry</button></p>`);
  const list = currentList();
  // Another repository chosen (or the first opening): read its list.
  if (state.listRepositoryId !== storeState.repositoryId) void loadList(false);
  if (!list) {
    noteParts.push(listIsCurrent && state.listError
      ? `<p class="switcher-note is-error" role="alert">${escapeHtml(state.listError)} <button type="button" class="gh-link-button" data-switcher-retry>Retry</button></p>`
      : `<p class="switcher-note">Reading pull requests…</p>`);
    set(notes, noteParts.join("")); set(listbox, ""); set(more, "");
    return;
  }
  const items = sortPullRequests(filterPullRequests(list.pullRequests, state.filter, list.viewer), number => {
    const item = list.pullRequests.find(candidate => candidate.number === number);
    return Math.max(item?.viewerPendingComments ?? 0, pullRequestStore.pendingCount(number));
  });
  // A number or pull request URL: this repository's names one pull request
  // (its open row, else a lookup in any state); another repository's gets a
  // sentence and no action.
  const wanted = pullRequestQueryTarget(state.query);
  const otherRepository = wanted ? otherRepositoryName(wanted, list.repository) : null;
  const exact = wanted && !otherRepository ? list.pullRequests.find(item => item.number === wanted.number) ?? null : null;
  let visible = otherRepository ? [] : wanted?.repository ? (exact ? [exact] : []) : items.filter(item => pullRequestMatches(item, state.query));
  if (exact && !visible.includes(exact)) visible = [exact, ...visible];
  const lookupNumber = wanted && shouldLookUp({ named: true, otherRepository: Boolean(otherRepository), exactOpen: Boolean(exact), visibleMatches: visible.length, settled: state.settledQuery === state.query }) ? wanted.number : null;
  if (lookupNumber !== null) lookUp(lookupNumber);
  const repositoryLabel = `${list.repository.owner}/${list.repository.name}`;
  if (otherRepository) noteParts.push(`<p class="switcher-note" role="status">This link is for <strong>${escapeHtml(otherRepository)}</strong>, not <strong>${escapeHtml(repositoryLabel)}</strong>.</p>`);
  const waiting = wanted && !otherRepository && !exact && visible.length === 0 && lookupNumber === null;
  if (waiting) noteParts.push(`<p class="switcher-note">#${wanted.number} isn't in the open list. Press Enter to look it up on GitHub.</p>`);
  let lookupRow = "";
  if (lookupNumber !== null) {
    const lookup = state.lookups.get(lookupNumber) ?? { status: "loading" as const };
    noteParts.push(`<p class="switcher-note" role="status">${escapeHtml(lookupText(lookupNumber, lookup, repositoryLabel))}</p>`);
    if (lookup.status === "found") lookupRow = lookupRowHtml(lookup.pr);
  }
  if (!otherRepository && !wanted && visible.length === 0) {
    noteParts.push(searching
      ? `<p class="switcher-note">No open pull request matches. A number or a pull request URL also finds merged and closed ones.</p>`
      : `<p class="switcher-note">No ${state.filter === "open" ? "open pull requests" : `pull requests in ${escapeHtml(filterLabel)}`}.</p>`);
  }
  const shown = searching || state.expanded ? visible : visible.slice(0, PULL_REQUESTS_FOLDED);
  set(notes, noteParts.join(""));
  set(listbox, shown.map(pullRequestRowHtml).join("") + lookupRow);
  set(more, !searching && !state.expanded && visible.length > PULL_REQUESTS_FOLDED
    ? `<button type="button" class="gh-link-button switcher-show-all" data-switcher-show-all>Show all ${visible.length}</button>` : "");
  // While searching, a section with nothing to show folds away.
  section.hidden = searching && shown.length === 0 && lookupRow === "" && noteParts.length === 0;
}

function openMenu(which: "filter" | "repository"): void {
  state.menu = which;
  renderPanel();
  document.querySelector<HTMLElement>(`[data-switcher-menu="${which}"] [aria-checked="true"]`)?.focus();
}

function closeMenu(focusToggle: boolean): void {
  const which = state.menu;
  state.menu = null;
  renderPanel();
  if (focusToggle && which) document.querySelector<HTMLElement>(`[data-switcher-menu-toggle="${which}"]`)?.focus();
}

// The repository selector: another of the workspace's Git repositories
// becomes the pull request repository (page-local). A pull request viewed
// from the old one is let go first, so Files and Preview show the checkout.
function chooseRepository(repositoryId: string): void {
  const changed = repositoryId !== pullRequestStore.state.repositoryId;
  if (changed && viewingNumber() !== null) showBranch("none");
  state.expanded = false;
  state.lookups.clear();
  if (changed) pullRequestStore.chooseRepository(repositoryId);
  closeMenu(true);
}

// --- Choosing a pull request ------------------------------------------------

function chosenPullRequest(number: number): ChosenPullRequest | null {
  const item = currentList()?.pullRequests.find(candidate => candidate.number === number);
  if (item) return item;
  for (const lookup of state.lookups.values()) {
    if (lookup.status === "found" && lookup.pr.number === number) return lookup.pr;
  }
  return null;
}

export function choosePullRequest(number: number): void {
  const pr = chosenPullRequest(number);
  if (!pr) return;
  // The checked-out branch's own pull request: choosing it is Back.
  if (pullRequestStore.branchNumber() === number) {
    closeSwitcher({ restoreFocus: false });
    if (viewingNumber() !== null) showBranch("heading");
    else viewHere(number);
    return;
  }
  const checkout = hubForPullRequests()?.findCheckout(pullRequestLocalBranch(pr)) ?? null;
  if (checkout?.current) {
    closeSwitcher({ restoreFocus: false });
    showBranch("heading");
    return;
  }
  const pending = Math.max(currentList()?.pullRequests.find(item => item.number === number)?.viewerPendingComments ?? 0, pullRequestStore.pendingCount(number));
  // A pending review can only be finished in the view; outside a Hub there
  // is nothing else to choose. A checkout being created (or one that
  // failed) is shown on the pull request's own step either way.
  if (!hubForPullRequests() || (pending > 0 && checkout === null && !creationFor(number))) {
    viewHere(number);
    return;
  }
  openChoice(pr);
}

function openChoice(pr: ChosenPullRequest): void {
  state.step = { kind: "choice", pr };
  renderPanel();
  document.querySelector<HTMLElement>("#switcher-step [data-choice]")?.focus({ preventScroll: true });
}

function viewHere(number: number): void {
  const repositoryId = pullRequestStore.state.repositoryId;
  if (!repositoryId) return;
  closeSwitcher({ restoreFocus: false });
  document.dispatchEvent(new CustomEvent<OpenPullRequestDetail>(OPEN_PULL_REQUEST_EVENT, { detail: { repositoryId, number } }));
  if (number !== pullRequestStore.branchNumber()) announce(`Viewing #${number}. Terminal and agent stay on ${branchName()}.`);
}

function stepBack(): void {
  const step = state.step;
  if (!step) return;
  state.step = step.kind === "choice" ? null : { kind: "choice", pr: step.pr };
  renderPanel();
  if (state.step) document.querySelector<HTMLElement>("#switcher-step [data-choice]")?.focus({ preventScroll: true });
  else {
    const row = document.getElementById(`switcher-pr-${step.pr.number}`);
    if (row) state.active = row.id;
    paintActive();
    const search = $<HTMLInputElement>("#switcher-search");
    if (touchMode() || !search) $<HTMLElement>("#hub-menu")?.focus({ preventScroll: true });
    else search.focus({ preventScroll: true });
  }
}

function runChoice(choice: string): void {
  const step = state.step;
  if (!step) return;
  const pr = step.pr;
  if (choice === "view") { viewHere(pr.number); return; }
  if (choice === "go") {
    const checkout = hub?.findCheckout(pullRequestLocalBranch(pr));
    if (checkout) { closeSwitcher({ restoreFocus: false }); hub!.goTo(checkout.id); }
    return;
  }
  if (choice === "check-out") {
    state.step = { kind: "confirm", pr };
    renderPanel();
    document.querySelector<HTMLElement>("#switcher-step [data-switcher-step-back]")?.focus({ preventScroll: true });
    return;
  }
  if (choice === "create" || choice === "retry") {
    if (!hubForPullRequests()?.worktreeSource?.()) {
      // No worktree service: the labelled simulation of the mocked demo.
      state.step = { kind: "done", pr };
      renderPanel();
      document.querySelector<HTMLElement>('#switcher-step [data-choice="view"]')?.focus({ preventScroll: true });
      return;
    }
    // You stay here: back to the lists, where the new checkout is listed as
    // Creating… until the notice says it is ready.
    state.step = null;
    startCreation(pr);
    renderPanel();
    const search = $<HTMLInputElement>("#switcher-search");
    if (touchMode() || !search) $<HTMLElement>("#hub-menu")?.focus({ preventScroll: true });
    else search.focus({ preventScroll: true });
    return;
  }
  if (choice === "close") closeSwitcher();
}

function choiceCard(choice: string, title: string, label: string, lines: string[], options: { primary?: boolean } = {}): string {
  const id = `switcher-choice-${choice}`;
  return `<button type="button" class="switcher-choice${options.primary ? " is-default" : ""}" data-choice="${choice}" aria-label="${escapeHtmlAttribute(label)}" aria-describedby="${id}-lines">
      <span class="switcher-choice-title">${escapeHtml(title)}</span>
      <span id="${id}-lines" class="switcher-choice-lines">${lines.map(line => `<span class="switcher-choice-line">${line}</span>`).join("")}</span>
    </button>`;
}

function renderStep(element: HTMLElement, step: Step): void {
  element.hidden = false;
  const pr = step.pr;
  const branch = branchName();
  const repository = hub?.repositoryName() ?? workspaceName();
  const checkout = pullRequestCheckout(pr, repository);
  const head = (title: string) => `<div class="switcher-head switcher-step-head">
      <button type="button" class="switcher-icon-button" data-switcher-step-back aria-label="Back to the lists" title="Back"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <h2 id="switcher-step-title" class="switcher-title">${title}</h2>
      <button type="button" class="switcher-icon-button" data-switcher-close aria-label="Close"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    </div>`;
  const viewLines = [`Opens in Files and Preview, from GitHub`, `Terminal and agent stay on ${escapeHtml(branch)}`];
  if (step.kind === "choice") {
    const found = hubForPullRequests()?.findCheckout(pullRequestLocalBranch(pr)) ?? null;
    const view = choiceCard("view", "View here", `View #${pr.number} here`, viewLines, { primary: found === null });
    let cards: string;
    const creation = creationFor(pr.number);
    if (found) {
      const state_ = found.state ? ` · <span class="switcher-part${found.tone ? ` is-${found.tone}` : ""}">${escapeHtml(found.state.toLowerCase())}</span>` : "";
      cards = choiceCard("go", "Go to its worktree", `Go to its worktree, ${found.label}`, [`Opens ${escapeHtml(found.label)}${state_}`, "Its own terminal and agent"], { primary: true }) + view;
    } else if (creation?.status === "creating") {
      cards = view + `<div class="switcher-choice is-pending" role="status">
          <span class="switcher-choice-title"><span class="indicator-dot switcher-spinner" aria-hidden="true"></span> Checking out…</span>
          <span class="switcher-choice-lines"><span class="switcher-choice-line">New folder ${escapeHtml(checkout.folderName)}, on branch ${escapeHtml(checkout.branch)}</span><span class="switcher-choice-line">A notice says when it's ready</span></span>
        </div>`;
    } else if (creation?.status === "failed") {
      cards = view + choiceCard("retry", "Couldn't create · Retry", `Retry checking out #${pr.number} as a worktree`, [escapeHtml(creation.message ?? "The worktree could not be created."), `Tries ${escapeHtml(checkout.branch)} again`]);
    } else {
      // A real Hub worktree service creates it; mocked GitHub data without
      // one still shows the labelled simulation.
      const hub_ = hubForPullRequests();
      cards = view + (hub_?.canCreateWorktree() || (hub_ && currentList()?.mock)
        ? choiceCard("check-out", "Check out as a worktree…", `Check out #${pr.number} as a worktree…`, [`New folder ${escapeHtml(checkout.folderName)}, on branch ${escapeHtml(checkout.branch)}`, "Its own terminal and agent"])
        : "");
    }
    element.innerHTML = `${head(`#${pr.number}`)}
      <div class="switcher-step-body">
        <p class="switcher-step-subject">${escapeHtml(pr.title)}</p>
        <div class="switcher-choices">${cards}</div>
      </div>`;
    element.setAttribute("aria-labelledby", "switcher-step-title");
    return;
  }
  // Simulated only when the Hub serves no worktree operations.
  const simulated = !hubForPullRequests()?.worktreeSource?.();
  const mock = simulated && Boolean(currentList()?.mock ?? true);
  if (step.kind === "confirm") {
    const remote = currentList()?.remote ?? "origin";
    const source = pr.isCrossRepository ? `<code>pull/${pr.number}/head</code> from the base repository (${escapeHtml(remote)})` : `<code>${escapeHtml(remote)}/${escapeHtml(pr.headRefName)}</code>`;
    element.innerHTML = `${head(`Check out #${pr.number}`)}
      <div class="switcher-step-body">
        <div class="switcher-facts">
          <dl>
            <dt>Folder</dt><dd><code>${escapeHtml(checkout.folder)}</code></dd>
            <dt>Branch</dt><dd><code>${escapeHtml(checkout.branch)}</code></dd>
          </dl>
          <details class="switcher-more"><summary>More details</summary>
            <dl>
              <dt>From</dt><dd>${source}</dd>
              <dt>Credentials</dt><dd>Inherited from <strong>${escapeHtml(repository)}</strong></dd>
            </dl>
          </details>
        </div>
        ${pr.isCrossRepository ? `<p class="gh-notice gh-notice-warn switcher-fork-note">From a fork: uatu won't push back to it.</p>` : ""}
        ${mock ? `<p class="gh-notice switcher-simulated"><strong>Simulated.</strong> GitHub data is mocked here, so Create worktree shows the result without creating anything.</p>` : ""}
        <button type="button" class="gh-button gh-button-primary switcher-create" data-choice="create">Create worktree</button>
        <p class="switcher-step-note">You stay here and get a notice when it's ready.</p>
      </div>`;
    return;
  }
  element.innerHTML = `${head("Simulated: no worktree was created")}
    <div class="switcher-step-body">
      <p class="gh-notice gh-notice-warn">GitHub data is mocked in this build, so checking out #${pr.number} is simulated. Nothing was fetched, no branch was created, and the Hub's list of checkouts is unchanged.</p>
      <p>With real GitHub data, <strong>${escapeHtml(checkout.branch)}</strong> would now be created in <code>${escapeHtml(checkout.folder)}</code>, and a notice would offer to go there when it's ready. You would stay here.</p>
      <div class="switcher-step-actions">
        <button type="button" class="gh-button gh-button-primary" data-choice="view" aria-label="${escapeHtmlAttribute(`View #${pr.number} here`)}">View #${pr.number} here</button>
        <button type="button" class="gh-button" data-choice="close">Close</button>
      </div>
    </div>`;
}
