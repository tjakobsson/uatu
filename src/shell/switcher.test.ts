import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { githubApi } from "../github/client";
import { pullRequestStore } from "../github/pull-request-store";
import type { GithubSummary, PullRequestList, PullRequestListItem } from "../shared/github-contract";
import { initSwitcher, OPEN_PULL_REQUEST_EVENT, openSwitcher, refreshSwitcher, registerSwitcherHub, resetSwitcherForTests, SHOW_BRANCH_EVENT, type SwitcherHub } from "./switcher";

// The switcher outside the Hub's part (hub-nav.test.ts covers Checkouts):
// the chip, the button and the strips; Pull requests; the choice step.
// What the e2e suites drive end to end is theirs alone: the rows, marks and
// Show all, the filter menu, search, the repository heading and selector
// (workspace-switcher.e2e.ts, pull-request-read.e2e.ts), Go to its worktree
// and creating a pull request's worktree (pull-request-worktree.e2e.ts).

const savedGlobals = new Map<string, unknown>();
const setGlobal = (key: string, value: unknown) => {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Reflect.get(globalThis, key));
  Reflect.set(globalThis, key, value);
};
const savedApi = { ...githubApi };

afterEach(() => {
  resetSwitcherForTests();
  Object.assign(githubApi, savedApi);
  pullRequestStore.select(null);
  pullRequestStore.state = { repositoryId: null, branch: null, enabled: null, summary: null, loading: false, error: null, retry: null };
  for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
  savedGlobals.clear();
});

const item = (number: number, overrides: Partial<PullRequestListItem> = {}): PullRequestListItem => ({
  number, title: `Pull request ${number}`, author: "octo-cat", headRefName: `branch-${number}`, headOwner: "octo-org",
  isCrossRepository: false, isDraft: false, reviewDecision: null, viewerReviewRequested: false,
  checks: { state: "SUCCESS", passed: 1, failed: 0, pending: 0 }, updatedAt: "2026-11-24T00:00:00Z", viewerPendingComments: 0,
  ...overrides,
});

async function mount(options: { touch?: boolean; hub?: Partial<SwitcherHub> } = {}) {
  const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
  const { document, window } = parseHTML(html);
  if (options.touch) document.documentElement.dataset.uiMode = "touch";
  setGlobal("document", document);
  setGlobal("window", window);
  setGlobal("Node", (window as unknown as Record<string, unknown>).Node);
  setGlobal("CustomEvent", (window as unknown as Record<string, unknown>).CustomEvent);
  setGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  const list: PullRequestList = {
    mock: true, viewer: "octo-reviewer", repository: { host: "github.com", owner: "octo-org", name: "uatu" },
    pullRequests: [item(642, { headRefName: "feat/view-pr" }), item(639, { isCrossRepository: true }), item(636, { headRefName: "fix/pane-heights" }), item(631, { isDraft: true }), item(627, { viewerReviewRequested: true })],
  };
  githubApi.pullRequests = async () => list;
  pullRequestStore.state = { repositoryId: "repo", branch: "feat/view-pr", enabled: true, summary: null, loading: false, error: null, retry: null };
  pullRequestStore.applySummary({
    status: "ready", mock: true, repository: list.repository, viewer: "octo-reviewer", checkedAt: 0, stale: false,
    pullRequest: { number: 642, headRefName: "feat/view-pr", isCrossRepository: false } as GithubSummary["pullRequest"],
  });
  initSwitcher();
  if (options.hub) {
    registerSwitcherHub({
      facts: () => ({ repository: "uatu", name: "feat/view-pr", branchLike: true, running: true, dotClass: "indicator-dot is-live", badge: null, badgeLabel: "", start: null }),
      renderCheckouts: () => {},
      newControl: () => null,
      startCurrent: () => {},
      findCheckout: () => null,
      goTo: () => {},
      repositoryName: () => "uatu",
      canCreateWorktree: () => true,
      footerLinks: () => [],
      refresh: () => {},
      ...options.hub,
    });
  }
  const events: { type: string; detail: unknown }[] = [];
  for (const type of [OPEN_PULL_REQUEST_EVENT, SHOW_BRANCH_EVENT]) {
    document.addEventListener(type, event => events.push({ type, detail: (event as CustomEvent).detail }));
  }
  const menu = document.querySelector<HTMLElement>("#hub-menu")!;
  const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
  const key = (target: EventTarget, name: string) => target.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true }), { key: name }));
  const settle = () => Bun.sleep(5);
  return { document, window, menu, click, key, settle, events };
}

describe("the switcher's faces", () => {
  test("with GitHub data and no Hub: the chip and the touch button name the branch; viewing adds the eye pill and the strips", async () => {
    const page = await mount();
    expect(page.document.querySelector<HTMLElement>("#hub-control")!.hidden).toBe(false);
    const button = page.document.querySelector<HTMLElement>("#switcher-button")!;
    expect(button.hidden).toBe(false);
    expect(button.querySelector(".touch-switcher-name")!.textContent).toBe("feat/view-pr");
    expect(button.querySelector<HTMLElement>(".switcher-eye-pill")!.hidden).toBe(true);
    expect(page.document.querySelector<HTMLElement>("#viewing-strip-files")!.hidden).toBe(true);

    pullRequestStore.select(639);
    expect(button.querySelector<HTMLElement>(".switcher-eye-pill")!.hidden).toBe(false);
    expect(button.querySelector(".switcher-eye-pill-number")!.textContent).toBe("#639");
    expect(button.getAttribute("aria-label")).toBe("Switch. Working in uatu, feat/view-pr. Viewing pull request 639.");
    const strip = page.document.querySelector<HTMLElement>("#viewing-strip-preview")!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain("Viewing #639");
    const back = strip.querySelector<HTMLElement>("[data-switcher-back]")!;
    expect(back.textContent).toBe("← Back to feat/view-pr");
    expect(back.getAttribute("aria-label")).toBe("Back to feat/view-pr");
    expect(page.document.querySelector("#switcher-chip-viewing")!.textContent).toContain("Viewing #639");

    page.click(back);
    expect(page.events).toEqual([{ type: SHOW_BRANCH_EVENT, detail: { focus: "heading" } }]);
  });

  test("without a Hub or GitHub data the switcher is not offered", async () => {
    const page = await mount();
    pullRequestStore.state = { ...pullRequestStore.state, enabled: false };
    refreshSwitcher();
    expect(page.document.querySelector<HTMLElement>("#switcher-button")!.hidden).toBe(true);
    expect(page.document.querySelector<HTMLElement>("#hub-control")!.hidden).toBe(true);
  });
});

describe("the switcher's Pull requests", () => {
  test("opened from the Pull request pane's search, the opening click does not close it again", async () => {
    const page = await mount();
    const browse = page.document.querySelector<HTMLElement>("#pull-request-browse")!;
    browse.addEventListener("click", () => openSwitcher({ opener: browse, section: "pull-requests" }));
    page.click(browse);
    expect(page.menu.hidden).toBe(false);
    // A click elsewhere still closes it.
    page.click(page.document.querySelector("#preview-title")!);
    expect(page.menu.hidden).toBe(true);
  });

  test("no credential: one line of guidance, no rows", async () => {
    const page = await mount();
    pullRequestStore.applySummary({ status: "no-credential", mock: true, repository: null, viewer: null, checkedAt: 0, stale: false });
    openSwitcher();
    await page.settle();
    expect(page.menu.querySelector("#switcher-pr-notes .gh-connect-line")).not.toBeNull();
    expect(page.menu.querySelectorAll("#switcher-pull-requests [role=option]")).toHaveLength(0);
  });
});

describe("choosing a pull request in a Hub", () => {
  test("not checked out: View here or Check out as a worktree…, then a simulated confirmation; Escape steps back, then closes", async () => {
    const page = await mount({ hub: {} });
    openSwitcher();
    await page.settle();
    page.click(page.menu.querySelector('[data-pr-row="639"]')!);
    const step = page.menu.querySelector<HTMLElement>("#switcher-step")!;
    expect(step.hidden).toBe(false);
    expect(page.menu.getAttribute("data-step")).toBe("choice");
    const choices = [...step.querySelectorAll<HTMLElement>("[data-choice]")];
    expect(choices.map(choice => choice.getAttribute("aria-label"))).toEqual(["View #639 here", "Check out #639 as a worktree…"]);
    expect(choices[0]!.classList.contains("is-default")).toBe(true);
    expect(choices[0]!.textContent).toContain("Terminal and agent stay on feat/view-pr");
    expect(choices[1]!.textContent).toContain("New folder pr-639, on branch pr/639");

    page.click(choices[1]!);
    expect(step.textContent).toContain("uatu.worktrees/pr-639");
    expect(step.textContent).toContain("From a fork: uatu won't push back to it.");
    expect(step.textContent).toContain("You stay here and get a notice when it's ready.");
    page.click(step.querySelector('[data-choice="create"]')!);
    expect(step.textContent).toContain("Simulated: no worktree was created");

    page.key(page.document, "Escape");
    expect(page.menu.getAttribute("data-step")).toBe("choice");
    page.key(page.document, "Escape");
    expect(page.menu.hasAttribute("data-step")).toBe(false);
    expect(page.menu.hidden).toBe(false);
    page.key(page.document, "Escape");
    expect(page.menu.hidden).toBe(true);
  });

  test("the branch's own pull request while viewing another is Back", async () => {
    const page = await mount({ hub: {} });
    pullRequestStore.select(639);
    openSwitcher();
    await page.settle();
    page.click(page.menu.querySelector('[data-pr-row="642"]')!);
    expect(page.menu.hidden).toBe(true);
    expect(page.events).toEqual([{ type: SHOW_BRANCH_EVENT, detail: { focus: "heading" } }]);
  });
});
