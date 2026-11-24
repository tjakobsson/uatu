import { describe, expect, test } from "bun:test";

import { checkOutPullRequest } from "./pull-request-checkout";

type Call = { url: string; body: Record<string, unknown> };

const checkout = (branch: string, head: string) => ({
  checkoutId: "c1", repositoryId: "r1", workspaceId: branch.replace(/\W/g, "-"), parentWorkspaceId: "atlas",
  path: `/src/atlas.worktrees/${branch.replace(/\W/g, "-")}`, branch, detached: false, main: false,
  ownership: "uatu", availability: "present", registered: true, running: false, locked: false, head,
});
const created = (branch: string, head = "0123456789ab", extra: Record<string, unknown> = {}) => ({
  ok: true, operationId: "o1", kind: "create", phase: "complete", registered: true, started: false, checkout: checkout(branch, head), ...extra,
});

// A Hub that answers from a script and records what it was asked.
function hub(answers: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    const action = url.slice(url.lastIndexOf("/") + 1);
    const next = answers[action]?.shift();
    if (next === undefined) return new Response("not scripted", { status: 500 });
    return Response.json(next);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const fork = { number: 639, headRefName: "fix-osc8", isCrossRepository: true, remote: "origin" };
const sameRepository = { number: 636, headRefName: "fix/pane-heights", isCrossRepository: false, remote: "origin" };

describe("checking a pull request out as a worktree", () => {
  test("a fork is one pull-request creation by number and remote", async () => {
    const { calls, fetchImpl } = hub({ create: [created("pr/639", "0123456789ab", { pullRequestHead: "0123456789ab" })] });
    expect(await checkOutPullRequest("/api/hub/worktrees", "atlas", fork, fetchImpl))
      .toEqual({ ok: true, branch: "pr/639", workspaceId: "pr-639", differsFromHead: false });
    expect(calls).toEqual([{ url: "/api/hub/worktrees/create", body: { sourceWorkspaceId: "atlas", mode: "pull-request", pullRequest: { number: 639, remote: "origin" } } }]);
  });

  test("a reused pr/<n> that is not at the pull request's head says so", async () => {
    const { fetchImpl } = hub({ create: [created("pr/639", "0123456789ab", { pullRequestHead: "ba9876543210" })] });
    const outcome = await checkOutPullRequest("/api/hub/worktrees", "atlas", fork, fetchImpl);
    expect(outcome.ok && outcome.differsFromHead).toBe(true);
  });

  test("a same-repository pull request fetches, then tracks its head branch", async () => {
    const { calls, fetchImpl } = hub({
      fetch: [{ ok: true, refs: { local: ["main"], remote: ["origin/main", "origin/fix/pane-heights"], fetchedAt: 1 } }],
      create: [created("fix/pane-heights")],
    });
    const outcome = await checkOutPullRequest("/api/hub/worktrees", "atlas", sameRepository, fetchImpl);
    expect(outcome).toEqual({ ok: true, branch: "fix/pane-heights", workspaceId: "fix-pane-heights", differsFromHead: false });
    expect(calls.map(call => call.body)).toEqual([
      { sourceWorkspaceId: "atlas" },
      { sourceWorkspaceId: "atlas", mode: "remote-tracking", base: { kind: "remote", ref: "origin/fix/pane-heights" } },
    ]);
  });

  test("a same-repository head branch that exists locally is checked out as it is", async () => {
    const { calls, fetchImpl } = hub({
      fetch: [{ ok: true, refs: { local: ["main", "fix/pane-heights"], remote: ["origin/fix/pane-heights"], fetchedAt: 1 } }],
      create: [created("fix/pane-heights")],
    });
    await checkOutPullRequest("/api/hub/worktrees", "atlas", sameRepository, fetchImpl);
    expect(calls[1]!.body).toEqual({ sourceWorkspaceId: "atlas", mode: "existing-local", base: { kind: "local", ref: "fix/pane-heights" } });
  });

  test("refusals and failures come back as one sentence, and nothing is retried", async () => {
    const refusal = { ok: false, operationId: "o", kind: "create", phase: "validating", error: { code: "ref-unavailable", message: "Pull request #639 was not found on origin.", retry: "none" } };
    let { calls, fetchImpl } = hub({ create: [refusal] });
    expect(await checkOutPullRequest("/api/hub/worktrees", "atlas", fork, fetchImpl)).toEqual({ ok: false, message: "Pull request #639 was not found on origin." });
    expect(calls.length).toBe(1);

    ({ calls, fetchImpl } = hub({ fetch: [{ ok: false, error: { code: "fetch-network", message: "Could not reach origin.", retry: "retry-fetch" } }] }));
    expect(await checkOutPullRequest("/api/hub/worktrees", "atlas", sameRepository, fetchImpl)).toEqual({ ok: false, message: "Could not reach origin." });

    ({ calls, fetchImpl } = hub({ fetch: [{ ok: true, refs: { local: ["main"], remote: ["origin/main"], fetchedAt: 1 } }] }));
    const gone = await checkOutPullRequest("/api/hub/worktrees", "atlas", sameRepository, fetchImpl);
    expect(gone.ok === false && gone.message).toBe("origin has no branch fix/pane-heights. It may have been deleted or renamed; nothing was created.");
    expect(calls.length).toBe(1);

    ({ fetchImpl } = hub({}));
    expect(await checkOutPullRequest("/api/hub/worktrees", "atlas", fork, fetchImpl)).toEqual({ ok: false, message: "The Hub did not answer. Nothing was retried; try again." });

    const retained = { ...refusal, phase: "registering", error: { code: "registration-failed", message: "The checkout was created but could not be registered.", retry: "retry-registration" }, retainedCheckout: { ...checkout("pr/639", "0123456789ab"), registered: false, workspaceId: undefined } };
    delete (retained.retainedCheckout as Record<string, unknown>).workspaceId;
    ({ fetchImpl } = hub({ create: [retained] }));
    const kept = await checkOutPullRequest("/api/hub/worktrees", "atlas", fork, fetchImpl);
    expect(kept.ok === false && kept.message).toBe("The checkout was created but could not be registered. The checkout was kept; finish it from the Hub dashboard.");
  });
});
