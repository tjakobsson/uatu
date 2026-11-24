// Shared by the pull request e2e files that run the real service over the
// transport fake (`github: "transport"`, tests/fixtures/github-fake.ts).

import type { APIRequestContext, Page } from "@playwright/test";

import { expect } from "./fixtures";

export type OwnPullRequestOptions = {
  base?: "exact" | "stale" | "missing";
  // #42's changed files (committed on the branch, or written by `commit`).
  files?: string[];
  // Files written and committed on the branch before it becomes #42's head.
  commit?: Record<string, string>;
  // Moves #42's line threads (a current one, an old-side one and an
  // outdated one) to this file.
  threadPath?: string;
};

// `/__e2e/github` makes fixture pull request #42 the workspace's own: the
// checkout moves to its head branch `feature/login` at HEAD and a local bare
// remote stands in for GitHub's Git side (tests/e2e/server.ts).
export async function ownPullRequest(page: Page, request: APIRequestContext, options: OwnPullRequestOptions = {}): Promise<{ head: string }> {
  await request.post("/__e2e/reset", { data: { git: true, github: "transport" } });
  const response = await request.post("/__e2e/github", {
    data: { action: "own-pull-request", files: ["feature.md"], base: "exact", ...options },
  });
  expect(response.ok()).toBe(true);
  // Writes (the fetch) carry the workspace credential, as a session URL
  // printed by the CLI does. Loading the page asks for the GitHub summary,
  // which sets the base and collects Git data again.
  const { token } = await request.get("/__e2e/terminal-token").then(answer => answer.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await page.goto("/");
  return await response.json() as { head: string };
}

// #42 gets a commit on GitHub only (root-level files rewritten); the
// checkout doesn't have it until a fetch.
export async function pushPullRequestHead(request: APIRequestContext, files: Record<string, string>): Promise<string> {
  const response = await request.post("/__e2e/github", { data: { action: "push-head", files } });
  expect(response.ok()).toBe(true);
  return (await response.json() as { head: string }).head;
}

// The Pull request pane's Refresh: a manual refresh asks GitHub at once.
export async function refreshPullRequest(page: Page): Promise<void> {
  await page.locator("#pull-request-refresh").click();
}
