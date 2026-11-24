// The real GithubService: GitHub through `gh api` (src/github/gh.ts), one
// narrow adapter per call (src/github/ops/), for the repositories of this
// session. Identity is derived server-side from Git (src/github/remote.ts);
// clients name a repository id and a pull request number only.
//
// Refresh (design D6) is driven by requests, never by a timer: the browser
// asks on branch/HEAD changes, view opens, focus (throttled) and Retry, and
// each write answers fresh detail. Here:
// - one in-flight summary per repository; concurrent asks share it;
// - a summary younger than SUMMARY_MIN_INTERVAL_MS for the same branch facts
//   is answered from memory (several tabs, focus bursts);
// - detection (branch → pull request number) reruns only when the branch,
//   HEAD, upstream or base repository changes;
// - `unavailable` backs off exponentially, capped at BACKOFF_MAX_MS;
// - `rate-limited` stops every request to that host until GitHub's reset
//   time, except a manual refresh (Retry), which also lets the reads right
//   after it through once (MANUAL_BYPASS_MS);
// - nothing here starts a request on its own, and the file observer has no
//   path to this module.
//
// Writes need the `full` setting, re-read their preconditions from GitHub
// first (head, state, pending review), and run one at a time per pull
// request.
//
// The file view reads from Git (src/document/git-objects.ts), never from
// GitHub's contents API: a commit that is local (the checkout's own branch,
// or the private ref the narrow fetch writes) is read with `cat-file` and
// `ls-tree`; one that isn't answers `not-fetched`, and only the reviewer's
// Fetch (src/document/pull-request-refs.ts) makes it local. The branch's own
// pull request usually needs no fetch: its head is the checkout's.
//
// A summary with an open pull request for the checked-out branch also sets
// that repository's pull request base (src/document/pull-request-base.ts),
// which base resolution reads (D7); a change of association or base makes
// the session collect Git data again.

import {
  failureMessage,
  GitHubFailure,
  httpStatusForFailure,
  statusForFailure,
} from "./classify";
import { GitHubApi } from "./api";
import { GithubError } from "./error";
import { PULL_REQUEST_CONVERSATION, parseConversation } from "./ops/conversation";
import { FILES_PAGE_LIMIT, filesPath, parseFilesPage, PATCH_BYTES_LIMIT, PULL_REQUEST_FILES } from "./ops/files";
import { OPEN_PULL_REQUESTS, parseOpenPullRequests } from "./ops/list";
import {
  ADD_COMMENT,
  ADD_REVIEW,
  ADD_REVIEW_THREAD,
  DELETE_PENDING_COMMENT,
  DISCARD_REVIEW,
  EDIT_PENDING_COMMENT,
  parseWritePrecondition,
  REPLY_TO_THREAD,
  RESOLVE_THREAD,
  SUBMIT_REVIEW,
  UNRESOLVE_THREAD,
  WRITE_PRECONDITION,
  type WritePrecondition,
} from "./ops/mutations";
import { ParseNotes } from "./ops/parse";
import { checkoutReview } from "./anchoring";
import { commitPresent, listTree, readBlob } from "../document/git-objects";
import { pullRequestRefsFetched, setPullRequestBase } from "../document/pull-request-base";
import { fetchPullRequestRefs, prunePullRequestRefs } from "../document/pull-request-refs";
import { DETECT_PULL_REQUEST, parsePullRequestSummary, pickDetected, PULL_REQUEST_SUMMARY } from "./ops/summary";
import { parseThreads, PULL_REQUEST_THREADS, type ParsedThreads } from "./ops/threads";
import {
  baseRemoteName,
  detectionInput,
  detectionKey,
  isAlwaysGithubHost,
  parseRemoteUrl,
  readRepositoryGitFacts,
  type RemoteRepository,
  type RepositoryGitFacts,
} from "./remote";
import type {
  GithubService,
  NewThreadInput,
  PullRequestBlob,
  PullRequestCommits,
  PullRequestReviewContext,
  PullRequestTreeAnswer,
  SubmitReviewInput,
} from "./service";
import {
  GITHUB_BODY_MAX_LENGTH,
  type GithubRepositoryRef,
  type GithubSummary,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestList,
  type PullRequestSummary,
} from "../shared/github-contract";

export type GithubWriteMode = "read" | "full";

export const SUMMARY_MIN_INTERVAL_MS = 5_000;
export const LIST_CACHE_MS = 30_000;
// What `pullRequestTree` lists at most (the route shows 50,000 after the
// exposure filter; reading one more says the list stops there).
const PULL_REQUEST_TREE_READ_LIMIT = 50_001;
export const BACKOFF_BASE_MS = 15_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
export const MANUAL_BYPASS_MS = 15_000;
// The largest blob the file view's routes read into memory. The rendered
// views stop at 1 MB (src/github/http.ts); images may be larger.
export const BLOB_READ_LIMIT = 20 * 1024 * 1024;

export type GhGithubServiceOptions = {
  api: GitHubApi;
  mode: GithubWriteMode;
  // The session's repository id → its root on disk (null: not this session's).
  repositoryRoot: (repositoryId: string) => string | null;
  // The Hub projects the credential's host here; it counts as GitHub.
  ghHost?: string;
  readGitFacts?: (root: string) => Promise<RepositoryGitFacts | null>;
  // The environment the narrow fetch runs Git in: the session's own (its
  // projected Git credentials). Tests pass a clean one.
  gitEnv?: Record<string, string | undefined>;
  fetchTimeoutMs?: number;
  now?: () => number;
  // The child log. Gets the operation, failure class and GitHub's error type,
  // never a body, token or stderr.
  log?: (line: string) => void;
};

type Context = { root: string; facts: RepositoryGitFacts; base: RemoteRepository; key: string; upstream: GithubRepositoryRef | null };

// A pull request's commits as last read (summary or detail), for the file
// view and anchoring without asking GitHub again.
type KnownCommits = { headOid: string; baseOid: string; baseRefName: string; state: string };

type RepositoryState = {
  key: string | null;
  detectedKey: string | null;
  number: number | null;
  viewer: string | null;
  summary: GithubSummary | null;
  // The last answer GitHub gave, for stale data while it can't be asked.
  lastGood: { at: number; key: string; pullRequest?: PullRequestSummary } | null;
  queriedAt: number;
  inflight: Promise<GithubSummary> | null;
  failures: number;
  nextAttemptAt: number;
  bypassUntil: number;
  details: Map<number, PullRequestDetail>;
  files: Map<string, { files: PullRequestFile[]; truncated: boolean }>;
  list: { at: number; value: PullRequestList } | null;
  writing: Set<number>;
  commits: Map<number, KnownCommits>;
  fetching: Map<number, Promise<{ headOid: string }>>;
};

function newState(): RepositoryState {
  return {
    key: null, detectedKey: null, number: null, viewer: null, summary: null, lastGood: null, queriedAt: 0, inflight: null,
    failures: 0, nextAttemptAt: 0, bypassUntil: 0, details: new Map(), files: new Map(), list: null, writing: new Set(),
    commits: new Map(), fetching: new Map(),
  };
}

const FILES_CACHE_LIMIT = 20;

export class GhGithubService implements GithubService {
  readonly mock = false;
  private readonly states = new Map<string, RepositoryState>();
  // host → when its rate limit lifts.
  private readonly hostLimits = new Map<string, number>();
  private readonly now: () => number;
  private readonly readGitFacts: (root: string) => Promise<RepositoryGitFacts | null>;
  private readonly log: (line: string) => void;

  constructor(private readonly options: GhGithubServiceOptions) {
    this.now = options.now ?? Date.now;
    this.readGitFacts = options.readGitFacts ?? readRepositoryGitFacts;
    this.log = options.log ?? (line => console.warn(`[github] ${line}`));
  }

  dispose(): void {
    this.options.api.transport.dispose?.();
  }

  // --- summary -------------------------------------------------------------

  summary(repositoryId: string): Promise<GithubSummary> {
    return this.readSummary(repositoryId, false);
  }

  refresh(repositoryId: string): Promise<GithubSummary> {
    const state = this.state(repositoryId);
    state.bypassUntil = this.now() + MANUAL_BYPASS_MS;
    state.list = null;
    return this.readSummary(repositoryId, true);
  }

  private async readSummary(repositoryId: string, manual: boolean): Promise<GithubSummary> {
    const state = this.state(repositoryId);
    const context = await this.context(repositoryId);
    if (!context) return this.notGithub(state, this.options.repositoryRoot(repositoryId)!);
    const now = this.now();
    if (state.inflight && state.key === context.key) return state.inflight;
    if (!manual) {
      const limit = this.hostLimits.get(context.base.host) ?? 0;
      if (limit > now) return this.limitedSummary(state, context, limit);
      const sameFacts = state.key === context.key && state.summary !== null;
      if (sameFacts && (state.nextAttemptAt > now || now - state.queriedAt < SUMMARY_MIN_INTERVAL_MS)) return state.summary!;
    }
    state.key = context.key;
    const run = this.querySummary(state, context).finally(() => {
      if (state.inflight === run) state.inflight = null;
    });
    state.inflight = run;
    return run;
  }

  private async querySummary(state: RepositoryState, context: Context): Promise<GithubSummary> {
    const { base } = context;
    const repository = { host: base.host, owner: base.owner, name: base.name };
    const variables = { owner: base.owner, name: base.name };
    state.queriedAt = this.now();
    try {
      if (state.detectedKey !== context.key) {
        const input = detectionInput(context.facts, base, context.upstream);
        if (input.kind === "detached") {
          state.number = null;
        } else if (input.kind === "number") {
          state.number = input.number;
        } else {
          const answer = await this.options.api.graphql(base.host, DETECT_PULL_REQUEST, { ...variables, head: input.headRefName });
          const detected = pickDetected(answer.data, input.headOwner);
          if (!detected.repositoryFound) throw new GitHubFailure("not-found", `${base.owner}/${base.name} wasn't found on ${base.host}.`);
          state.viewer = detected.viewer;
          state.number = detected.number;
        }
        state.detectedKey = context.key;
      }
      let pullRequest: PullRequestSummary | undefined;
      if (state.number !== null) {
        const answer = await this.options.api.graphql(base.host, PULL_REQUEST_SUMMARY, { ...variables, number: state.number });
        const root = answer.data as Record<string, unknown>;
        const repositoryNode = root.repository as Record<string, unknown> | null;
        if (!repositoryNode) throw new GitHubFailure("not-found", `${base.owner}/${base.name} wasn't found on ${base.host}.`);
        state.viewer = typeof (root.viewer as { login?: unknown } | null)?.login === "string" ? (root.viewer as { login: string }).login : state.viewer;
        const node = repositoryNode.pullRequest as Record<string, unknown> | null;
        if (node) pullRequest = parsePullRequestSummary(node, new ParseNotes(), PULL_REQUEST_SUMMARY.name).summary;
      }
      const at = this.now();
      state.failures = 0;
      state.nextAttemptAt = 0;
      state.lastGood = { at, key: context.key, ...(pullRequest ? { pullRequest } : {}) };
      if (pullRequest) this.noteCommits(state, pullRequest);
      this.setBase(context, pullRequest);
      state.summary = {
        status: pullRequest ? "ready" : "no-pull-request",
        mock: false,
        repository,
        viewer: state.viewer,
        checkedAt: at,
        stale: false,
        ...(pullRequest ? { pullRequest } : context.facts.detached ? { message: "No branch is checked out (detached HEAD)." } : {}),
        ...this.modeFields(),
      };
      return state.summary;
    } catch (error) {
      const failure = this.asFailure(error, "summary");
      // Detect again next time unless GitHub only couldn't be asked.
      if (statusForFailure(failure) !== "rate-limited" && statusForFailure(failure) !== "unavailable") state.detectedKey = null;
      state.summary = this.failedSummary(state, context, failure);
      // A stale answer keeps the base it had; any other refusal drops it.
      this.setBase(context, state.summary.stale ? state.summary.pullRequest : undefined);
      return state.summary;
    }
  }

  private failedSummary(state: RepositoryState, context: Context, failure: GitHubFailure): GithubSummary {
    const status = statusForFailure(failure);
    const now = this.now();
    if (status === "rate-limited") this.hostLimits.set(context.base.host, failure.retryAt ?? now + 60_000);
    if (status === "unavailable") {
      state.failures += 1;
      state.nextAttemptAt = now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.failures - 1));
    }
    const keepLast = (status === "rate-limited" || status === "unavailable") && state.lastGood?.key === context.key;
    const pullRequest = keepLast ? state.lastGood?.pullRequest : undefined;
    return {
      status,
      mock: false,
      repository: { host: context.base.host, owner: context.base.owner, name: context.base.name },
      viewer: status === "no-credential" || status === "gh-missing" ? null : state.viewer,
      checkedAt: state.lastGood?.at ?? now,
      stale: pullRequest !== undefined,
      ...(status === "rate-limited" ? { retryAt: failure.retryAt ?? now + 60_000 } : {}),
      message: failureMessage(failure, context.base.host, now),
      ...(pullRequest ? { pullRequest } : {}),
      ...this.modeFields(),
    };
  }

  private limitedSummary(state: RepositoryState, context: Context, retryAt: number): GithubSummary {
    const keep = state.lastGood?.key === context.key ? state.lastGood?.pullRequest : undefined;
    return {
      status: "rate-limited",
      mock: false,
      repository: { host: context.base.host, owner: context.base.owner, name: context.base.name },
      viewer: state.viewer,
      checkedAt: state.lastGood?.at ?? this.now(),
      stale: keep !== undefined,
      retryAt,
      message: failureMessage(new GitHubFailure("rate-limited", "", { retryAt }), context.base.host, this.now()),
      ...(keep ? { pullRequest: keep } : {}),
      ...this.modeFields(),
    };
  }

  private notGithub(state: RepositoryState, root: string): GithubSummary {
    setPullRequestBase(root, null);
    state.summary = { status: "not-github", mock: false, repository: null, viewer: null, checkedAt: this.now(), stale: false, ...this.modeFields() };
    return state.summary;
  }

  private modeFields(): { readOnly?: true } {
    return this.options.mode === "read" ? { readOnly: true } : {};
  }

  // --- detail ----------------------------------------------------------------

  async pullRequest(repositoryId: string, number: number): Promise<PullRequestDetail> {
    const context = await this.requireContext(repositoryId);
    const state = this.state(repositoryId);
    const cached = state.details.get(number);
    const gate = this.readGate(state, context);
    if (gate) {
      if (cached) return cached;
      throw gate;
    }
    try {
      return await this.readDetail(state, context, number);
    } catch (error) {
      if (error instanceof GithubError) throw error;
      const failure = this.asFailure(error, "pull request");
      this.noteFailure(state, context, failure);
      if (cached && (failure.kind === "rate-limited" || failure.kind === "unavailable" || failure.kind === "timeout")) return cached;
      throw this.githubError(failure, context);
    }
  }

  private async readDetail(state: RepositoryState, context: Context, number: number): Promise<PullRequestDetail> {
    const { base } = context;
    const variables = { owner: base.owner, name: base.name, number };
    const notes = new ParseNotes();
    const [conversationAnswer, threadsAnswer] = await Promise.allSettled([
      this.options.api.graphql(base.host, PULL_REQUEST_CONVERSATION, variables),
      this.options.api.graphql(base.host, PULL_REQUEST_THREADS, variables),
    ]);
    if (conversationAnswer.status === "rejected") throw conversationAnswer.reason;
    const conversation = parseConversation(conversationAnswer.value.data, notes);
    if (!conversation) {
      const refused = this.options.api.sectionFailure(conversationAnswer.value, ["repository"]);
      if (refused && refused.kind !== "not-found") throw refused;
      const repositoryMissing = !(conversationAnswer.value.data as { repository?: unknown }).repository;
      throw new GithubError(404, repositoryMissing ? `${base.owner}/${base.name} wasn't found on ${base.host}.` : `There's no pull request #${number} in ${base.owner}/${base.name}.`);
    }
    const unavailable: string[] = [];
    if (this.options.api.sectionFailure(conversationAnswer.value, ["repository", "pullRequest", "lastCommit"])) unavailable.push("checks");
    const url = conversation.parsed.summary.url;
    let threads: ParsedThreads = { threads: [], pendingReview: null, threadsByReview: new Map(), truncated: false };
    if (threadsAnswer.status === "fulfilled") {
      threads = parseThreads(threadsAnswer.value.data, notes, url) ?? threads;
      const threadsFailed = this.options.api.sectionFailure(threadsAnswer.value, ["repository", "pullRequest", "reviewThreads"])
        ?? this.options.api.sectionFailure(threadsAnswer.value, ["repository", "pullRequest", "pendingReviews"]);
      if (threadsFailed) unavailable.push("threads");
    } else {
      const failure = this.asFailure(threadsAnswer.reason, "threads");
      if (failure.kind === "rate-limited") throw failure;
      unavailable.push("threads");
    }
    let files: { files: PullRequestFile[]; truncated: boolean } = { files: [], truncated: false };
    try {
      files = await this.filesAt(context, number, conversation.parsed.summary.headRefOid, conversation.parsed.summary.changedFiles, state);
    } catch (error) {
      const failure = this.asFailure(error, "files");
      if (failure.kind === "rate-limited") throw failure;
      unavailable.push("files");
    }
    state.viewer = conversation.viewer;
    const timeline = conversation.timeline.map(item => item.kind === "review" ? { ...item, threadIds: threads.threadsByReview.get(item.id) ?? [] } : item);
    const detail: PullRequestDetail = {
      mock: false,
      repository: { host: base.host, owner: base.owner, name: base.name },
      viewer: conversation.viewer,
      summary: { ...conversation.parsed.summary, viewerPendingComments: threads.pendingReview?.comments.length ?? conversation.parsed.summary.viewerPendingComments },
      body: conversation.body,
      bodyHtml: conversation.bodyHtml,
      timeline,
      threads: threads.threads,
      pendingReview: threads.pendingReview,
      files: files.files,
      mergeReadiness: conversation.readiness,
      omitted: { timeline: conversation.omitted, threads: threads.truncated, files: files.truncated, unavailable },
    };
    state.details.set(number, detail);
    this.noteCommits(state, detail.summary);
    if (notes.notes.length) this.log(`parsed #${number} with notes: ${notes.notes.slice(0, 10).join("; ")}`);
    return detail;
  }

  // Changed files at one head commit: read once per push.
  private async filesAt(context: Context, number: number, headOid: string, changedFiles: number, state: RepositoryState): Promise<{ files: PullRequestFile[]; truncated: boolean }> {
    const key = `${number}@${headOid}`;
    const cached = state.files.get(key);
    if (cached) return cached;
    const { base } = context;
    const files: PullRequestFile[] = [];
    let budget = PATCH_BYTES_LIMIT;
    let truncated = false;
    for (let page = 1; page <= FILES_PAGE_LIMIT; page += 1) {
      const answer = await this.options.api.rest<unknown>(base.host, PULL_REQUEST_FILES, filesPath(base.owner, base.name, number, page));
      const parsed = parseFilesPage(answer.json, budget, new ParseNotes());
      files.push(...parsed.files);
      budget -= parsed.patchBytes;
      if (parsed.patchesDropped) truncated = true;
      if (!parsed.full) break;
      if (page === FILES_PAGE_LIMIT) truncated = true;
    }
    if (changedFiles > files.length) truncated = true;
    const value = { files, truncated };
    state.files.set(key, value);
    if (state.files.size > FILES_CACHE_LIMIT) state.files.delete(state.files.keys().next().value!);
    return value;
  }

  // --- list ------------------------------------------------------------------

  async pullRequests(repositoryId: string): Promise<PullRequestList> {
    const context = await this.requireContext(repositoryId);
    const state = this.state(repositoryId);
    const now = this.now();
    if (state.list && now - state.list.at < LIST_CACHE_MS) return state.list.value;
    const gate = this.readGate(state, context);
    if (gate) {
      if (state.list) return state.list.value;
      throw gate;
    }
    try {
      const answer = await this.options.api.graphql(context.base.host, OPEN_PULL_REQUESTS, { owner: context.base.owner, name: context.base.name });
      const parsed = parseOpenPullRequests(answer.data, new ParseNotes());
      if (!parsed) throw new GithubError(404, `${context.base.owner}/${context.base.name} wasn't found on ${context.base.host}.`);
      const value: PullRequestList = {
        mock: false,
        repository: { host: context.base.host, owner: context.base.owner, name: context.base.name },
        // The base repository's local remote (D3), which a pull request
        // check-out fetches from.
        remote: context.base.remote,
        viewer: parsed.viewer,
        pullRequests: parsed.items,
        totalCount: parsed.totalCount,
      };
      state.list = { at: this.now(), value };
      return value;
    } catch (error) {
      if (error instanceof GithubError) throw error;
      const failure = this.asFailure(error, "list");
      this.noteFailure(state, context, failure);
      if (state.list && (failure.kind === "rate-limited" || failure.kind === "unavailable" || failure.kind === "timeout")) return state.list.value;
      throw this.githubError(failure, context);
    }
  }

  // --- writes ----------------------------------------------------------------

  addComment(repositoryId: string, number: number, body: string): Promise<PullRequestDetail> {
    return this.write(repositoryId, number, {}, async (pre, context) => {
      await this.mutate(context, ADD_COMMENT, { subjectId: pre.id, body: checkedBody(body) });
    });
  }

  addReviewThread(repositoryId: string, number: number, input: NewThreadInput): Promise<PullRequestDetail> {
    return this.write(repositoryId, number, {}, async (pre, context, state) => {
      const body = checkedBody(input.body);
      if (input.headOid !== pre.headRefOid) throw new GithubError(409, "The pull request changed since this diff was loaded. Reload it before commenting.");
      if (!Number.isInteger(input.line) || input.line < 1) throw new GithubError(422, `Line ${input.line} is outside ${input.path}.`);
      const files = await this.filesAt(context, number, pre.headRefOid, 0, state);
      if (!files.truncated && !files.files.some(file => file.path === input.path)) throw new GithubError(422, `${input.path} is not part of this pull request.`);
      if (input.fromCheckout) {
        // The document Diff view showed the checkout: it must still be the
        // pull request's diff (D8), checked against the head GitHub names now.
        const review = await checkoutReview(context.root, input.path, {
          number, headOid: pre.headRefOid, paths: files.truncated ? null : new Set(files.files.map(file => file.path)),
        });
        if (!review?.exact) throw new GithubError(409, `Your checkout no longer shows #${number}'s diff of ${input.path}${review && !review.exact ? ` (${review.reason})` : ""}. Reload the diff; your comment is kept.`);
      }
      if (pre.pending && pre.pending.commitOid !== pre.headRefOid) {
        throw new GithubError(409, "Your pending review was started on an older commit. Submit or discard it first.");
      }
      const reviewId = pre.pending?.id ?? await this.startReview(context, pre);
      await this.mutate(context, ADD_REVIEW_THREAD, { pullRequestReviewId: reviewId, path: input.path, line: input.line, side: input.side, body });
    });
  }

  replyToThread(repositoryId: string, number: number, threadId: string, body: string): Promise<PullRequestDetail> {
    return this.write(repositoryId, number, {}, async (pre, context) => {
      const text = checkedBody(body);
      const reviewId = pre.pending?.id ?? await this.startReview(context, pre);
      await this.mutate(context, REPLY_TO_THREAD, { pullRequestReviewThreadId: threadId, pullRequestReviewId: reviewId, body: text });
    });
  }

  setThreadResolved(repositoryId: string, number: number, threadId: string, resolved: boolean): Promise<PullRequestDetail> {
    return this.write(repositoryId, number, {}, async (_pre, context) => {
      await this.mutate(context, resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId });
    });
  }

  editPendingComment(repositoryId: string, number: number, commentId: string, body: string): Promise<PullRequestDetail> {
    return this.write(repositoryId, number, {}, async (pre, context) => {
      const text = checkedBody(body);
      if (!pre.pending?.commentIds.includes(commentId)) throw new GithubError(404, "That pending comment no longer exists.");
      await this.mutate(context, EDIT_PENDING_COMMENT, { pullRequestReviewCommentId: commentId, body: text });
    });
  }

  deletePendingComment(repositoryId: string, number: number, commentId: string): Promise<PullRequestDetail> {
    return this.write(repositoryId, number, {}, async (pre, context) => {
      if (!pre.pending?.commentIds.includes(commentId)) throw new GithubError(404, "That pending comment no longer exists.");
      await this.mutate(context, DELETE_PENDING_COMMENT, { id: commentId });
    });
  }

  submitReview(repositoryId: string, number: number, input: SubmitReviewInput): Promise<PullRequestDetail> {
    return this.write(repositoryId, number, {}, async (pre, context) => {
      if (pre.viewer.toLowerCase() === pre.author.toLowerCase() && input.event !== "COMMENT") {
        throw new GithubError(422, "You can't approve or request changes on your own pull request.");
      }
      const body = input.body.trim() === "" ? "" : checkedBody(input.body);
      const pendingComments = pre.pending?.commentCount ?? 0;
      if (input.event === "REQUEST_CHANGES" && body === "") throw new GithubError(422, "Explain what needs to change in the summary.");
      if (input.event === "COMMENT" && body === "" && pendingComments === 0) throw new GithubError(422, "Write a summary or add a comment before submitting.");
      if (pre.pending) {
        await this.mutate(context, SUBMIT_REVIEW, { pullRequestReviewId: pre.pending.id, event: input.event, ...(body ? { body } : {}) });
      } else {
        await this.mutate(context, ADD_REVIEW, { pullRequestId: pre.id, commitOID: pre.headRefOid, event: input.event, ...(body ? { body } : {}) });
      }
    });
  }

  // GitHub deletes a pending review whatever the pull request's state.
  discardReview(repositoryId: string, number: number): Promise<PullRequestDetail> {
    return this.write(repositoryId, number, { anyState: true }, async (pre, context) => {
      if (pre.pending) await this.mutate(context, DISCARD_REVIEW, { pullRequestReviewId: pre.pending.id });
    });
  }

  // --- the file view (design D17) and anchoring (D8) ------------------------

  async pullRequestCommits(repositoryId: string, number: number): Promise<PullRequestCommits> {
    const known = await this.commitsOf(repositoryId, number);
    return { headOid: known.headOid, baseOid: known.baseOid };
  }

  async pullRequestBlob(repositoryId: string, number: number, input: { path: string; rev: "head" | "base" }): Promise<PullRequestBlob> {
    const root = this.rootOf(repositoryId);
    const known = await this.commitsOf(repositoryId, number);
    const oid = input.rev === "base" ? known.baseOid : known.headOid;
    if (!(await commitPresent(root, oid))) return { state: "not-fetched" };
    const read = await readBlob(root, oid, input.path, { maxBytes: BLOB_READ_LIMIT });
    if (read.kind === "missing") throw new GithubError(404, `${input.path} isn't in #${number} at its ${input.rev} (${oid.slice(0, 7)}).`);
    if (read.kind === "too-large") return { state: "too-large", oid, size: read.size };
    return { oid, bytes: read.bytes };
  }

  async pullRequestTree(repositoryId: string, number: number): Promise<PullRequestTreeAnswer> {
    const root = this.rootOf(repositoryId);
    const { headOid } = await this.commitsOf(repositoryId, number);
    if (!(await commitPresent(root, headOid))) return { state: "not-fetched" };
    // One over the route's cap, so it can say the list stops there.
    const tree = await listTree(root, headOid, { limit: PULL_REQUEST_TREE_READ_LIMIT });
    if (!tree) throw new GithubError(500, `#${number}'s files couldn't be listed.`);
    return { headOid, paths: tree.entries.map(entry => entry.path), truncated: tree.truncated };
  }

  // The explicit, narrow fetch (D7): only what isn't local yet, the head into
  // `refs/uatu/pull/<n>/head` and, when the base commit is missing, the base
  // branch into its remote-tracking ref. A head that is local (the branch's
  // own pull request, usually) fetches nothing. One fetch per pull request
  // at a time.
  fetchPullRequestHead(repositoryId: string, number: number): Promise<{ headOid: string }> {
    const state = this.state(repositoryId);
    const running = state.fetching.get(number);
    if (running) return running;
    const run = this.fetchHead(repositoryId, number, state).finally(() => state.fetching.delete(number));
    state.fetching.set(number, run);
    return run;
  }

  private async fetchHead(repositoryId: string, number: number, state: RepositoryState): Promise<{ headOid: string }> {
    const context = await this.requireContext(repositoryId);
    // The reviewer asked: read where the pull request is now.
    const detail = await this.pullRequest(repositoryId, number);
    const { headRefOid: headOid, baseRefOid: baseOid, baseRefName } = detail.summary;
    const [headLocal, baseLocal] = await Promise.all([commitPresent(context.root, headOid), commitPresent(context.root, baseOid)]);
    if (headLocal && baseLocal) return { headOid };
    const outcome = await fetchPullRequestRefs({
      repoRoot: context.root,
      remote: context.base.remote,
      number,
      head: !headLocal,
      baseRefName: baseLocal ? null : baseRefName,
      env: this.options.gitEnv,
      timeoutMs: this.options.fetchTimeoutMs,
    });
    if (!outcome.ok) {
      this.log(`fetch #${number}: ${outcome.failure}`);
      const status = outcome.failure === "missing-ref" ? 404
        : outcome.failure === "no-credential" ? 403
        : outcome.failure === "invalid" ? 422
        : outcome.failure === "timeout" ? 504
        : 502;
      throw new GithubError(status, `${outcome.message} Nothing in your checkout changed.`);
    }
    // A base commit may be local now: measure and collect again.
    pullRequestRefsFetched(context.root);
    // Merged or closed pull requests' refs go first, then the oldest.
    const closed = [...state.commits].filter(([, known]) => known.state !== "OPEN").map(([candidate]) => candidate);
    await prunePullRequestRefs(context.root, { protect: [number], closed });
    if (outcome.headOid && outcome.headOid !== headOid) {
      // It moved on GitHub since the detail was read: read it again, so the
      // view and the cache name the fetched head.
      state.details.delete(number);
      return { headOid: (await this.pullRequest(repositoryId, number)).summary.headRefOid };
    }
    return { headOid };
  }

  // Memory only: anchoring must never become a GitHub request.
  reviewContext(repositoryId: string): PullRequestReviewContext | null {
    const state = this.states.get(repositoryId);
    const pullRequest = state?.summary?.pullRequest;
    if (!state || !pullRequest || pullRequest.state !== "OPEN") return null;
    const known = state.commits.get(pullRequest.number);
    const headOid = known?.headOid ?? pullRequest.headRefOid;
    const files = state.files.get(`${pullRequest.number}@${headOid}`);
    return {
      number: pullRequest.number,
      headOid,
      paths: files && !files.truncated ? new Set(files.files.map(file => file.path)) : null,
    };
  }

  // --- internals ---------------------------------------------------------------

  private async write(
    repositoryId: string,
    number: number,
    options: { anyState?: boolean },
    run: (pre: WritePrecondition, context: Context, state: RepositoryState) => Promise<void>,
  ): Promise<PullRequestDetail> {
    if (this.options.mode !== "full") throw new GithubError(403, "This session reads GitHub only (its GitHub setting is read), so nothing can be sent.");
    // Taken before anything is awaited, so overlapping writes can't both pass.
    const state = this.state(repositoryId);
    if (state.writing.has(number)) throw new GithubError(409, `Another change to #${number} is still being sent.`);
    state.writing.add(number);
    let context: Context | null = null;
    try {
      context = await this.requireContext(repositoryId);
      const limit = this.hostLimits.get(context.base.host) ?? 0;
      if (limit > this.now()) throw this.githubError(new GitHubFailure("rate-limited", "", { retryAt: limit }), context);
      const answer = await this.options.api.graphql(context.base.host, WRITE_PRECONDITION, { owner: context.base.owner, name: context.base.name, number });
      const pre = parseWritePrecondition(answer.data, new ParseNotes());
      if (!pre) throw new GithubError(404, `There's no pull request #${number} in ${context.base.owner}/${context.base.name}.`);
      if (pre.state !== "OPEN" && !options.anyState) throw new GithubError(422, `Pull request #${number} is ${pre.state.toLowerCase()}.`);
      await run(pre, context, state);
      // The write changed what every cached answer says.
      state.list = null;
      state.queriedAt = 0;
      return await this.readDetail(state, context, number);
    } catch (error) {
      if (error instanceof GithubError || !context) throw error;
      const failure = this.asFailure(error, "write");
      this.noteFailure(state, context, failure);
      throw this.githubError(failure, context);
    } finally {
      state.writing.delete(number);
    }
  }

  private noteCommits(state: RepositoryState, pullRequest: PullRequestSummary): void {
    state.commits.set(pullRequest.number, { headOid: pullRequest.headRefOid, baseOid: pullRequest.baseRefOid, baseRefName: pullRequest.baseRefName, state: pullRequest.state });
  }

  // The base of the checked-out branch's open pull request (D7), or none.
  private setBase(context: Context, pullRequest: PullRequestSummary | undefined): void {
    const branch = context.facts.branch;
    setPullRequestBase(context.root, pullRequest && pullRequest.state === "OPEN" && branch
      ? { number: pullRequest.number, remote: context.base.remote, baseRefName: pullRequest.baseRefName, baseRefOid: pullRequest.baseRefOid, branch }
      : null);
  }

  // A pull request's commits from memory, else from a detail read.
  private async commitsOf(repositoryId: string, number: number): Promise<KnownCommits> {
    const known = this.state(repositoryId).commits.get(number);
    if (known) return known;
    const detail = await this.pullRequest(repositoryId, number);
    return { headOid: detail.summary.headRefOid, baseOid: detail.summary.baseRefOid, baseRefName: detail.summary.baseRefName, state: detail.summary.state };
  }

  private rootOf(repositoryId: string): string {
    const root = this.options.repositoryRoot(repositoryId);
    if (!root) throw new GithubError(404, "Unknown repository.");
    return root;
  }

  private async startReview(context: Context, pre: WritePrecondition): Promise<string> {
    const answer = await this.mutate(context, ADD_REVIEW, { pullRequestId: pre.id, commitOID: pre.headRefOid });
    const id = (answer as { addPullRequestReview?: { pullRequestReview?: { id?: unknown } } }).addPullRequestReview?.pullRequestReview?.id;
    if (typeof id !== "string" || !id) throw new GitHubFailure("unavailable", "GitHub didn't say which review it started.");
    return id;
  }

  private async mutate(context: Context, operation: { name: string; query: string; write?: boolean }, input: Record<string, unknown>): Promise<unknown> {
    const answer = await this.options.api.graphql(context.base.host, operation, { input });
    // A mutation answering with errors did not do what was asked.
    const error = answer.errors[0];
    if (error) throw new GitHubFailure(error.type === "FORBIDDEN" ? "forbidden" : "invalid", error.message, { operation: operation.name, githubType: error.type });
    return answer.data;
  }

  // Why a read can't be sent now (null when it can).
  private readGate(state: RepositoryState, context: Context): GithubError | null {
    const now = this.now();
    if (state.bypassUntil > now) return null;
    const limit = this.hostLimits.get(context.base.host) ?? 0;
    if (limit > now) return this.githubError(new GitHubFailure("rate-limited", "", { retryAt: limit }), context);
    return null;
  }

  private noteFailure(state: RepositoryState, context: Context, failure: GitHubFailure): void {
    if (failure.kind === "rate-limited") this.hostLimits.set(context.base.host, failure.retryAt ?? this.now() + 60_000);
    // A summary read next time asks GitHub again, so the status follows.
    state.queriedAt = 0;
  }

  private githubError(failure: GitHubFailure, context: Context): GithubError {
    return new GithubError(httpStatusForFailure(failure), failureMessage(failure, context.base.host, this.now()));
  }

  private asFailure(error: unknown, what: string): GitHubFailure {
    const failure = error instanceof GitHubFailure
      ? error
      : error instanceof GithubError
        ? new GitHubFailure("invalid", error.message)
        : new GitHubFailure("unavailable", "GitHub's answer couldn't be read.");
    if (!(error instanceof GitHubFailure) && !(error instanceof GithubError)) this.log(`${what}: unexpected ${error instanceof Error ? error.name : typeof error}`);
    else this.log(`${what}: ${failure.kind}${failure.details.operation ? ` in ${failure.details.operation}` : ""}${failure.details.httpStatus ? ` (HTTP ${failure.details.httpStatus})` : ""}${failure.details.githubType ? ` [${failure.details.githubType}]` : ""}`);
    return failure;
  }

  private state(repositoryId: string): RepositoryState {
    let state = this.states.get(repositoryId);
    if (!state) {
      state = newState();
      this.states.set(repositoryId, state);
    }
    return state;
  }

  private async requireContext(repositoryId: string): Promise<Context> {
    const context = await this.context(repositoryId);
    if (!context) throw new GithubError(404, "This repository isn't on GitHub.");
    return context;
  }

  // The repository's GitHub identity and branch facts, from local Git (no
  // network) — except an Enterprise host, which counts only when `gh` is
  // signed in to it (asked once per host).
  private async context(repositoryId: string): Promise<Context | null> {
    const root = this.options.repositoryRoot(repositoryId);
    if (!root) throw new GithubError(404, "Unknown repository.");
    const facts = await this.readGitFacts(root);
    if (!facts) return null;
    const remoteName = baseRemoteName(facts);
    const parsed = remoteName ? parseRemoteUrl(facts.remotes.get(remoteName)!) : null;
    if (!remoteName || !parsed) return null;
    if (!(await this.isGithubHost(parsed.host))) return null;
    const base: RemoteRepository = { ...parsed, remote: remoteName };
    const upstreamUrl = facts.upstreamRemote ? facts.remotes.get(facts.upstreamRemote) : undefined;
    const upstream = upstreamUrl ? parseRemoteUrl(upstreamUrl) : null;
    return { root, facts, base, upstream, key: detectionKey(facts, base) };
  }

  private async isGithubHost(host: string): Promise<boolean> {
    if (isAlwaysGithubHost(host) || host === this.options.ghHost) return true;
    return (await this.options.api.transport.authenticated?.(host)) ?? false;
  }
}

function checkedBody(body: string): string {
  if (typeof body !== "string" || body.trim() === "") throw new GithubError(422, "The comment is empty.");
  if (body.length > GITHUB_BODY_MAX_LENGTH) throw new GithubError(422, `Comments are limited to ${GITHUB_BODY_MAX_LENGTH} characters.`);
  return body;
}
