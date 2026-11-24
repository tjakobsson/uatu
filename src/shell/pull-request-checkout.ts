// Checking a pull request out as a Hub worktree (switcher phase 3; design D12
// of add-github-pr-review). The client already knows the pull request's
// number, head branch and whether it comes from a fork, and the remote that
// is the GitHub repository; the Hub needs nothing else and asks GitHub
// nothing.
//
//   fork             one request: `pull-request` mode, branch `pr/<n>` from
//                    `refs/pull/<n>/head` on that remote.
//   same repository  the existing worktree fetch, then the head branch: an
//                    existing local branch of that name as it is, else a new
//                    tracking branch on `<remote>/<head>`. It stays pushable.
//
// The Hub API lives outside the session's base path (src/shell/hub-nav.ts
// explains why), so `api` is the published family's own path from Hub state.

import { pullRequestLocalBranch } from "../shared/github-contract";
import { parseWorktreeEndpointResult, parseWorktreeRefsResponse, type WorktreeOperationResult } from "../shared/worktree-contract";

export type PullRequestCheckoutTarget = {
  readonly number: number;
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
  // The local name of the remote that is the pull request's GitHub repository.
  readonly remote: string;
};

export type PullRequestCheckoutOutcome =
  | {
    readonly ok: true;
    readonly branch: string;
    readonly workspaceId: string;
    // An existing `pr/<n>` was checked out as it was, and its commit is not
    // the pull request's head.
    readonly differsFromHead: boolean;
  }
  | { readonly ok: false; readonly message: string };

const REQUEST_FAILED = "The Hub did not answer. Nothing was retried; try again.";

async function post<T>(fetchImpl: typeof fetch, url: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(REQUEST_FAILED);
  }
  if (!response.ok) throw new Error(REQUEST_FAILED);
  try {
    return parse(await response.json());
  } catch {
    throw new Error("The Hub's answer could not be read. Nothing was retried; try again.");
  }
}

function outcomeOf(result: WorktreeOperationResult): PullRequestCheckoutOutcome {
  if (!result.ok) {
    // Git created the checkout and registering it failed: the Hub dashboard
    // offers Retry registration for exactly that checkout.
    const retained = result.retainedCheckout ? " The checkout was kept; finish it from the Hub dashboard." : "";
    return { ok: false, message: `${result.error.message}${retained}` };
  }
  const checkout = result.checkout!;
  return {
    ok: true,
    branch: checkout.branch ?? "",
    workspaceId: checkout.workspaceId!,
    differsFromHead: result.pullRequestHead !== undefined && checkout.head !== undefined && checkout.head !== result.pullRequestHead,
  };
}

export async function checkOutPullRequest(
  api: string,
  sourceWorkspaceId: string,
  target: PullRequestCheckoutTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<PullRequestCheckoutOutcome> {
  const create = (body: Record<string, unknown>) =>
    post(fetchImpl, `${api}/create`, { sourceWorkspaceId, ...body }, value => parseWorktreeEndpointResult(value, "create"));
  try {
    if (target.isCrossRepository) {
      return outcomeOf(await create({ mode: "pull-request", pullRequest: { number: target.number, remote: target.remote } }));
    }
    const fetched = await post(fetchImpl, `${api}/fetch`, { sourceWorkspaceId }, parseWorktreeRefsResponse);
    if (!fetched.ok) return { ok: false, message: fetched.error.message };
    const branch = pullRequestLocalBranch(target);
    if (fetched.refs.local.includes(branch)) {
      return outcomeOf(await create({ mode: "existing-local", base: { kind: "local", ref: branch } }));
    }
    const tracking = `${target.remote}/${branch}`;
    if (!fetched.refs.remote.includes(tracking)) {
      return { ok: false, message: `${target.remote} has no branch ${branch}. It may have been deleted or renamed; nothing was created.` };
    }
    return outcomeOf(await create({ mode: "remote-tracking", base: { kind: "remote", ref: tracking } }));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : REQUEST_FAILED };
  }
}
