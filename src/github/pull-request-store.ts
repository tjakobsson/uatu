// The page's one view of GitHub pull request data: the summary for the
// active repository and the details loaded so far. The Pull request pane
// (src/sidebar/pull-request-pane.ts) and the PR preview
// (src/preview/pull-request-view.ts) both read it and re-render on change,
// so a write made in one surface shows in the other without a second fetch.
//
// Refresh policy (design D6): event-driven, with no timer. The summary is read
// when the repository's branch or HEAD changes, when a pull request view
// opens, when the window gets focus or the page becomes visible again (at
// most once per FOCUS_REFRESH_MS), and on manual refresh or Retry; each
// write answers the pull request's fresh detail. The pull requests on screen
// (`watch`) are re-read with it. Never on file-content events.

import type { GithubSummary, PullRequestDetail, PullRequestList, PullRequestRevision } from "../shared/github-contract";
import type { RepositorySnapshot } from "../shared/types";
import { githubApi, GithubRequestError } from "./client";

// The outcome of the last Retry while GitHub was stale.
export type RetryState =
  | { status: "running" }
  | { status: "done"; at: number; recovered: boolean };

export type PullRequestStoreState = {
  repositoryId: string | null;
  // Branch facts of the repository, for "No pull request for <branch>".
  branch: string | null;
  // False once the session answered 404: GitHub is not enabled here.
  enabled: boolean | null;
  summary: GithubSummary | null;
  loading: boolean;
  error: string | null;
  retry: RetryState | null;
};

type Listener = () => void;

// The pull request the workspace shows: one picked from the open pull
// requests, or (with no pick) the checked-out branch's own. Picking the
// branch's own is the same as no pick, so a scoped number is always some
// other pull request.
export function scopedPullRequestNumber(selected: number | null, branchNumber: number | null): number | null {
  return selected !== null && selected !== branchNumber ? selected : null;
}

// Focus and visibility changes come in bursts (switching windows, a tab
// coming back): they refresh at most this often.
// The workspace's pull request repository: its first Git repository, unless
// the page chose another of its Git repositories (`chosen`: the switcher's
// repository selector, or a pull request URL naming one). The pull request
// URL (`?pr=<n>`) leaves the first one out; it names any other.
export function pullRequestRepository<T extends { id: string; metadata: { status: string } }>(repositories: readonly T[], chosen: string | null = null): T | null {
  const git = repositories.filter(candidate => candidate.metadata.status === "git");
  return (chosen === null ? undefined : git.find(candidate => candidate.id === chosen)) ?? git[0] ?? null;
}

// One of the workspace's Git repositories, as the repository selector names
// it: the GitHub repository (`owner/name`) once a summary has said it, else
// its local label.
export type PullRequestRepositoryOption = { id: string; label: string; github: string | null };

export type PullRequestPreviewParams = {
  repositoryId: string;
  number: number;
  // "file" is the pull request file view (`path=`), a changed or unchanged
  // file at the pull request's head (or its base, `rev=base`).
  tab?: "conversation" | "files" | "file";
  // A file to scroll to on Files changed, or a review thread to scroll to
  // and focus there (it wins over a file).
  file?: string;
  thread?: string;
  path?: string;
  rev?: PullRequestRevision;
};

// `?pr=<n>` names a pull request of the workspace's pull request repository
// (`defaultRepositoryId`); `repository=<id>` may name it outright, as older
// URLs and the commit preview's do. Null without a usable number, or with no
// repository to read it from. `path=` opens the file view (and wins over a
// `tab=`).
export function pullRequestPreviewParams(params: URLSearchParams, defaultRepositoryId: string | null): PullRequestPreviewParams | null {
  const named = params.get("repository");
  const repositoryId = named && named.trim() ? named : defaultRepositoryId;
  const pr = params.get("pr");
  if (!repositoryId || !pr || !/^\d{1,9}$/.test(pr) || Number(pr) < 1) return null;
  const path = params.get("path");
  if (path && path.trim() && path.length <= 4096) {
    return { repositoryId, number: Number(pr), tab: "file", path, rev: params.get("rev") === "base" ? "base" : "head" };
  }
  const tab = params.get("tab") === "files" ? "files" : "conversation";
  const file = tab === "files" ? params.get("file") ?? undefined : undefined;
  const thread = tab === "files" ? params.get("thread") ?? undefined : undefined;
  return { repositoryId, number: Number(pr), tab, ...(file ? { file } : {}), ...(thread ? { thread } : {}) };
}

export const FOCUS_REFRESH_MS = 15_000;

// A finished Retry's outcome describes the availability state it ran in
// ("the rate limit still holds"): once GitHub's status changes (another
// outage, a recovery), it no longer does, so it goes. A Retry still running
// keeps going; its own answer replaces it.
export function retryAfterSummary(retry: RetryState | null, previous: GithubSummary["status"] | null, next: GithubSummary["status"]): RetryState | null {
  if (!retry || retry.status === "running") return retry;
  return previous === next ? retry : null;
}

export class PullRequestStore {
  state: PullRequestStoreState = { repositoryId: null, branch: null, enabled: null, summary: null, loading: false, error: null, retry: null };
  private readonly details = new Map<number, PullRequestDetail>();
  // The viewer's pending comment counts from the last open-PR list, for the
  // pull requests whose detail this page hasn't read.
  private readonly listedPending = new Map<number, number>();
  // The last pending count each summary reported for its pull request: kept
  // when a later summary no longer names it (no pull request for the branch,
  // no credential), so the reminder stays where the count is known.
  private readonly knownPending = new Map<number, number>();
  // Page-local: the URL's `?pr=` restores it on reload and Back/Forward.
  private selected: number | null = null;
  private readonly listeners = new Set<Listener>();
  private repositoryKey = "";
  // Page-local: the Git repository chosen in the switcher (or by a pull
  // request URL), and the snapshots it is chosen from.
  private chosenRepositoryId: string | null = null;
  private snapshots: readonly RepositorySnapshot[] = [];
  // The GitHub repository (`owner/name`) each local repository's summary or
  // list named.
  private readonly githubNames = new Map<string, string>();
  private generation = 0;
  // Pull requests on screen, by who shows them (the PR view, the pane's
  // picked PR): re-read on focus and Retry.
  private readonly watched = new Map<string, number>();
  private lastRefreshAt = 0;
  private returnListening = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  detail(number: number): PullRequestDetail | null {
    return this.details.get(number) ?? null;
  }

  // The checked-out branch's pull request number, when it has one.
  branchNumber(): number | null {
    return this.state.summary?.pullRequest?.number ?? null;
  }

  // A pull request other than the branch's own that the workspace shows.
  // Undecided (null) until the summary says which PR is the branch's own, or
  // that it has none, so a reload on the branch's PR never flashes it as a
  // picked one.
  scopedNumber(): number | null {
    const summary = this.state.summary;
    // Without an answer about the branch (no credential, GitHub down with no
    // last result) a `?pr=` URL is just a preview, not a pick.
    if (!summary || (!summary.pullRequest && summary.status !== "no-pull-request")) return null;
    const scoped = scopedPullRequestNumber(this.selected, this.branchNumber());
    // A pull request whose head is the checked-out branch is the branch's
    // own even when the summary no longer names it (a reload after it left
    // the summary): never a pick.
    const head = scoped === null ? undefined : this.details.get(scoped)?.summary;
    if (head && !head.isCrossRepository && head.headRefName === this.state.branch) return null;
    return scoped;
  }

  // What the Pull request pane shows: the scoped pull request, else the
  // branch's own.
  currentNumber(): number | null {
    return this.scopedNumber() ?? this.branchNumber();
  }

  // Null (or the branch's own number) returns to the branch's pull request.
  select(number: number | null): void {
    const next = scopedPullRequestNumber(number, this.branchNumber());
    if (next === this.selected) return;
    this.selected = next;
    this.emit();
  }

  // Called with the repository snapshots on every sidebar render. Fetches
  // only when the active repository, its branch or its HEAD changed.
  syncRepositories(repositories: readonly RepositorySnapshot[]): void {
    this.snapshots = repositories;
    const repository = pullRequestRepository(repositories, this.chosenRepositoryId);
    const key = repository ? `${repository.id}\n${repository.metadata.branch ?? ""}\n${repository.metadata.commitShort ?? ""}` : "";
    if (key === this.repositoryKey) return;
    const previousRepositoryId = this.state.repositoryId;
    const repositoryChanged = (repository?.id ?? null) !== previousRepositoryId;
    this.repositoryKey = key;
    this.state = { ...this.state, repositoryId: repository?.id ?? null, branch: repository?.metadata.branch ?? null };
    if (repositoryChanged) {
      this.details.clear();
      this.knownPending.clear();
      // The first snapshot keeps a pick the URL made during boot.
      if (previousRepositoryId !== null) this.selected = null;
      this.state = { ...this.state, summary: null, enabled: null, error: null };
    }
    this.listenForReturn();
    void this.refresh(false);
  }

  // The workspace's Git repositories, the first being the default pull
  // request repository. More than one makes the switcher's Pull requests
  // heading a repository selector.
  repositories(): PullRequestRepositoryOption[] {
    return this.snapshots.filter(repository => repository.metadata.status === "git")
      .map(repository => ({ id: repository.id, label: repository.label, github: this.githubNames.get(repository.id) ?? null }));
  }

  // The GitHub repository (`owner/name`) a local repository's data named.
  githubName(repositoryId: string | null): string | null {
    return repositoryId === null ? null : this.githubNames.get(repositoryId) ?? null;
  }

  // The checkout the page works in, where the terminal and agent run: the
  // workspace's first Git repository and its branch, whichever repository
  // the pull requests are picked from. Null before the snapshots arrive.
  workingRepository(): { id: string; label: string; branch: string | null; github: string | null } | null {
    const first = pullRequestRepository(this.snapshots);
    return first ? { id: first.id, label: first.label, branch: first.metadata.branch ?? null, github: this.githubNames.get(first.id) ?? null } : null;
  }

  // Whether the pull request repository is another than the workspace's
  // first: the status card names it beside a viewed pull request then.
  otherRepositoryChosen(): boolean {
    const first = pullRequestRepository(this.snapshots);
    return first !== null && this.state.repositoryId !== null && this.state.repositoryId !== first.id;
  }

  // Makes another of the workspace's Git repositories the pull request
  // repository (page-local). Before the snapshots arrive it waits for them;
  // an id that names none of them changes nothing.
  chooseRepository(repositoryId: string): void {
    if (repositoryId === this.chosenRepositoryId) return;
    if (this.snapshots.length > 0 && !this.repositories().some(repository => repository.id === repositoryId)) return;
    this.chosenRepositoryId = repositoryId;
    if (this.snapshots.length > 0) this.syncRepositories(this.snapshots);
  }

  // A surface shows (or, with null, stops showing) a pull request.
  watch(key: string, number: number | null): void {
    if (number === null) this.watched.delete(key);
    else this.watched.set(key, number);
  }

  // The viewer's pending review comments on pull requests other than
  // `except`, from the details read so far and the last open-PR list.
  pendingElsewhere(except: readonly (number | null)[]): { number: number; count: number }[] {
    const counts = new Map([...this.knownPending, ...this.listedPending]);
    for (const [number, detail] of this.details) counts.set(number, detail.pendingReview?.comments.length ?? 0);
    const branch = this.state.summary?.pullRequest;
    if (branch) counts.set(branch.number, branch.viewerPendingComments);
    return [...counts].filter(([number, count]) => count > 0 && !except.includes(number))
      .map(([number, count]) => ({ number, count })).sort((a, b) => a.number - b.number);
  }

  // The viewer's pending comment count on one pull request, when known.
  pendingCount(number: number): number {
    return this.details.get(number)?.pendingReview?.comments.length ?? this.listedPending.get(number) ?? 0;
  }

  applyList(list: PullRequestList): void {
    if (this.state.repositoryId) this.githubNames.set(this.state.repositoryId, `${list.repository.owner}/${list.repository.name}`);
    this.listedPending.clear();
    for (const item of list.pullRequests) this.listedPending.set(item.number, item.viewerPendingComments);
    this.emit();
  }

  // Retry from a stale notice: a manual refresh of the summary and of the
  // pull requests on screen, with its outcome kept for the notices to say.
  async retry(): Promise<void> {
    if (this.state.retry?.status === "running") return;
    this.state = { ...this.state, retry: { status: "running" } };
    this.emit();
    await this.refresh(true);
    await this.reloadWatched();
    const recovered = !this.state.summary?.stale && !this.state.error;
    this.state = { ...this.state, retry: { status: "done", at: Date.now(), recovered } };
    this.emit();
  }

  async refresh(manual: boolean): Promise<void> {
    const repositoryId = this.state.repositoryId;
    if (!repositoryId) {
      this.emit();
      return;
    }
    this.lastRefreshAt = Date.now();
    const generation = ++this.generation;
    this.state = { ...this.state, loading: true };
    this.emit();
    try {
      const summary = manual ? await githubApi.refresh(repositoryId) : await githubApi.summary(repositoryId);
      if (generation !== this.generation) return;
      this.applySummary(summary);
    } catch (error) {
      if (generation !== this.generation) return;
      const notEnabled = error instanceof GithubRequestError && error.status === 404;
      this.state = {
        ...this.state,
        enabled: notEnabled ? false : this.state.enabled,
        loading: false,
        error: notEnabled ? null : errorMessage(error),
      };
    }
    this.emit();
  }

  // A summary answer. A selection the URL made before anyone knew the
  // branch's own pull request (a reload on it) is no pick once the summary
  // names it: it stays the branch's own even if the branch later loses its
  // pull request, so only a real pick of another pull request scopes.
  applySummary(summary: GithubSummary): void {
    if (summary.pullRequest && this.selected === summary.pullRequest.number) this.selected = null;
    if (summary.pullRequest) this.knownPending.set(summary.pullRequest.number, summary.pullRequest.viewerPendingComments);
    if (summary.repository && this.state.repositoryId) this.githubNames.set(this.state.repositoryId, `${summary.repository.owner}/${summary.repository.name}`);
    const retry = retryAfterSummary(this.state.retry, this.state.summary?.status ?? null, summary.status);
    // A repository that isn't on GitHub has no pull request surfaces, as
    // when the session serves none.
    this.state = { ...this.state, enabled: summary.status !== "not-github", summary, loading: false, error: null, retry };
  }

  // `repositoryId` defaults to the active repository; a URL-addressed preview
  // passes its own, which may arrive before repository snapshots do.
  async loadDetail(number: number, repositoryId = this.state.repositoryId): Promise<PullRequestDetail> {
    if (!repositoryId) throw new GithubRequestError(404, "No repository is loaded yet.");
    const detail = await githubApi.pullRequest({ repository: repositoryId, number });
    this.details.set(number, detail);
    this.emit();
    return detail;
  }

  // A write answered with fresh detail: keep it, and refresh the summary when
  // it is the summary's pull request (pending count, reviewers, state).
  applyDetail(detail: PullRequestDetail): void {
    this.details.set(detail.summary.number, detail);
    this.knownPending.set(detail.summary.number, detail.pendingReview?.comments.length ?? 0);
    if (this.state.summary?.pullRequest?.number === detail.summary.number) {
      this.state = { ...this.state, summary: { ...this.state.summary, pullRequest: detail.summary } };
    }
    this.emit();
  }

  private async reloadWatched(): Promise<void> {
    const numbers = [...new Set(this.watched.values())];
    await Promise.all(numbers.map(number => this.loadDetail(number).catch(() => undefined)));
  }

  // Coming back to the page (window focus, the tab visible again) re-reads
  // the summary and the pull requests on screen: what changed on GitHub
  // meanwhile shows without a timer.
  private listenForReturn(): void {
    if (this.returnListening || typeof window === "undefined") return;
    this.returnListening = true;
    const onReturn = () => {
      if (document.visibilityState !== "visible" || this.state.enabled === false) return;
      if (Date.now() - this.lastRefreshAt < FOCUS_REFRESH_MS) return;
      void this.refresh(false).then(() => this.reloadWatched());
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

export const pullRequestStore = new PullRequestStore();
