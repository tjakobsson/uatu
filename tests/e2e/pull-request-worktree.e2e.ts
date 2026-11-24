import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

import { captureScreenshot } from "./evidence";
import { expect, openHubMenu, test } from "./hub-fixtures";

// Checking a pull request out as a worktree from the switcher, through a real
// Hub and real Git (add-github-pr-review D12, task 4.4; workspace switcher
// phase 3). The child serves the in-memory GitHub fake (#639 is a fork's
// pull request, #636 a branch of the repository itself); the "GitHub
// repository" is a local bare remote whose `refs/pull/639/head` is written
// with `git update-ref`, the ref GitHub publishes. Nothing reaches GitHub.

const exec = promisify(execFile);
test.use({ hubWorktrees: true, hubGithubFake: true, hubWorkspaces: ["prs"], viewport: { width: 1440, height: 1000 } });

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file" };
async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Uatu Test", "-c", "user.email=uatu@example.test", ...args], { cwd, env: gitEnv })).stdout.trim();
}

// The workspace's repository gains `origin`: a bare remote holding a fork's
// pull request head and a same-repository head branch.
async function simulateGithub(repository: string): Promise<{ fork: string; sameRepository: string }> {
  const remote = path.join(path.dirname(repository), "prs-github.git");
  const contributor = path.join(path.dirname(repository), "prs-contributor");
  await git(path.dirname(repository), ["clone", "--quiet", "--bare", repository, remote]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(path.dirname(repository), ["clone", "--quiet", remote, contributor]);
  const publish = async (ref: string, file: string) => {
    await git(contributor, ["checkout", "--quiet", "--detach", "main"]);
    await mkdir(path.join(contributor, "docs"), { recursive: true });
    await writeFile(path.join(contributor, "docs", file), `# ${file}\n`);
    await git(contributor, ["add", "docs"]);
    await git(contributor, ["commit", "--quiet", "-m", file]);
    await git(contributor, ["push", "--quiet", remote, `HEAD:${ref}`]);
    return git(contributor, ["rev-parse", "HEAD"]);
  };
  const fork = await publish("refs/pull/639/head", "fork.md");
  const sameRepository = await publish("refs/heads/fix/pane-heights", "pane-heights.md");
  return { fork, sameRepository };
}

async function inventory(page: Page, source: string) {
  const response = await page.request.get(`/api/hub/worktrees?source=${encodeURIComponent(source)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).inventory as { checkouts: { branch: string | null; path: string; sourceRef?: string; workspaceId?: string }[] };
}

async function choosePullRequest(page: Page, number: number) {
  await openHubMenu(page);
  const search = page.locator("#switcher-search");
  await search.fill(String(number));
  await page.locator(`[data-pr-row="${number}"]`).click();
}

test("a fork's and a same-repository pull request become worktrees; you stay, then Go to", async ({ hub, hubContext }, info) => {
  test.setTimeout(90_000);
  const workspace = hub.workspaces[0]!;
  const heads = await simulateGithub(workspace.path);
  const page = await hubContext.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(workspace.sessionUrl);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

  // The fork's pull request: View here or Check out as a worktree….
  await choosePullRequest(page, 639);
  const step = page.locator("#switcher-step");
  await step.getByRole("button", { name: "Check out #639 as a worktree…" }).click();
  await expect(step).toContainText("prs.worktrees/pr-639");
  await expect(step).toContainText("From a fork: uatu won't push back to it.");
  await expect(step).not.toContainText("Simulated");
  await captureScreenshot(page, info, "pull-request-worktree-confirm");
  await step.getByRole("button", { name: "Create worktree" }).click();

  // You stay here; the notice offers Go to once the Hub has created it.
  const notice = page.locator("#switcher-ready");
  await expect(notice).toContainText("pr/639 is ready.");
  expect(new URL(page.url()).pathname.startsWith(`/s/${workspace.id}/`)).toBe(true);
  await captureScreenshot(page, info, "pull-request-worktree-ready");
  const fork = (await inventory(page, workspace.id)).checkouts.find(checkout => checkout.branch === "pr/639")!;
  expect(fork.sourceRef).toBe("refs/pull/639/head");
  expect(await git(fork.path, ["rev-parse", "HEAD"])).toBe(heads.fork);
  expect(await git(workspace.path, ["config", "--get", "branch.pr/639.merge"])).toBe("refs/pull/639/head");

  // Checked out now: the pull request offers Go to its worktree first.
  await choosePullRequest(page, 639);
  await expect(step.locator("[data-choice]").first()).toHaveAttribute("aria-label", "Go to its worktree, pr/639");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#hub-menu")).toBeHidden();

  // The same repository's pull request: its own head branch, pushable.
  await choosePullRequest(page, 636);
  await step.getByRole("button", { name: "Check out #636 as a worktree…" }).click();
  await expect(step).not.toContainText("From a fork");
  await step.getByRole("button", { name: "Create worktree" }).click();
  await expect(notice).toContainText("fix/pane-heights is ready.");
  const same = (await inventory(page, workspace.id)).checkouts.find(checkout => checkout.branch === "fix/pane-heights")!;
  expect(same.sourceRef).toBe("origin/fix/pane-heights");
  expect(await git(same.path, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/fix/pane-heights");
  expect(await git(same.path, ["rev-parse", "HEAD"])).toBe(heads.sameRepository);

  // Go to: the stopped checkout starts, and the page moves there.
  await notice.getByRole("button", { name: "Go to fix/pane-heights" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${same.workspaceId}/`), { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("a pull request whose head the remote does not have stays on its row as Couldn't create, with the reason", async ({ hub, hubContext }) => {
  test.setTimeout(60_000);
  const workspace = hub.workspaces[0]!;
  const page = await hubContext.newPage();
  await page.goto(workspace.sessionUrl);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  // #627's head branch is not on the remote (whichever test ran first, and
  // whether or not the workspace has a remote yet): nothing is created.
  await choosePullRequest(page, 627);
  const step = page.locator("#switcher-step");
  await step.getByRole("button", { name: "Check out #627 as a worktree…" }).click();
  await step.getByRole("button", { name: "Create worktree" }).click();
  const row = page.locator('#switcher-creating [data-creating-row="627"]');
  await expect(row).toContainText("Couldn't create");
  await row.locator("[data-creating-open]").click();
  await expect(step).toContainText("origin has no branch docs/worktree-cleanup. It may have been deleted or renamed; nothing was created.");
  await expect(step.getByRole("button", { name: "Retry checking out #627 as a worktree" })).toBeVisible();
  expect((await inventory(page, workspace.id)).checkouts.some(checkout => checkout.branch === "docs/worktree-cleanup")).toBe(false);
});
