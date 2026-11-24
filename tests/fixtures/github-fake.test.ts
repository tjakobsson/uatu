// FakeGitHub's own controls (task 1.4): each scenario answers the way GitHub
// does, and an operation the fake doesn't know fails loudly.

import { describe, expect, test } from "bun:test";

import { GitHubApi } from "../../src/github/api";
import { FakeGitHub } from "./github-fake";

const summary = { name: "UatuPullRequestSummary", query: "query UatuPullRequestSummary { x }" };
const vars = { owner: "acme", name: "widgets", number: 42 };

describe("FakeGitHub", () => {
  test("answers a known operation from the fixture", async () => {
    const fake = new FakeGitHub();
    const answer = await new GitHubApi(fake).graphql<{ repository: { pullRequest: { number: number } } }>("github.com", summary, vars);
    expect(answer.data.repository.pullRequest.number).toBe(42);
    expect(fake.operations()).toEqual(["UatuPullRequestSummary"]);
  });

  test("an unknown operation throws instead of answering empty data", async () => {
    await expect(new FakeGitHub().request({ kind: "graphql", host: "github.com", operation: "UatuSomethingNew", query: "q", variables: {} })).rejects.toThrow(/unknown operation/);
    await expect(new FakeGitHub().request({ kind: "rest", host: "github.com", operation: "UatuOther", path: "repos/acme/widgets" })).rejects.toThrow(/unknown operation/);
  });

  test("pushHead and setMergeability change what later answers say", async () => {
    const fake = new FakeGitHub();
    fake.pushHead(42, "f".repeat(40));
    fake.setMergeability(42, "CONFLICTING", "DIRTY");
    const answer = await new GitHubApi(fake).graphql<{ repository: { pullRequest: Record<string, unknown> } }>("github.com", summary, vars);
    expect(answer.data.repository.pullRequest).toMatchObject({ headRefOid: "f".repeat(40), mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
  });

  test("rate limits, no credential, no access, unavailable and timeout classify as GitHub's would", async () => {
    let now = 1_000_000;
    const fake = new FakeGitHub({ now: () => now });
    const api = new GitHubApi(fake, () => now);
    fake.setRateLimit({ kind: "primary", resetAt: now + 60_000 });
    await expect(api.graphql("github.com", summary, vars)).rejects.toMatchObject({ kind: "rate-limited", retryAt: now + 60_000 });
    await expect(api.rest("github.com", "UatuPullRequestFiles", "repos/acme/widgets/pulls/42/files?per_page=100&page=1")).rejects.toMatchObject({ kind: "rate-limited" });
    fake.setRateLimit({ kind: "secondary", resetAt: now + 30_000 });
    await expect(api.graphql("github.com", summary, vars)).rejects.toMatchObject({ kind: "rate-limited", retryAt: now + 30_000 });
    now += 31_000;
    await expect(api.graphql("github.com", summary, vars)).resolves.toBeTruthy();
    for (const [failure, kind] of [["no-credential", "no-credential"], ["sso", "sso"], ["unavailable", "unavailable"], ["timeout", "timeout"]] as const) {
      fake.setFailure(failure);
      await expect(api.graphql("github.com", summary, vars)).rejects.toMatchObject({ kind });
    }
    // A repository the token can't see is GraphQL data with a null
    // repository and a NOT_FOUND error at its path.
    fake.setFailure("not-found");
    const answer = await api.graphql<{ repository: unknown }>("github.com", summary, vars);
    expect(answer.data.repository).toBeNull();
    expect(api.sectionFailure(answer, ["repository"])?.kind).toBe("not-found");
  });

  test("checks a token can't read come back as a partial answer", async () => {
    const fake = new FakeGitHub();
    fake.setChecksForbidden(true);
    const api = new GitHubApi(fake);
    const answer = await api.graphql("github.com", summary, vars);
    expect(api.sectionFailure(answer, ["repository", "pullRequest", "lastCommit"])?.kind).toBe("forbidden");
  });

  test("reset restores the fixture", async () => {
    const fake = new FakeGitHub();
    fake.pushHead(42, "0".repeat(40));
    fake.setFailure("unavailable");
    fake.reset();
    expect(fake.record(42).headRefOid).toBe("4242424242424242424242424242424242424242");
    await expect(new GitHubApi(fake).graphql("github.com", summary, vars)).resolves.toBeTruthy();
  });
});
