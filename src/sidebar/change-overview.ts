// Change-overview pane — renders the per-repository burden score card,
// driver list, base-mode label, and the changed-file count summary used by
// the file-count chip. Extracted from `app.ts` so the sidebar feature
// folder owns the change-overview presentation in one place.

import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import type { RepositoryReviewSnapshot } from "../shared/types";
import { applyStaleHint } from "../shell/stale-hint-mount";
import { renderSidebar } from "./shell";
import { syncFollowToggle } from "../shell/follow";
import { pushReviewScore } from "../shell/history";
import { nextStaleHint } from "../shell/stale-hint";
import { appState } from "../shell/state";
import type { FilesPaneFilterMembership, GitStatusForView } from "./tree-view";
import { baseModeLabel, capitalize } from "./git-log";
import { renderReviewScoreDetails } from "./review-score-mount";

const changeOverviewElementMaybe = document.querySelector<HTMLDivElement>("#change-overview");

if (!changeOverviewElementMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/change-overview)");
}

const changeOverviewElement: HTMLDivElement = changeOverviewElementMaybe;

export function renderChangeOverview() {
  if (appState.repositories.length === 0) {
    changeOverviewElement.innerHTML = `<div class="pane-empty">Repository data is unavailable.</div>`;
    return;
  }

  changeOverviewElement.innerHTML = appState.repositories
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
      const baseLabel =
        load.base.ref && load.base.mode !== "dirty-worktree-only"
          ? `${load.base.ref} (${baseModeLabel(load.base.mode)})`
          : baseModeLabel(load.base.mode);
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
}

export function renderDriver(driver: RepositoryReviewSnapshot["reviewLoad"]["drivers"][number]): string {
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
export function primaryReviewBaseLabel(): string | null {
  for (const repo of appState.repositories) {
    if (repo.reviewLoad.status !== "available") {
      continue;
    }
    const base = repo.reviewLoad.base;
    if (base.ref) {
      return base.ref;
    }
    if (base.mode === "dirty-worktree-only") {
      return "dirty worktree";
    }
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

export function mapChangedFileStatus(raw: string): GitStatusForView["status"] | null {
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

export function initChangeOverviewClickHandler(): void {
  changeOverviewElement.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
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
