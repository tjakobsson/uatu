// Change-overview pane — renders the per-repository change context (branch,
// dirty state, compare anchor, warnings, untracked indicator) and the
// changed-file count summary used by the file-count chip. Extracted from
// `app.ts` so the sidebar feature folder owns the change-overview
// presentation in one place.

import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import type { RepositorySnapshot, CompareTarget } from "../shared/types";
import { identityColor, identityHue } from "../shell/identity";
import { renderSidebar } from "./shell";
import { appState } from "../shell/state";
import { persistPersonalWorkspaceState } from "../shell/personal-state";
import { refreshServerStateForContext } from "../shell/events";
import { documentDiffCache, loadDocument } from "../preview/mount";
import type { FilesPaneFilterMembership, GitStatusForView } from "./tree-view";
import { baseModeLabel } from "./git-log";

const COMPARE_TARGET_OPTIONS: { target: CompareTarget; label: string }[] = [
  { target: "base", label: "Since base" },
  { target: "last-commit", label: "Since last commit" },
];

const changeOverviewElementMaybe = document.querySelector<HTMLDivElement>("#change-overview");

if (!changeOverviewElementMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/change-overview)");
}

const changeOverviewElement: HTMLDivElement = changeOverviewElementMaybe;

// The compare-target toggle is session-global, so it renders once above the
// per-repository sections. Returns "" when no repository can be compared
// (non-git session) — there is nothing to switch between.
function renderCompareTargetControl(): string {
  const available = appState.repositories.filter(
    repository => repository.status === "available",
  );
  if (available.length === 0) {
    return "";
  }
  // When no base is resolvable the two targets describe the same diff; surface
  // that rather than implying a meaningful choice (collapsed state).
  const collapsed = available.every(repository => repository.base.targetsCollapsed);
  const options = COMPARE_TARGET_OPTIONS.map(option => {
    const active = appState.compareTarget === option.target;
    return `
      <button
        type="button"
        class="compare-target-option${active ? " is-active" : ""}"
        data-compare-target="${escapeHtmlAttribute(option.target)}"
        aria-pressed="${active ? "true" : "false"}"
      >${escapeHtml(option.label)}</button>
    `;
  }).join("");
  const note = collapsed
    ? `<p class="compare-target-note">No base branch resolved — both show changes vs HEAD.</p>`
    : "";
  return `
    <div class="compare-target-control" role="group" aria-label="Compare against"${collapsed ? " data-collapsed=\"true\"" : ""}>
      ${options}
    </div>
    ${note}
  `;
}

// The repository name doubles as the project identity marker (issues
// #101/#102): a badge tinted with the same hue as the tab favicon, so the
// color learned in the tab strip is the color seen in the pane. The hue
// hashes the repository's watched roots' paths — the same inputs the
// favicon uses — so single-repo sessions match exactly. The "+N"-style
// shorthand elsewhere hides paths; here the tooltip carries them all.
function renderRepositoryName(repository: RepositorySnapshot): string {
  const roots = appState.roots.filter(root => repository.watchedRootIds.includes(root.id));
  const hue = identityHue(roots);
  // `id` is the watched entry's absolute path — the file itself for
  // file-scoped sessions, where `path` degrades to the parent directory.
  const tooltip = roots.length > 0 ? roots.map(root => root.id).join("\n") : repository.rootPath;
  return `
    <h3 class="repo-name">
      <span class="project-marker" style="background-color: ${escapeHtmlAttribute(identityColor(hue))}" title="${escapeHtmlAttribute(tooltip)}">${escapeHtml(repository.label)}</span>
    </h3>
  `;
}

export function renderChangeOverview() {
  if (appState.repositories.length === 0) {
    changeOverviewElement.innerHTML = `<div class="pane-empty">Repository data is unavailable.</div>`;
    return;
  }

  const sections = appState.repositories
    .map(repository => {
      const meta = repository.metadata;
      if (meta.status !== "git" || repository.status !== "available") {
        return `
          <section class="overview-repo">
            ${renderRepositoryName(repository)}
            <p class="pane-empty">${escapeHtml(meta.message ?? repository.message ?? "No git repository is available.")}</p>
          </section>
        `;
      }

      // Evidence layer: the resolved base ref + mode, plus the merge-base short
      // SHA when present. `merge-base` is shown ONLY here, never on the toggle
      // or the compare anchor.
      const baseLabel =
        repository.base.ref && repository.base.mode !== "dirty-worktree-only"
          ? `${repository.base.ref} (${baseModeLabel(repository.base.mode)})${repository.base.mergeBase ? ` · ${repository.base.mergeBase.slice(0, 7)}` : ""}`
          : baseModeLabel(repository.base.mode);
      // Readout anchor: the precise, portable ref the changed-files context was
      // computed against (e.g. `vs origin/main`, `vs HEAD`) so the change set
      // carries its meaning when read away from the toggle.
      const compareAnchor = `vs ${repository.base.comparedAgainstRef}`;
      const warnings = repository.configWarnings.map(warning => `<div class="config-warning">${escapeHtml(warning)}</div>`).join("");
      const hasUntracked = repository.changedFiles.some(file => file.status.startsWith("?"));
      const untrackedIndicator = hasUntracked
        ? `<div class="untracked-indicator" data-untracked-indicator>Includes untracked files</div>`
        : "";

      return `
        <section class="overview-repo">
          ${renderRepositoryName(repository)}
          <dl class="repo-facts">
            <div><dt>Branch</dt><dd>${escapeHtml(meta.branch ?? `detached ${meta.commitShort ?? ""}`.trim())}</dd></div>
            <div><dt>Commit</dt><dd>${escapeHtml(meta.commitShort ?? "unknown")}</dd></div>
            <div><dt>Status</dt><dd>${meta.dirty ? "dirty" : "clean"}</dd></div>
            <div><dt>Base</dt><dd>${escapeHtml(baseLabel)}</dd></div>
            <div><dt>Changes</dt><dd class="compare-anchor">${escapeHtml(compareAnchor)}</dd></div>
          </dl>
          ${untrackedIndicator}
          ${warnings}
        </section>
      `;
    })
    .join("");

  changeOverviewElement.innerHTML = renderCompareTargetControl() + sections;
}

export function filterMembershipHasAnyPath(filter: FilesPaneFilterMembership): boolean {
  for (const allowed of filter.allowedByRoot.values()) {
    if (allowed.size > 0) return true;
  }
  return false;
}

// First repository with available change data wins; the chip is global
// across multi-root sessions, so a single base label is sufficient (and
// degrading to a generic label is fine when bases differ or aren't available).
// Uses `comparedAgainstRef` (the ref the active compare target actually
// measured against), not `base.ref` — otherwise the "No changes vs <X>" empty
// state would say `origin/main` even in last-commit mode, where the file list
// is measured against `HEAD`.
export function primaryCompareBaseLabel(): string | null {
  for (const repo of appState.repositories) {
    if (repo.status !== "available") {
      continue;
    }
    return repo.base.comparedAgainstRef;
  }
  return null;
}

// Empty-state copy named in `sidebar-shell`: `No changes vs <base>` when at
// least one repository's change data is available, `Changed filter is
// unavailable — no git repository` otherwise.
export function filterEmptyStateCopy(repos: readonly RepositorySnapshot[]): string {
  const anyAvailable = repos.some(repo => repo.status === "available");
  if (!anyAvailable) {
    return "Changed filter is unavailable — no git repository";
  }
  const label = primaryCompareBaseLabel();
  return label ? `No changes vs ${label}` : "No changes vs the compare base";
}

export function formatFileCountDisplay(input: {
  filterOn: boolean;
  visibleCount: number;
  visibleBinaryCount: number;
  totalCount: number;
  totalBinaryCount: number;
}): string {
  // "N of M file(s)" — the noun agrees with the SET size (M), not the
  // subset (N): "1 of 1 file", "1 of 2 files", "2 of 5 files".
  const filesWord = input.totalCount === 1 ? "file" : "files";
  const head = input.filterOn
    ? `${input.visibleCount} of ${input.totalCount} ${filesWord}`
    : `${input.totalCount} ${filesWord}`;
  const binaryCount = input.filterOn ? input.visibleBinaryCount : input.totalBinaryCount;
  if (binaryCount > 0) {
    return `${head} · ${binaryCount} binary`;
  }
  return head;
}

export function collectGitStatusEntries(repos: readonly RepositorySnapshot[]): GitStatusForView[] {
  const out: GitStatusForView[] = [];
  for (const repo of repos) {
    if (repo.status !== "available") {
      continue;
    }
    for (const change of repo.changedFiles) {
      const status = mapChangedFileStatus(change.status);
      if (!status) {
        continue;
      }
      // A repository can span multiple watched roots; emit one entry per root
      // so the annotation lands wherever the file is visible in the tree.
      for (const rootId of repo.watchedRootIds) {
        out.push({ relativePath: change.path, rootId, status });
      }
    }
    // Gitignored files: distinct from "changed" entirely — these are files
    // on disk that git refuses to track. Annotating them as `ignored` lets a
    // reviewer distinguish "this is a clean tracked file" from "git is
    // intentionally not following this" (e.g. local-only settings).
    for (const relativePath of repo.gitIgnoredFiles) {
      for (const rootId of repo.watchedRootIds) {
        out.push({ relativePath, rootId, status: "ignored" });
      }
    }
  }
  return out;
}

function mapChangedFileStatus(raw: string): GitStatusForView["status"] | null {
  const head = (raw[0] ?? "").toUpperCase();
  switch (head) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "U":
    case "?":
      return "untracked";
    case "!":
      return "ignored";
    default:
      return null;
  }
}

// Apply a compare-target switch: persist it, drop now-stale cached diffs,
// Owner mutator for `appState.compareTarget`: assign, persist the preference,
// and drop diffs cached against the previous target. Server POST and
// re-render side effects stay with the callers (this pane's change handler
// and the SSE reducer adopting another tab's switch).
export function adoptCompareTarget(target: CompareTarget): void {
  appState.compareTarget = target;
  persistPersonalWorkspaceState({ compareTarget: target });
  // Cached diffs were computed against the previous target.
  documentDiffCache.clear();
}

// optimistically re-render the control, push the choice to the server (which
// recomputes + rebroadcasts the change data over SSE), and refresh the active
// Diff view against the new target. Mirrors the server-session model of
// `setScope`.
async function applyCompareTargetChange(target: CompareTarget): Promise<void> {
  if (appState.compareTarget === target) {
    return;
  }
  adoptCompareTarget(target);
  // Optimistic re-render so the toggle reflects the choice immediately; the
  // changed-files context + anchor refresh when the server rebroadcasts
  // snapshots.
  renderSidebar();
  await refreshServerStateForContext().catch(() => undefined);
  // The server sets its target synchronously before responding, so by now the
  // diff endpoint will resolve against the new target. Re-fetch the active
  // document if it is currently in Diff view.
  if (
    appState.previewMode.kind === "document" &&
    appState.selectedId &&
    appState.viewMode === "diff"
  ) {
    await loadDocument(appState.selectedId);
  }
}

export function initChangeOverviewClickHandler(): void {
  changeOverviewElement.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const compareButton = target.closest<HTMLButtonElement>("button[data-compare-target]");
    if (compareButton) {
      const next = compareButton.dataset.compareTarget;
      if (next === "base" || next === "last-commit") {
        void applyCompareTargetChange(next);
      }
    }
  });
}
