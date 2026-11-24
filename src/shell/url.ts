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
import { pushCommitPreview, pushPullRequestPreview } from "./history";
import { appState, type SurfacePreviewMode } from "./state";
import { pullRequestPreviewParams, pullRequestRepository, pullRequestStore, type PullRequestPreviewParams } from "../github/pull-request-store";

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

// --- Pull request preview (`?repository=<id>&pr=<n>[&tab=files]`) ---------

type PullRequestRenderer = (mode: Extract<SurfacePreviewMode, { kind: "pull-request" }>, options?: { tab?: "conversation" | "files"; file?: string; thread?: string }) => void;

// The view (src/preview/pull-request-view.ts) registers itself when app.ts
// loads it. A static import from here would pull the whole PR view into
// shell/events.ts's import cycle and reorder module evaluation (TDZ).
let renderPullRequestPreview: PullRequestRenderer = () => undefined;

export function registerPullRequestPreviewRenderer(renderer: PullRequestRenderer): void {
  renderPullRequestPreview = renderer;
}

export type { PullRequestPreviewParams };

export function pullRequestPreviewParamsFromUrl(): PullRequestPreviewParams | null {
  const url = new URL(window.location.href);
  if (appPathname(url.pathname) !== "/") return null;
  return pullRequestPreviewParams(url.searchParams, pullRequestRepository(appState.repositories)?.id ?? null);
}


// Opening a pull request's preview also makes it the workspace's current pull
// request (the branch's own, or a picked one), so the URL restores the pick on
// reload and Back/Forward.
export function activatePullRequestPreview(params: PullRequestPreviewParams, options: { pushHistory: boolean }) {
  setFollowEnabled(false);
  setSelectedId(null);
  setPreviewMode({ kind: "pull-request", repositoryId: params.repositoryId, number: params.number });
  pullRequestStore.select(params.number);
  syncFollowToggle();
  if (options.pushHistory) pushPullRequestPreview(params.repositoryId, params.number, params.tab, { file: params.file, thread: params.thread });
  renderSidebar();
  renderPullRequestPreview(appState.previewMode as Extract<SurfacePreviewMode, { kind: "pull-request" }>, { tab: params.tab, file: params.file, thread: params.thread });
}

// The one re-render entry for URL-addressed previews, used when document
// state changes underneath them. The pull request view keeps its DOM (and any
// draft in its composers) when it is already showing the same target.
export function renderSurfacePreview(mode: SurfacePreviewMode) {
  if (mode.kind === "commit") renderCommitPreview(mode);
  // The URL keeps the open tab (replaced in place on every switch).
  else {
    const params = pullRequestPreviewParamsFromUrl();
    renderPullRequestPreview(mode, { tab: params?.tab, file: params?.file, thread: params?.thread });
  }
}
