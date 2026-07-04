// Change-overview pane — renders the per-repository burden score card,
// driver list, base-mode label, and the changed-file count summary used by
// the file-count chip. Extracted from `app.ts` so the sidebar feature
// folder owns the change-overview presentation in one place.

import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import type { RepositoryReviewSnapshot, ReviewCompareTarget } from "../shared/types";
import { applyStaleHint } from "../shell/stale-hint-mount";
import { renderSidebar } from "./shell";
import { syncFollowToggle } from "../shell/follow";
import { pushReviewScore } from "../shell/history";
import { nextStaleHint } from "../shell/stale-hint";
import { appState, writeCompareTargetPreference } from "../shell/state";
import { documentDiffCache, loadDocument } from "../preview/mount";
import type { FilesPaneFilterMembership, GitStatusForView } from "./tree-view";
import { baseModeLabel, capitalize } from "./git-log";
import { renderReviewScoreDetails } from "./review-score-mount";

const COMPARE_TARGET_OPTIONS: { target: ReviewCompareTarget; label: string }[] = [
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
    repository => repository.reviewLoad.status === "available",
  );
  if (available.length === 0) {
    return "";
  }
  // When no base is resolvable the two targets describe the same diff; surface
  // that rather than implying a meaningful choice (collapsed state).
  const collapsed = available.every(repository => repository.reviewLoad.base.targetsCollapsed);
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
    <div class="compare-target-control" role="group" aria-label="Compare review burden against"${collapsed ? " data-collapsed=\"true\"" : ""}>
      ${options}
    </div>
    ${note}
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
      if (meta.status !== "git" || repository.reviewLoad.status !== "available") {
        return `
          <section class="review-repo">
            <h3>${escapeHtml(repository.label)}</h3>
            <p class="pane-empty">${escapeHtml(meta.message ?? repository.reviewLoad.message ?? "No git repository is available.")}</p>
          </section>
        `;
      }

      const load = repository.reviewLoad;
      // Evidence layer: the resolved base ref + mode, plus the merge-base short
      // SHA when present. `merge-base` is shown ONLY here, never on the toggle
      // or the burden anchor.
      const baseLabel =
        load.base.ref && load.base.mode !== "dirty-worktree-only"
          ? `${load.base.ref} (${baseModeLabel(load.base.mode)})${load.base.mergeBase ? ` · ${load.base.mergeBase.slice(0, 7)}` : ""}`
          : baseModeLabel(load.base.mode);
      // Readout anchor: the precise, portable ref the score was computed
      // against (e.g. `vs origin/main`, `vs HEAD`) so the number carries its
      // meaning when read away from the toggle.
      const burdenAnchor = `vs ${load.base.comparedAgainstRef}`;
      const drivers = load.drivers.length > 0
        ? load.drivers.filter(driver => driver.kind !== "mechanical")
        : [];
      const visibleDrivers = drivers.length > 0
        ? `<ul class="score-drivers">${drivers.map(renderDriver).join("")}</ul>`
        : "";
      const warnings = load.settingsWarnings.map(warning => `<div class="config-warning">${escapeHtml(warning)}</div>`).join("");
      const ignored = load.ignoredFiles.length > 0
        ? `<div class="ignored-summary">${load.ignoredFiles.length} ignored file${load.ignoredFiles.length === 1 ? "" : "s"} excluded</div>`
        : "";
      // Workspace-state fact: include `ignoredFiles` too, since `ignoreAreas`
      // is a score policy that should not hide categorical truth from the
      // overview. The score-explanation preview's untracked sub-driver is
      // the only consumer that intentionally filters to `changedFiles`.
      const hasUntracked =
        load.changedFiles.some(file => file.status.startsWith("?")) ||
        load.ignoredFiles.some(file => file.status.startsWith("?"));
      const untrackedIndicator = hasUntracked
        ? `<div class="untracked-indicator" data-untracked-indicator>Includes untracked files</div>`
        : "";

      return `
        <section class="review-repo">
          <h3>${escapeHtml(repository.label)}</h3>
          <dl class="repo-facts">
            <div><dt>Branch</dt><dd>${escapeHtml(meta.branch ?? `detached ${meta.commitShort ?? ""}`.trim())}</dd></div>
            <div><dt>Commit</dt><dd>${escapeHtml(meta.commitShort ?? "unknown")}</dd></div>
            <div><dt>Status</dt><dd>${meta.dirty ? "dirty" : "clean"}</dd></div>
            <div><dt>Base</dt><dd>${escapeHtml(baseLabel)}</dd></div>
          </dl>
          <button
            type="button"
            class="burden-meter is-${escapeHtmlAttribute(load.level)}"
            data-review-score-repository-id="${escapeHtmlAttribute(repository.id)}"
            aria-label="Show review burden score explanation for ${escapeHtmlAttribute(repository.label)}"
            title="Show score explanation"
          >
            <span class="burden-summary">
              <span class="burden-headline">Review burden</span>
              <span class="burden-level">${escapeHtml(capitalize(load.level))}</span>
              <span class="burden-anchor">· ${escapeHtml(burdenAnchor)}</span>
            </span>
            <strong>${load.score}</strong>
          </button>
          ${untrackedIndicator}
          ${warnings}
          ${ignored}
          ${visibleDrivers}
        </section>
      `;
    })
    .join("");

  changeOverviewElement.innerHTML = renderCompareTargetControl() + sections;
}

function renderDriver(driver: RepositoryReviewSnapshot["reviewLoad"]["drivers"][number]): string {
  const score = driver.score > 0 ? `+${driver.score}` : String(driver.score);
  const files = driver.files.length > 0
    ? `<span class="driver-files">${escapeHtml(driver.files.slice(0, 3).join(", "))}${driver.files.length > 3 ? "…" : ""}</span>`
    : "";
  return `
    <li class="score-driver is-${escapeHtmlAttribute(driver.kind)}">
      <span class="driver-main"><strong>${escapeHtml(driver.label)}</strong><span>${escapeHtml(driver.detail)}</span>${files}</span>
      <code>${escapeHtml(score)}</code>
    </li>
  `;
}

export function filterMembershipHasAnyPath(filter: FilesPaneFilterMembership): boolean {
  for (const allowed of filter.allowedByRoot.values()) {
    if (allowed.size > 0) return true;
  }
  return false;
}

// First repository with an available review-load wins; the chip is global
// across multi-root sessions, so a single base label is sufficient (and
// degrading to a generic label is fine when bases differ or aren't available).
// Uses `comparedAgainstRef` (the ref the active compare target actually
// measured against), not `base.ref` — otherwise the "No changes vs <X>" empty
// state would say `origin/main` even in last-commit mode, where the file list
// is measured against `HEAD`.
export function primaryReviewBaseLabel(): string | null {
  for (const repo of appState.repositories) {
    if (repo.reviewLoad.status !== "available") {
      continue;
    }
    return repo.reviewLoad.base.comparedAgainstRef;
  }
  return null;
}

// Empty-state copy named in `sidebar-shell`: `No changes vs <base>` when at
// least one repository's review-load is available, `Changed filter is
// unavailable — no git repository` otherwise.
export function filterEmptyStateCopy(repos: readonly RepositoryReviewSnapshot[]): string {
  const anyAvailable = repos.some(repo => repo.reviewLoad.status === "available");
  if (!anyAvailable) {
    return "Changed filter is unavailable — no git repository";
  }
  const label = primaryReviewBaseLabel();
  return label ? `No changes vs ${label}` : "No changes vs the review base";
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

export function collectGitStatusEntries(repos: readonly RepositoryReviewSnapshot[]): GitStatusForView[] {
  const out: GitStatusForView[] = [];
  for (const repo of repos) {
    if (repo.reviewLoad.status !== "available") {
      continue;
    }
    // Annotations source from the union of changedFiles and ignoredFiles:
    // `.uatu.json review.ignoreAreas` is a score policy ("don't inflate the
    // burden with generated/scaffolding files"), not a visibility policy.
    // The tree must still show that those files are changed in git, otherwise
    // a reviewer cannot tell "I committed this" from "it's still untracked".
    const allChanges = [...repo.reviewLoad.changedFiles, ...repo.reviewLoad.ignoredFiles];
    for (const change of allChanges) {
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
    for (const relativePath of repo.reviewLoad.gitIgnoredFiles) {
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
// optimistically re-render the control, push the choice to the server (which
// recomputes + rebroadcasts the burden over SSE), and refresh the active Diff
// view against the new target. Mirrors the server-session model of `setScope`.
async function applyCompareTargetChange(target: ReviewCompareTarget): Promise<void> {
  if (appState.compareTarget === target) {
    return;
  }
  appState.compareTarget = target;
  writeCompareTargetPreference(target);
  // Cached diffs were computed against the previous target.
  documentDiffCache.clear();
  // Optimistic re-render so the toggle reflects the choice immediately; the
  // burden numbers + anchor refresh when the server rebroadcasts snapshots.
  renderSidebar();
  try {
    await fetch("/api/compare-target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target }),
    });
  } catch {
    // Best-effort; the SSE broadcast or the next reload reconciles state.
  }
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
      return;
    }

    const button = target.closest<HTMLButtonElement>("button[data-review-score-repository-id]");
    if (!button) {
      return;
    }

    const repository = appState.repositories.find(candidate => candidate.id === button.dataset.reviewScoreRepositoryId);
    if (!repository || repository.reviewLoad.status !== "available") {
      return;
    }

    appState.followEnabled = false;
    appState.selectedId = null;
    appState.previewMode = { kind: "review-score", repositoryId: repository.id };
    applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));
    syncFollowToggle();
    pushReviewScore(repository.id);
    renderSidebar();
    renderReviewScoreDetails(repository);
  });
}
