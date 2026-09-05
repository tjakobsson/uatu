// URL → app-state resolution for non-document previews (commit preview).
// Lives in `shell/` because both the boot path and the popstate handler in
// `history.ts` need to read URL parameters and turn them into preview
// activations.

import { appPathname } from "../shared/app-url";
import { deferHiddenPreview } from "../preview/deferred";
import { renderEmptyPreview } from "../preview/empty";
import { renderSidebar } from "../sidebar/shell";
import { renderCommitMessage } from "../preview/commit-message";
import { syncFollowToggle } from "./follow";
import type { RepositorySnapshot } from "../shared/types";
import { pushCommitPreview } from "./history";
import { appState } from "./state";
import { setPreviewMode, setSelectedId } from "./selection";
import { setFollowEnabled } from "./follow";

export type CommitPreviewParams = { repositoryId: string; sha: string };
export type CommitPreviewResolution =
  | {
      kind: "found";
      repository: RepositorySnapshot;
      commit: RepositorySnapshot["commitLog"][number];
    }
  | { kind: "missing-repository"; repositoryId: string; sha: string }
  | { kind: "missing-commit"; repository: RepositorySnapshot; sha: string };

export function commitPreviewParamsFromUrl(): CommitPreviewParams | null {
  const url = new URL(window.location.href);
  if (appPathname(url.pathname) !== "/") {
    return null;
  }

  const repositoryId = url.searchParams.get("repository");
  const sha = url.searchParams.get("commit");
  if (!repositoryId || !repositoryId.trim() || !sha || !sha.trim()) {
    return null;
  }

  return { repositoryId, sha };
}

function resolveCommitPreview(params: CommitPreviewParams): CommitPreviewResolution {
  const repository = appState.repositories.find(candidate => candidate.id === params.repositoryId);
  if (!repository) {
    return { repositoryId: params.repositoryId, sha: params.sha, kind: "missing-repository" };
  }

  const commit = repository.commitLog.find(candidate => candidate.sha === params.sha);
  if (!commit) {
    return { kind: "missing-commit", repository, sha: params.sha };
  }

  return { kind: "found", repository, commit };
}

export function activateCommitPreview(params: CommitPreviewParams, options: { pushHistory: boolean }) {
  setFollowEnabled(false);
  setSelectedId(null);
  setPreviewMode({ kind: "commit", ...params });
  syncFollowToggle();
  if (options.pushHistory) {
    pushCommitPreview(params.repositoryId, params.sha);
  }
  renderSidebar();
  renderCommitPreview(params);
}

export function renderCommitPreview(params: CommitPreviewParams) {
  if (deferHiddenPreview(() => {
    if (appState.previewMode.kind === "commit") renderCommitPreview(appState.previewMode);
  })) return;
  const resolved = resolveCommitPreview(params);
  if (resolved.kind === "found") {
    renderCommitMessage(resolved.repository, resolved.commit);
    return;
  }

  renderCommitPreviewUnavailable(resolved);
}

function renderCommitPreviewUnavailable(resolved: Exclude<CommitPreviewResolution, { kind: "found" }>) {
  if (resolved.kind === "missing-repository") {
    renderEmptyPreview(
      "Commit preview unavailable",
      `Repository data is not available for commit ${resolved.sha}.`,
    );
    return;
  }

  renderEmptyPreview(
    "Commit preview unavailable",
    `Commit ${resolved.sha} is not available in the current Git Log data for ${resolved.repository.label}.`,
  );
}
