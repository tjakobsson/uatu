// MOCKED GITHUB BACKEND. An in-memory GithubService seeded with fictional
// data (src/github/fake-data.ts). Writes mutate this process's memory only, so
// the UI round-trips for real while nothing reaches GitHub. Every answer sets
// `mock: true` and the UI labels itself accordingly.
//
// Enabled only by UATU_GITHUB_FAKE=1 (see githubServiceFromEnvironment in
// ./service.ts). The scenario switch reproduces the empty and error states of
// the mockups: `ready`, `no-pull-request`, `no-credential`, `rate-limited`
// and `unavailable`.

import { renderMarkdownToHtml } from "../render/markdown";
import {
  GITHUB_BODY_MAX_LENGTH,
  isGithubFakeScenario,
  type ChecksRollup,
  type CheckRun,
  type GithubComment,
  type GithubFakeScenario,
  type GithubSummary,
  type PendingReview,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestList,
  type PullRequestState,
  type PullRequestSummary,
  type ReviewDecision,
  type ReviewerState,
  type ReviewThread,
  type TimelineItem,
} from "../shared/github-contract";
import { GithubError } from "./error";
import {
  FAKE_CURRENT_PULL_REQUEST,
  FAKE_REPOSITORY,
  FAKE_REPOSITORY_SETTINGS,
  FAKE_VIEWER,
  seedPullRequests,
  type SeedCheck,
  type SeedPullRequest,
} from "./fake-data";
import type { GithubService, NewThreadInput, SubmitReviewInput } from "./service";

const HOUR_MS = 3_600_000;
// How long the fake pretends the rate limit lasts.
const RATE_LIMIT_RESET_MS = 14 * 60_000;

type PullRequestRecord = {
  seed: SeedPullRequest;
  state: PullRequestState;
  updatedAt: number;
  createdAt: number;
  files: PullRequestFile[];
  checks: SeedCheck[];
  reviewerStates: Map<string, ReviewerState>;
  timeline: TimelineItem[];
  threads: ReviewThread[];
  pendingReview: PendingReview | null;
};

export class FakeGithubService implements GithubService {
  private readonly now: () => number;
  private scenario: GithubFakeScenario;
  private seededAt = 0;
  private lastGoodAt = 0;
  private sequence = 0;
  private records = new Map<number, PullRequestRecord>();

  constructor(options: { scenario?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.scenario = isGithubFakeScenario(options.scenario) ? options.scenario : "ready";
    this.reset();
  }

  // Re-seeds the fake: every comment and review made so far is lost.
  reset(): void {
    this.seededAt = this.now();
    this.lastGoodAt = this.seededAt;
    this.sequence = 0;
    this.records = new Map(seedPullRequests().map(seed => [seed.number, this.recordFrom(seed)]));
  }

  setScenario(scenario: GithubFakeScenario): void {
    this.scenario = scenario;
    if (scenario === "ready" || scenario === "no-pull-request") this.lastGoodAt = this.now();
  }

  async summary(_repositoryId: string): Promise<GithubSummary> {
    const base = { mock: true, repository: { ...FAKE_REPOSITORY } };
    switch (this.scenario) {
      case "no-credential":
        return { ...base, status: "no-credential", viewer: null, checkedAt: this.now(), stale: false,
          message: "No GitHub credential is assigned to this workspace." };
      case "no-pull-request":
        this.lastGoodAt = this.now();
        return { ...base, status: "no-pull-request", viewer: FAKE_VIEWER, checkedAt: this.lastGoodAt, stale: false };
      case "rate-limited":
        return { ...base, status: "rate-limited", viewer: FAKE_VIEWER, checkedAt: this.lastGoodAt, stale: true,
          retryAt: this.lastGoodAt + RATE_LIMIT_RESET_MS, message: "API rate limit exceeded.",
          pullRequest: this.toSummary(this.current()) };
      case "unavailable":
        return { ...base, status: "unavailable", viewer: FAKE_VIEWER, checkedAt: this.lastGoodAt, stale: true,
          message: "GitHub did not answer (connection timed out).", pullRequest: this.toSummary(this.current()) };
      case "ready":
        this.lastGoodAt = this.now();
        return { ...base, status: "ready", viewer: FAKE_VIEWER, checkedAt: this.lastGoodAt, stale: false,
          pullRequest: this.toSummary(this.current()) };
    }
  }

  refresh(repositoryId: string): Promise<GithubSummary> {
    return this.summary(repositoryId);
  }

  async pullRequest(_repositoryId: string, number: number): Promise<PullRequestDetail> {
    this.assertReadable();
    return this.toDetail(this.record(number));
  }

  async pullRequests(_repositoryId: string): Promise<PullRequestList> {
    this.assertReadable();
    const open = [...this.records.values()].filter(record => record.state === "OPEN");
    open.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      mock: true,
      repository: { ...FAKE_REPOSITORY },
      viewer: FAKE_VIEWER,
      pullRequests: open.map(record => {
        const summary = this.toSummary(record);
        return {
          number: summary.number,
          title: summary.title,
          author: summary.author,
          headRefName: summary.headRefName,
          headOwner: summary.headOwner,
          isCrossRepository: summary.isCrossRepository,
          isDraft: summary.isDraft,
          reviewDecision: summary.reviewDecision,
          viewerReviewRequested: record.reviewerStates.get(FAKE_VIEWER) === "REQUESTED",
          checks: { state: summary.checks.state, passed: summary.checks.passed, failed: summary.checks.failed, pending: summary.checks.pending },
          updatedAt: summary.updatedAt,
          viewerPendingComments: summary.viewerPendingComments,
        };
      }),
    };
  }

  async addComment(_repositoryId: string, number: number, body: string): Promise<PullRequestDetail> {
    const record = this.writable(number);
    record.timeline.push({ kind: "comment", comment: this.comment(FAKE_VIEWER, checkedBody(body)) });
    this.touch(record);
    return this.toDetail(record);
  }

  async addReviewThread(_repositoryId: string, number: number, input: NewThreadInput): Promise<PullRequestDetail> {
    const record = this.writable(number);
    if (input.headOid !== record.seed.headRefOid) {
      throw new GithubError(409, "The pull request changed since this diff was loaded. Reload it before commenting.");
    }
    const file = record.files.find(candidate => candidate.path === input.path);
    if (!file) throw new GithubError(422, `${input.path} is not part of this pull request.`);
    const lineCount = lineCountOf(input.side === "RIGHT" ? file.newContents : file.oldContents);
    if (!Number.isInteger(input.line) || input.line < 1 || input.line > lineCount) {
      throw new GithubError(422, `Line ${input.line} is outside ${input.path}.`);
    }
    const pending = this.pendingReviewFor(record);
    if (pending.commitOid !== record.seed.headRefOid) {
      throw new GithubError(409, "Your pending review was started on an older commit. Submit or discard it first.");
    }
    const body = checkedBody(input.body);
    pending.comments.push({ id: this.id("pending"), body, bodyHtml: renderBody(body), createdAt: this.iso(this.now()),
      path: input.path, line: input.line, side: input.side });
    return this.toDetail(record);
  }

  async replyToThread(_repositoryId: string, number: number, threadId: string, body: string): Promise<PullRequestDetail> {
    const record = this.writable(number);
    const thread = this.thread(record, threadId);
    const text = checkedBody(body);
    this.pendingReviewFor(record).comments.push({ id: this.id("pending"), body: text, bodyHtml: renderBody(text),
      createdAt: this.iso(this.now()), path: thread.path, line: thread.line ?? 0, side: thread.side, threadId });
    return this.toDetail(record);
  }

  async setThreadResolved(_repositoryId: string, number: number, threadId: string, resolved: boolean): Promise<PullRequestDetail> {
    const record = this.writable(number);
    this.thread(record, threadId).isResolved = resolved;
    this.touch(record);
    return this.toDetail(record);
  }

  async editPendingComment(_repositoryId: string, number: number, commentId: string, body: string): Promise<PullRequestDetail> {
    const record = this.writable(number);
    const comment = record.pendingReview?.comments.find(candidate => candidate.id === commentId);
    if (!comment) throw new GithubError(404, "That pending comment no longer exists.");
    comment.body = checkedBody(body);
    comment.bodyHtml = renderBody(comment.body);
    return this.toDetail(record);
  }

  async deletePendingComment(_repositoryId: string, number: number, commentId: string): Promise<PullRequestDetail> {
    const record = this.writable(number);
    const pending = record.pendingReview;
    const index = pending?.comments.findIndex(candidate => candidate.id === commentId) ?? -1;
    if (!pending || index < 0) throw new GithubError(404, "That pending comment no longer exists.");
    pending.comments.splice(index, 1);
    // GitHub keeps an empty pending review; so does the fake.
    return this.toDetail(record);
  }

  async submitReview(_repositoryId: string, number: number, input: SubmitReviewInput): Promise<PullRequestDetail> {
    const record = this.writable(number);
    if (record.seed.author === FAKE_VIEWER && input.event !== "COMMENT") {
      throw new GithubError(422, "You can't approve or request changes on your own pull request.");
    }
    const body = input.body.trim() === "" ? "" : checkedBody(input.body);
    const comments = record.pendingReview?.comments ?? [];
    if (input.event !== "APPROVE" && body === "" && comments.length === 0) {
      throw new GithubError(422, input.event === "COMMENT"
        ? "Write a summary or add a comment before submitting."
        : "Explain what needs to change in the summary.");
    }
    const threadIds: string[] = [];
    for (const pending of comments) {
      const comment: GithubComment = { id: this.id("comment"), author: FAKE_VIEWER, body: pending.body, bodyHtml: pending.bodyHtml, createdAt: this.iso(this.now()) };
      const existing = pending.threadId ? record.threads.find(thread => thread.id === pending.threadId) : undefined;
      if (existing) {
        existing.comments.push(comment);
        continue;
      }
      const file = record.files.find(candidate => candidate.path === pending.path);
      const thread: ReviewThread = {
        id: this.id("thread"), path: pending.path, line: pending.line, side: pending.side, isResolved: false, isOutdated: false,
        lineText: file ? lineAt(pending.side === "RIGHT" ? file.newContents : file.oldContents, pending.line) : "",
        comments: [comment],
      };
      record.threads.push(thread);
      threadIds.push(thread.id);
    }
    const state = input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
    record.timeline.push({ kind: "review", id: this.id("review"), author: FAKE_VIEWER, state, body, bodyHtml: body ? renderBody(body) : "",
      submittedAt: this.iso(this.now()), threadIds });
    const previous = record.reviewerStates.get(FAKE_VIEWER);
    // A comment-only review does not withdraw an earlier approval.
    if (state !== "COMMENTED" || previous === undefined || previous === "REQUESTED") record.reviewerStates.set(FAKE_VIEWER, state);
    record.pendingReview = null;
    this.touch(record);
    return this.toDetail(record);
  }

  // GitHub deletes a pending review whatever the pull request's state: one
  // left on a pull request merged on GitHub can still be discarded here.
  async discardReview(_repositoryId: string, number: number): Promise<PullRequestDetail> {
    const record = this.writable(number, { anyState: true });
    record.pendingReview = null;
    return this.toDetail(record);
  }

  // --- internals -------------------------------------------------------

  private recordFrom(seed: SeedPullRequest): PullRequestRecord {
    const createdAt = this.seededAt - seed.createdHoursAgo * HOUR_MS;
    const files: PullRequestFile[] = seed.files.map(file => {
      const counts = countLineChanges(file.old, file.new);
      return {
        path: file.path,
        status: file.old === "" ? "added" : file.new === "" ? "removed" : "modified",
        additions: counts.additions,
        deletions: counts.deletions,
        oldContents: file.old,
        newContents: file.new,
      };
    });
    const threads: ReviewThread[] = seed.threads.map(thread => {
      const file = files.find(candidate => candidate.path === thread.path);
      return {
        id: thread.id, path: thread.path, line: thread.line, side: "RIGHT", isResolved: false, isOutdated: false,
        lineText: file ? lineAt(file.newContents, thread.line) : "",
        comments: thread.comments.map(comment => this.comment(comment.author, comment.body, this.seededAt - comment.hoursAgo * HOUR_MS)),
      };
    });
    const timeline: TimelineItem[] = [
      ...seed.reviews.map(review => ({
        at: this.seededAt - review.hoursAgo * HOUR_MS,
        item: { kind: "review" as const, id: review.id, author: review.author, state: review.state, body: review.body,
          bodyHtml: renderBody(review.body), submittedAt: this.iso(this.seededAt - review.hoursAgo * HOUR_MS), threadIds: review.threadIds },
      })),
      ...seed.comments.map(comment => ({
        at: this.seededAt - comment.hoursAgo * HOUR_MS,
        item: { kind: "comment" as const, comment: this.comment(comment.author, comment.body, this.seededAt - comment.hoursAgo * HOUR_MS) },
      })),
    ].sort((a, b) => a.at - b.at).map(entry => entry.item);
    return {
      seed,
      state: "OPEN",
      createdAt,
      updatedAt: this.seededAt - seed.updatedHoursAgo * HOUR_MS,
      files,
      checks: seed.checks.map(check => ({ ...check })),
      reviewerStates: new Map(Object.entries(seed.reviewerStates)),
      timeline,
      threads,
      pendingReview: null,
    };
  }

  private current(): PullRequestRecord {
    return this.record(FAKE_CURRENT_PULL_REQUEST);
  }

  private record(number: number): PullRequestRecord {
    const record = this.records.get(number);
    if (!record) throw new GithubError(404, `Pull request #${number} does not exist in ${FAKE_REPOSITORY.owner}/${FAKE_REPOSITORY.name}.`);
    return record;
  }

  private assertReadable(): void {
    if (this.scenario === "no-credential") throw new GithubError(401, "GitHub isn't connected for this workspace.");
  }

  private writable(number: number, options: { anyState?: boolean } = {}): PullRequestRecord {
    this.assertReadable();
    if (this.scenario === "rate-limited") throw new GithubError(429, "GitHub's API rate limit is exhausted. Comments and reviews are paused until it resets.");
    if (this.scenario === "unavailable") throw new GithubError(503, "GitHub is unreachable. Comments and reviews are paused.");
    const record = this.record(number);
    if (record.state !== "OPEN" && !options.anyState) throw new GithubError(422, `Pull request #${number} is ${record.state.toLowerCase()}.`);
    return record;
  }

  private pendingReviewFor(record: PullRequestRecord): PendingReview {
    record.pendingReview ??= { id: this.id("pending-review"), commitOid: record.seed.headRefOid, comments: [] };
    return record.pendingReview;
  }

  private thread(record: PullRequestRecord, threadId: string): ReviewThread {
    const thread = record.threads.find(candidate => candidate.id === threadId);
    if (!thread) throw new GithubError(404, "That review thread no longer exists.");
    return thread;
  }

  private touch(record: PullRequestRecord): void {
    record.updatedAt = this.now();
  }

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private comment(author: string, body: string, at = this.now()): GithubComment {
    return { id: this.id("comment"), author, body, bodyHtml: renderBody(body), createdAt: this.iso(at) };
  }

  private checkRuns(record: PullRequestRecord): CheckRun[] {
    const elapsed = this.now() - this.seededAt;
    return record.checks.map(check => {
      if (check.state === "PENDING" && check.finishesAfterMs !== undefined && elapsed >= check.finishesAfterMs) {
        return { name: check.name, state: "SUCCESS", detail: check.finishedDetail ?? "passed" };
      }
      if (check.state === "PENDING") {
        return { name: check.name, state: "PENDING", detail: `running ${Math.max(1, Math.round((elapsed + 9 * 60_000) / 60_000))}m` };
      }
      return { name: check.name, state: check.state, detail: check.detail };
    });
  }

  private rollup(record: PullRequestRecord): ChecksRollup {
    const runs = this.checkRuns(record);
    const passed = runs.filter(run => run.state === "SUCCESS").length;
    const failed = runs.filter(run => run.state === "FAILURE").length;
    const pending = runs.filter(run => run.state === "PENDING").length;
    return { state: failed > 0 ? "FAILURE" : pending > 0 ? "PENDING" : "SUCCESS", passed, failed, pending, runs };
  }

  private reviewDecision(record: PullRequestRecord): ReviewDecision {
    const states = [...record.reviewerStates.values()];
    if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
    const approvals = states.filter(state => state === "APPROVED").length;
    return approvals >= FAKE_REPOSITORY_SETTINGS.requiredApprovals ? "APPROVED" : "REVIEW_REQUIRED";
  }

  // Why GitHub would refuse a merge now, most important first (empty when
  // it would merge). Read-only: the fake never merges.
  private mergeBlockers(record: PullRequestRecord): string[] {
    if (record.state === "MERGED") return ["Already merged."];
    if (record.state === "CLOSED") return ["Closed."];
    const blockers: string[] = [];
    if (record.seed.isDraft) blockers.push("Draft: mark it ready for review on GitHub first.");
    if (record.seed.conflicting) blockers.push(`Conflicts with ${record.seed.baseRefName} must be resolved.`);
    const decision = this.reviewDecision(record);
    if (decision === "CHANGES_REQUESTED") blockers.push("Changes were requested; that reviewer must approve.");
    if (decision === "REVIEW_REQUIRED") blockers.push(`${record.seed.baseRefName} requires ${FAKE_REPOSITORY_SETTINGS.requiredApprovals} approving reviews.`);
    const runs = this.checkRuns(record);
    const failing = runs.filter(run => run.state === "FAILURE").map(run => run.name);
    if (failing.length > 0) blockers.push(`Required ${failing.length === 1 ? "check" : "checks"} failing: ${failing.join(", ")}.`);
    const pending = runs.filter(run => run.state === "PENDING").map(run => run.name);
    if (pending.length > 0) blockers.push(`Waiting for required ${pending.length === 1 ? "check" : "checks"}: ${pending.join(", ")}.`);
    return blockers;
  }

  private toSummary(record: PullRequestRecord): PullRequestSummary {
    const seed = record.seed;
    return {
      number: seed.number,
      title: seed.title,
      url: `https://${FAKE_REPOSITORY.host}/${FAKE_REPOSITORY.owner}/${FAKE_REPOSITORY.name}/pull/${seed.number}`,
      state: record.state,
      isDraft: seed.isDraft,
      author: seed.author,
      baseRefName: seed.baseRefName,
      headRefName: seed.headRefName,
      baseRefOid: seed.baseRefOid,
      headRefOid: seed.headRefOid,
      isCrossRepository: seed.isCrossRepository,
      headOwner: seed.headOwner,
      reviewDecision: this.reviewDecision(record),
      checks: this.rollup(record),
      reviewers: [...record.reviewerStates.entries()].map(([login, state]) => ({ login, state })),
      commits: seed.commits,
      changedFiles: record.files.length,
      additions: record.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: record.files.reduce((sum, file) => sum + file.deletions, 0),
      createdAt: this.iso(record.createdAt),
      updatedAt: this.iso(record.updatedAt),
      viewerPendingComments: record.pendingReview?.comments.length ?? 0,
    };
  }

  private toDetail(record: PullRequestRecord): PullRequestDetail {
    const seed = record.seed;
    return {
      mock: true,
      repository: { ...FAKE_REPOSITORY },
      viewer: FAKE_VIEWER,
      summary: this.toSummary(record),
      body: seed.body,
      bodyHtml: renderBody(seed.body),
      timeline: record.timeline.map(item => structuredClone(item)),
      threads: record.threads.map(thread => structuredClone(thread)),
      pendingReview: record.pendingReview ? structuredClone(record.pendingReview) : null,
      files: record.files.map(file => ({ ...file })),
      mergeReadiness: (() => {
        const blockers = this.mergeBlockers(record);
        return {
          mergeable: blockers.length === 0,
          blockers,
          allowedMethods: [...FAKE_REPOSITORY_SETTINGS.allowed],
          deleteBranchOnMerge: FAKE_REPOSITORY_SETTINGS.deleteBranchOnMerge,
        };
      })(),
    };
  }
}

function checkedBody(body: string): string {
  if (typeof body !== "string" || body.trim() === "") throw new GithubError(422, "The comment is empty.");
  if (body.length > GITHUB_BODY_MAX_LENGTH) throw new GithubError(422, `Comments are limited to ${GITHUB_BODY_MAX_LENGTH} characters.`);
  return body;
}

function renderBody(body: string): string {
  return renderMarkdownToHtml(body).html;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineCountOf(text: string): number {
  return splitLines(text).length;
}

function lineAt(text: string, line: number): string {
  return splitLines(text)[line - 1] ?? "";
}

// Added and deleted line counts between two texts, from a longest common
// subsequence of their lines. The fake's files are small, so O(n·m) is fine.
export function countLineChanges(before: string, after: string): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const common = lengths[0]![0]!;
  return { additions: b.length - common, deletions: a.length - common };
}
