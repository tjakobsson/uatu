// The Files pane's pull request scope. While the workspace views a pull
// request other than the checked-out branch's own (View here, in the
// workspace switcher), the Files pane lists that PR's changed files as a tree
// in place of the workspace tree, with each file's open threads, pending
// comments and line counts, under a bar naming it (`PR #618` and its title).
// Picking a file opens its diff in the PR's Files changed view. The way back
// is the switcher's (its Viewing strip, chip and status card), which
// dispatches SHOW_BRANCH_EVENT: showBranchPullRequest returns the pane, the
// preview and the Files pane to the checked-out branch: its pull request's
// preview, or (when the branch has none) the workspace's default document.
// While GitHub can't be reached the bar says so, as the pane and the preview
// do.
//
// While the scope is shown the workspace tree's filters and Files options
// (ignored files, file types) are hidden: they would change a tree that
// isn't on screen.
//
// Change Overview carries a "Local branch" label whenever its comparison
// isn't the pull request's diff: uncommitted changes, another HEAD, or Since
// last commit (its tooltip says which). While a pull request is viewed the
// label names the branch instead (`⎇ feat/view-pr`).
//
// The tree is a second instance of the same library the workspace tree uses
// (sidebar/tree-view.ts), with the same theme. It holds PR paths, not
// workspace documents, so it stays out of TreeView's document selection and
// Follow rules.

import { FileTree } from "@pierre/trees";

import { staleNotice } from "../github/availability";
import { pullRequestStore } from "../github/pull-request-store";
import { clockTime } from "../github/present";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appState } from "../shell/state";
import { BRANCH_GLYPH } from "../shell/switcher";
import { showDefaultDocument } from "../shell/history";
import { revealPreviewSurface } from "../shell/tab-bar";
import { activeColorScheme, onColorSchemeChange } from "../shell/theme";
import { activatePullRequestPreview } from "../shell/url";
import { changeOverviewDifference, pullRequestFileDecoration, pullRequestFileRows, type PullRequestFileRow } from "./pull-request-scope-model";
import { onSidebarRepositories, renderSidebar, setFilesScopeCount } from "./shell";
import { setPaneTitle } from "./panes";
import { ancestorPaths, applyTreeTheme } from "./tree-view";

const filesPane = document.querySelector<HTMLElement>('[data-pane-id="files"]')!;
const scopeElement = document.querySelector<HTMLElement>("#pr-scope")!;
const barElement = document.querySelector<HTMLElement>("#pr-scope-bar")!;
const treeElement = document.querySelector<HTMLElement>("#pr-scope-tree")!;
const messageElement = document.querySelector<HTMLElement>("#pr-scope-message")!;
const overviewNote = document.querySelector<HTMLElement>("#change-overview-scope");

let tree: FileTree | null = null;
let rows = new Map<string, PullRequestFileRow>();
let pathsKey = "";
let shownCount: number | null = null;

export function initPullRequestScope(): void {
  setFilesScopeCount(() => shownCount);
  pullRequestStore.subscribe(renderPullRequestScope);
  onSidebarRepositories(renderChangeOverviewNote);
  onColorSchemeChange(scheme => applyTreeTheme(treeElement, scheme));
  // Rows are native buttons inside the library's shadow root: a click, a tap
  // and Enter/Space all arrive here, including on the row already selected.
  treeElement.addEventListener("click", event => {
    const row = event.composedPath().find((target): target is Element =>
      target instanceof Element && target.matches('button[data-type="item"][data-item-path]'));
    const path = row?.getAttribute("data-item-path");
    if (path && rows.has(path)) openFile(path);
  });
}

// Returns the workspace to the checked-out branch: the pane shows its pull
// request, and a preview of the viewed one gives way to the branch's own.
export function showBranchPullRequest(): void {
  const scoped = pullRequestStore.scopedNumber();
  const repositoryId = pullRequestStore.state.repositoryId;
  const branchNumber = pullRequestStore.branchNumber();
  pullRequestStore.select(null);
  const mode = appState.previewMode;
  if (mode.kind !== "pull-request" || mode.number !== scoped) return;
  if (repositoryId && branchNumber !== null) activatePullRequestPreview({ repositoryId, number: branchNumber }, { pushHistory: true });
  else showDefaultDocument({ pushHistory: true });
}

// The workspace tree's row that holds its Tab stop (rows are buttons in the
// library's shadow root), else the Files options button.
export function focusWorkspaceTree(): void {
  const root = filesPane.querySelector<HTMLElement>("#tree")?.shadowRoot;
  const row = root?.querySelector<HTMLElement>('button[data-type="item"][tabindex="0"]')
    ?? root?.querySelector<HTMLElement>('button[data-type="item"]');
  (row ?? filesPane.querySelector<HTMLElement>(".files-options-trigger"))?.focus();
}

function openFile(path: string): void {
  const number = pullRequestStore.scopedNumber();
  const repositoryId = pullRequestStore.state.repositoryId;
  if (number === null || !repositoryId) return;
  revealPreviewSurface();
  activatePullRequestPreview({ repositoryId, number, tab: "files", file: path }, { pushHistory: true });
  // Also when the URL already names this file: tapping it again scrolls back.
  document.dispatchEvent(new CustomEvent("uatu:pull-request-reveal", { detail: { number, path } }));
}

// "Local branch" on Change Overview whenever what it compares differs from
// the pull request's diff (changeOverviewDifference says why, in its
// tooltip). Re-read on every sidebar render: HEAD, dirtiness and the compare
// target change there.
export function renderChangeOverviewNote(): void {
  if (!overviewNote) return;
  const state = pullRequestStore.state;
  const repository = appState.repositories.find(candidate => candidate.id === state.repositoryId);
  const why = state.summary?.status === "no-credential" ? null : changeOverviewDifference({
    branch: state.branch,
    picked: pullRequestStore.scopedNumber(),
    pullRequest: state.summary?.pullRequest ?? null,
    dirty: repository?.metadata.dirty ?? false,
    commitShort: repository?.metadata.commitShort ?? null,
    compareTarget: appState.compareTarget,
  });
  overviewNote.hidden = why === null;
  // Viewing another pull request: the label names the branch Change
  // Overview describes.
  const viewing = pullRequestStore.scopedNumber() !== null && state.branch;
  const html = why === null ? "" : viewing ? `${BRANCH_GLYPH}<span>${escapeHtml(state.branch!)}</span>` : "Local branch";
  if (overviewNote.dataset.html !== html) {
    overviewNote.dataset.html = html;
    overviewNote.innerHTML = html;
  }
  overviewNote.title = why ?? "";
}

export function renderPullRequestScope(): void {
  const number = pullRequestStore.scopedNumber();
  const scoped = number !== null;
  scopeElement.hidden = !scoped;
  filesPane.toggleAttribute("data-files-scope", scoped);
  // Files options act on the workspace tree only: hidden (and closed) here.
  if (scoped) {
    const options = filesPane.querySelector<HTMLElement>("#files-options-popover");
    try {
      if (options?.matches(":popover-open")) options.hidePopover();
    } catch {
      // No popover support: the options can't be open.
    }
  }
  // Whose files the pane lists, and what Change Overview still describes.
  setPaneTitle("files", scoped ? `PR #${number} files` : "Files");
  renderChangeOverviewNote();
  const detail = scoped ? pullRequestStore.detail(number) : null;
  const count = detail ? detail.files.length : null;
  if (count !== shownCount) {
    shownCount = count;
    // The Files count and the pane heights follow the scope.
    renderSidebar();
  }
  if (!scoped) return;

  const pr = detail?.summary;
  const summary = pullRequestStore.state.summary;
  const stale = staleNotice(summary);
  barElement.innerHTML = `
    <span class="pr-scope-label" title="Files changed in pull request #${number}">PR #${number}</span>
    <span class="pr-scope-title"${pr ? ` title="${escapeHtmlAttribute(pr.title)}"` : ""}>${pr ? escapeHtml(pr.title) : "Reading GitHub…"}</span>
    ${detail?.mock ? `<span class="gh-mock-label" title="Mocked GitHub data: served by the in-memory fake (src/github/fake.ts). Nothing reaches GitHub.">Mocked</span>` : ""}
    ${stale ? `<span class="pr-scope-status" role="status" title="${escapeHtmlAttribute(stale.why)}"><strong>${escapeHtml(stale.title)}.</strong> Showing #${number} as of ${escapeHtml(clockTime(summary!.checkedAt))}; sending is paused.</span>` : ""}`;
  if (!detail) {
    treeElement.hidden = true;
    messageElement.hidden = false;
    messageElement.textContent = `Reading pull request #${number}…`;
    return;
  }
  messageElement.hidden = detail.files.length > 0;
  messageElement.textContent = "This pull request changes no files.";
  treeElement.hidden = detail.files.length === 0;
  rows = new Map(pullRequestFileRows(detail).map(row => [row.path, row]));
  const paths = [...rows.keys()];
  const nextKey = `${number}\n${paths.join("\n")}`;
  if (tree === null) {
    tree = new FileTree({
      paths,
      initialExpansion: "open",
      icons: { set: "standard", colored: true },
      search: false,
      renderRowDecoration: ({ row }) => {
        const entry = rows.get(row.path);
        return entry ? pullRequestFileDecoration(entry) : null;
      },
    });
    applyTreeTheme(treeElement, activeColorScheme());
    tree.render({ fileTreeContainer: treeElement });
  } else if (nextKey !== pathsKey) {
    tree.resetPaths(paths, { initialExpandedPaths: [...new Set(paths.flatMap(ancestorPaths))] });
  } else {
    // Same files, new marks: repaint the decorations.
    tree.setComposition(tree.getComposition());
  }
  pathsKey = nextKey;
  tree.setGitStatus([...rows.values()].map(row => ({ path: row.path, status: row.status })));
}

