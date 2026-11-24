// FakeGitHub: an in-memory GitHubTransport (src/github/gh.ts) for tests
// (design D15, task 1.4). It answers the real service's GraphQL operations and
// REST paths, keyed by operation name, from the hand-written fixture
// tests/fixtures/github/acme-widgets.json, so the real adapters and parsers
// (src/github/ops/) run over GitHub-shaped JSON. Writes mutate this fake's
// copy; an operation it doesn't know throws instead of answering empty data.
//
// Scenario controls: a new head, mergeability, rate limits (GraphQL's 200 +
// RATE_LIMITED, REST's 403 with remaining 0, a secondary limit with
// retry-after), no credential (401), no access (not found, SAML SSO), GitHub
// unavailable (502), a timeout, and checks a token can't read (a partial
// answer with a FORBIDDEN error under the checks).

import seed from "./github/acme-widgets.json";
import { GitHubFailure, type GitHubResponse } from "../../src/github/classify";
import type { GitHubRequest, GitHubTransport } from "../../src/github/gh";

type Json = Record<string, unknown>;
type PendingReview = { id: string; commitOid: string; comments: Json[] };
type PullRequestRecord = Json & {
  id: string;
  number: number;
  state: string;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  author: { login: string };
  timelineItems: { totalCount: number; nodes: Json[] };
  reviewThreads: { totalCount: number; nodes: Json[] };
  latestReviews: { nodes: Json[] };
  files: Json[];
  pending: PendingReview | null;
};

export type FakeGitHubOptions = { now?: () => number };

export class FakeGitHub implements GitHubTransport {
  readonly calls: GitHubRequest[] = [];
  readonly host = seed.host;
  readonly owner = seed.owner;
  readonly name = seed.name;
  readonly viewer = seed.viewer;
  private pullRequests = new Map<number, PullRequestRecord>();
  private sequence = 0;
  private rateLimit: { kind: "primary" | "secondary"; resetAt: number } | null = null;
  private failure: "no-credential" | "not-found" | "sso" | "unavailable" | "timeout" | null = null;
  private checksForbidden = false;
  private readonly enterpriseHosts = new Set<string>();
  private readonly now: () => number;

  constructor(options: FakeGitHubOptions = {}) {
    this.now = options.now ?? Date.now;
    this.reset();
  }

  reset(): void {
    this.sequence = 0;
    this.rateLimit = null;
    this.failure = null;
    this.checksForbidden = false;
    this.calls.length = 0;
    this.pullRequests = new Map(structuredClone(seed.pullRequests).map(node => [node.number, { ...node, pending: null } as unknown as PullRequestRecord]));
  }

  // --- scenario controls ---------------------------------------------------

  pushHead(number: number, oid: string): void {
    const pr = this.pr(number);
    pr.headRefOid = oid;
    pr.updatedAt = new Date(this.now()).toISOString();
  }

  setMergeability(number: number, mergeable: string, mergeStateStatus: string): void {
    const pr = this.pr(number);
    pr.mergeable = mergeable;
    pr.mergeStateStatus = mergeStateStatus;
  }

  setRateLimit(limit: { kind: "primary" | "secondary"; resetAt: number } | null): void {
    this.rateLimit = limit;
  }

  setFailure(failure: FakeGitHub["failure"]): void {
    this.failure = failure;
  }

  setChecksForbidden(forbidden: boolean): void {
    this.checksForbidden = forbidden;
  }

  authenticateHost(host: string): void {
    this.enterpriseHosts.add(host);
  }

  record(number: number): PullRequestRecord {
    return this.pr(number);
  }

  operations(): string[] {
    return this.calls.map(call => call.operation);
  }

  async authenticated(host: string): Promise<boolean> {
    return this.enterpriseHosts.has(host);
  }

  // --- the transport ---------------------------------------------------------

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.calls.push(request);
    if (this.failure === "timeout") throw new GitHubFailure("timeout", "GitHub didn't answer in time.", { operation: request.operation });
    if (this.failure === "no-credential") return this.answer(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
    if (this.failure === "unavailable") return this.answer(502, { message: "Server Error" });
    if (this.failure === "sso") {
      return this.answer(403, { message: "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization." },
        { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=fake" });
    }
    if (this.rateLimit && this.rateLimit.resetAt > this.now()) return this.limited(request);
    if (request.kind === "rest") return this.rest(request);
    if (this.failure === "not-found") {
      return this.answer(200, { data: { viewer: { login: this.viewer }, repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: `Could not resolve to a Repository with the name '${this.owner}/${this.name}'.` }] });
    }
    const variables = request.variables;
    if (variables.owner !== undefined && (variables.owner !== this.owner || variables.name !== this.name)) {
      return this.answer(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository." }] });
    }
    const handler = this.handlers[request.operation];
    if (!handler) throw new Error(`FakeGitHub: unknown operation ${request.operation}`);
    return handler(variables);
  }

  private readonly handlers: Record<string, (variables: Record<string, unknown>) => GitHubResponse> = {
    UatuDetectPullRequest: variables => this.data({
      viewer: { login: this.viewer },
      repository: {
        pullRequests: {
          nodes: [...this.pullRequests.values()]
            .filter(pr => pr.headRefName === variables.head)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 10)
            .map(pr => ({ number: pr.number, state: pr.state, updatedAt: pr.updatedAt, headRepositoryOwner: pr.headRepositoryOwner })),
        },
      },
    }),
    UatuPullRequestSummary: variables => this.pullRequestAnswer(variables, { checks: true }),
    UatuPullRequestConversation: variables => this.pullRequestAnswer(variables, { checks: true }),
    UatuPullRequestThreads: variables => this.pullRequestAnswer(variables),
    UatuPullRequestWriteCheck: variables => this.pullRequestAnswer(variables),
    UatuOpenPullRequests: () => {
      const open = [...this.pullRequests.values()].filter(pr => pr.state === "OPEN").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return this.data({ viewer: { login: this.viewer }, repository: { pullRequests: { totalCount: open.length, nodes: open.map(pr => this.view(pr)) } } });
    },
    UatuAddComment: variables => this.write(variables, input => {
      const pr = this.byId(input.subjectId);
      pr.timelineItems.nodes.push({ __typename: "IssueComment", id: this.id("IC"), author: { login: this.viewer }, body: input.body, createdAt: this.iso() });
      pr.timelineItems.totalCount += 1;
      return { addComment: { clientMutationId: null } };
    }),
    UatuAddReview: variables => this.write(variables, input => {
      const pr = this.byId(input.pullRequestId);
      if (input.event === undefined) {
        if (pr.pending) return this.refuse("UNPROCESSABLE", "User can only have one pending review per pull request");
        pr.pending = { id: this.id("PRR"), commitOid: String(input.commitOID ?? pr.headRefOid), comments: [] };
        return { addPullRequestReview: { pullRequestReview: { id: pr.pending.id } } };
      }
      const id = this.id("PRR");
      this.publishReview(pr, id, String(input.event), String(input.body ?? ""));
      return { addPullRequestReview: { pullRequestReview: { id } } };
    }),
    UatuAddReviewThread: variables => this.write(variables, input => {
      const pr = this.byPendingReview(input.pullRequestReviewId);
      if (!pr.files.some(file => file.filename === input.path)) return this.refuse("UNPROCESSABLE", "Path could not be resolved");
      const comment = { id: this.id("PRRC"), author: { login: this.viewer }, body: input.body, createdAt: this.iso(), diffHunk: "", state: "PENDING", pullRequestReview: { id: pr.pending!.id } };
      const thread = { id: this.id("PRRT"), path: input.path, line: input.line, startLine: null, originalLine: input.line, diffSide: input.side, isResolved: false, isOutdated: false, subjectType: "LINE", comments: { totalCount: 1, nodes: [comment] } };
      pr.reviewThreads.nodes.push(thread);
      pr.reviewThreads.totalCount += 1;
      pr.pending!.comments.push({ id: comment.id, body: comment.body, createdAt: comment.createdAt, path: input.path, line: input.line, replyTo: null });
      return { addPullRequestReviewThread: { thread: { id: thread.id } } };
    }),
    UatuReplyToThread: variables => this.write(variables, input => {
      const pr = this.byPendingReview(input.pullRequestReviewId);
      const thread = pr.reviewThreads.nodes.find(candidate => candidate.id === input.pullRequestReviewThreadId);
      if (!thread) return this.refuse("NOT_FOUND", "Could not resolve to a node with the global id.");
      const comments = thread.comments as { totalCount: number; nodes: Json[] };
      const comment = { id: this.id("PRRC"), author: { login: this.viewer }, body: input.body, createdAt: this.iso(), diffHunk: "", state: "PENDING", pullRequestReview: { id: pr.pending!.id } };
      comments.nodes.push(comment);
      comments.totalCount += 1;
      pr.pending!.comments.push({ id: comment.id, body: comment.body, createdAt: comment.createdAt, path: thread.path, line: thread.line, replyTo: { id: comments.nodes[0]!.id } });
      return { addPullRequestReviewThreadReply: { comment: { id: comment.id } } };
    }),
    UatuResolveThread: variables => this.write(variables, input => this.resolve(input.threadId, true)),
    UatuUnresolveThread: variables => this.write(variables, input => this.resolve(input.threadId, false)),
    UatuEditPendingComment: variables => this.write(variables, input => {
      for (const pr of this.pullRequests.values()) {
        const pending = pr.pending?.comments.find(comment => comment.id === input.pullRequestReviewCommentId);
        if (!pending) continue;
        pending.body = input.body;
        for (const thread of pr.reviewThreads.nodes) for (const comment of (thread.comments as { nodes: Json[] }).nodes) if (comment.id === pending.id) comment.body = input.body;
        return { updatePullRequestReviewComment: { pullRequestReviewComment: { id: pending.id } } };
      }
      return this.refuse("NOT_FOUND", "Could not resolve to a node with the global id.");
    }),
    UatuDeletePendingComment: variables => this.write(variables, input => {
      for (const pr of this.pullRequests.values()) {
        if (!pr.pending?.comments.some(comment => comment.id === input.id)) continue;
        pr.pending.comments = pr.pending.comments.filter(comment => comment.id !== input.id);
        this.dropComments(pr, new Set([String(input.id)]));
        return { deletePullRequestReviewComment: { clientMutationId: null } };
      }
      return this.refuse("NOT_FOUND", "Could not resolve to a node with the global id.");
    }),
    UatuSubmitReview: variables => this.write(variables, input => {
      const pr = this.byPendingReview(input.pullRequestReviewId);
      const pending = pr.pending!;
      for (const thread of pr.reviewThreads.nodes) for (const comment of (thread.comments as { nodes: Json[] }).nodes) if (comment.state === "PENDING") comment.state = "SUBMITTED";
      pr.pending = null;
      const refused = this.publishReview(pr, pending.id, String(input.event), String(input.body ?? ""));
      if (refused) {
        pr.pending = pending;
        return refused;
      }
      return { submitPullRequestReview: { pullRequestReview: { id: pending.id } } };
    }),
    UatuDiscardReview: variables => this.write(variables, input => {
      const pr = this.byPendingReview(input.pullRequestReviewId);
      this.dropComments(pr, new Set(pr.pending!.comments.map(comment => String(comment.id))));
      pr.pending = null;
      return { deletePullRequestReview: { pullRequestReview: { id: input.pullRequestReviewId } } };
    }),
  };

  // --- answers -------------------------------------------------------------------

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json; charset=utf-8",
      "x-github-request-id": "FAKE:0001",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(this.now() / 1000) + 3600),
      ...extra,
    };
  }

  private answer(status: number, json: unknown, headers: Record<string, string> = {}): GitHubResponse {
    return { status, headers: this.headers(headers), json: structuredClone(json) };
  }

  private data(data: Json, errors?: Json[]): GitHubResponse {
    return this.answer(200, errors ? { data, errors } : { data });
  }

  private limited(request: GitHubRequest): GitHubResponse {
    const reset = String(Math.ceil(this.rateLimit!.resetAt / 1000));
    if (this.rateLimit!.kind === "secondary") {
      const seconds = String(Math.max(1, Math.ceil((this.rateLimit!.resetAt - this.now()) / 1000)));
      return this.answer(403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, { "retry-after": seconds });
    }
    if (request.kind === "graphql") {
      return this.answer(200, { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }] }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset });
    }
    return this.answer(403, { message: "API rate limit exceeded for user ID 1." }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset });
  }

  private rest(request: Extract<GitHubRequest, { kind: "rest" }>): GitHubResponse {
    if (request.operation !== "UatuPullRequestFiles") throw new Error(`FakeGitHub: unknown operation ${request.operation}`);
    const match = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files\?per_page=(\d+)&page=(\d+)$/.exec(request.path);
    if (!match) throw new Error(`FakeGitHub: unexpected path ${request.path}`);
    if (match[1] !== this.owner || match[2] !== this.name) return this.answer(404, { message: "Not Found" });
    const pr = this.pullRequests.get(Number(match[3]));
    if (!pr) return this.answer(404, { message: "Not Found" });
    const perPage = Number(match[4]);
    const page = Number(match[5]);
    return this.answer(200, pr.files.slice((page - 1) * perPage, page * perPage));
  }

  // `checks`: the operation selects the checks rollup (so a token that can't
  // read checks gets its FORBIDDEN there).
  private pullRequestAnswer(variables: Record<string, unknown>, options: { checks?: boolean } = {}): GitHubResponse {
    const pr = this.pullRequests.get(Number(variables.number));
    const repository = { ...seed.repository, pullRequest: pr ? this.view(pr) : null };
    const errors: Json[] = [];
    if (!pr) errors.push({ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: `Could not resolve to a PullRequest with the number of ${String(variables.number)}.` });
    if (pr && this.checksForbidden && options.checks) {
      const lastCommit = (repository.pullRequest as Json).lastCommit as { nodes: { commit: Json }[] };
      for (const node of lastCommit.nodes) node.commit.statusCheckRollup = null;
      errors.push({ type: "FORBIDDEN", path: ["repository", "pullRequest", "lastCommit", "nodes", 0, "commit", "statusCheckRollup"], message: "Resource not accessible by personal access token" });
    }
    return this.data({ viewer: { login: this.viewer }, repository }, errors.length ? errors : undefined);
  }

  // The node as every pull request query reads it (a superset of each one's
  // selection): the viewer's own pending review shows only to the viewer.
  private view(pr: PullRequestRecord): Json {
    const { files: _files, pending, ...node } = structuredClone(pr);
    const pendingNodes = pending
      ? [{ id: pending.id, commit: { oid: pending.commitOid }, comments: { totalCount: pending.comments.length, nodes: pending.comments } }]
      : [];
    return { ...node, viewerPending: { nodes: pendingNodes }, pendingReviews: { nodes: pendingNodes } };
  }

  private write(variables: Record<string, unknown>, run: (input: Record<string, unknown>) => Json | GitHubResponse): GitHubResponse {
    const input = variables.input as Record<string, unknown> | undefined;
    if (!input || typeof input !== "object") throw new Error("FakeGitHub: a mutation without input");
    try {
      const result = run(input);
      return "status" in result && "headers" in result ? result as GitHubResponse : this.data(result as Json);
    } catch (error) {
      if (error instanceof Refusal) return this.refuse(error.type, error.message);
      throw error;
    }
  }

  private refuse(type: string, message: string): GitHubResponse {
    return this.answer(200, { data: null, errors: [{ type, message }] });
  }

  private publishReview(pr: PullRequestRecord, id: string, event: string, body: string): GitHubResponse | null {
    if (event !== "COMMENT" && pr.author.login === this.viewer) return this.refuse("UNPROCESSABLE", "Can not approve your own pull request");
    const state = event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
    pr.timelineItems.nodes.push({ __typename: "PullRequestReview", id, author: { login: this.viewer }, state, body, submittedAt: this.iso(), createdAt: this.iso() });
    pr.timelineItems.totalCount += 1;
    pr.latestReviews.nodes = [...pr.latestReviews.nodes.filter(review => (review.author as { login: string }).login !== this.viewer), { author: { login: this.viewer }, state }];
    if (state === "APPROVED") pr.reviewDecision = "APPROVED";
    if (state === "CHANGES_REQUESTED") pr.reviewDecision = "CHANGES_REQUESTED";
    pr.updatedAt = this.iso();
    return null;
  }

  private resolve(threadId: unknown, resolved: boolean): Json {
    for (const pr of this.pullRequests.values()) {
      const thread = pr.reviewThreads.nodes.find(candidate => candidate.id === threadId);
      if (!thread) continue;
      thread.isResolved = resolved;
      return { [resolved ? "resolveReviewThread" : "unresolveReviewThread"]: { thread: { id: thread.id } } };
    }
    throw new Refusal("NOT_FOUND", "Could not resolve to a node with the global id.");
  }

  private dropComments(pr: PullRequestRecord, ids: Set<string>): void {
    for (const thread of pr.reviewThreads.nodes) {
      const comments = thread.comments as { totalCount: number; nodes: Json[] };
      comments.nodes = comments.nodes.filter(comment => !ids.has(String(comment.id)));
      comments.totalCount = comments.nodes.length;
    }
    pr.reviewThreads.nodes = pr.reviewThreads.nodes.filter(thread => (thread.comments as { nodes: Json[] }).nodes.length > 0);
    pr.reviewThreads.totalCount = pr.reviewThreads.nodes.length;
  }

  private pr(number: number): PullRequestRecord {
    const pr = this.pullRequests.get(number);
    if (!pr) throw new Error(`FakeGitHub: no pull request #${number} in the fixture`);
    return pr;
  }

  private byId(id: unknown): PullRequestRecord {
    const pr = [...this.pullRequests.values()].find(candidate => candidate.id === id);
    if (!pr) throw new Refusal("NOT_FOUND", "Could not resolve to a node with the global id.");
    return pr;
  }

  private byPendingReview(id: unknown): PullRequestRecord {
    const pr = [...this.pullRequests.values()].find(candidate => candidate.pending?.id === id);
    if (!pr) throw new Refusal("NOT_FOUND", "Could not resolve to a PullRequestReview.");
    return pr;
  }

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_fake${this.sequence}`;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

class Refusal extends Error {
  constructor(readonly type: string, message: string) {
    super(message);
  }
}
