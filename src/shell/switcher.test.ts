import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { githubApi } from "../github/client";
import { pullRequestStore } from "../github/pull-request-store";
import type { GithubSummary, PullRequestList, PullRequestListItem } from "../shared/github-contract";
import { initSwitcher, OPEN_PULL_REQUEST_EVENT, openSwitcher, refreshSwitcher, registerSwitcherHub, resetSwitcherForTests, SHOW_BRANCH_EVENT, type SwitcherHub } from "./switcher";

// The switcher outside the Hub's part (hub-nav.test.ts covers Checkouts):
// the chip, the button and the strips; Pull requests; the choice step.

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
  // Waits for what a test asserts on (a Hub answer handled, an announcement
  // made), not for a fixed delay: under a loaded run the chain behind a
  // released fetch can outlast one settle.
  const until = async (ready: () => boolean, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the switcher");
      await settle();
    }
  };
  return { document, window, menu, click, key, settle, until, events };
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
  test("the first three rows, Show all, the marks; outside a Hub a row views the pull request here", async () => {
    const page = await mount();
    pullRequestStore.select(639);
    openSwitcher();
    await page.settle();
    const rows = () => [...page.menu.querySelectorAll<HTMLElement>("#switcher-pull-requests [role=option]")];
    // #627 requests the viewer's review: it sorts first.
    expect(rows().map(row => row.dataset.prRow)).toEqual(["627", "642", "639"]);
    expect(page.menu.querySelector("#switcher-checkouts-section")!.hasAttribute("hidden")).toBe(true);
    expect(page.menu.querySelector("#switcher-footer")!.hasAttribute("hidden")).toBe(true);
    const viewed = rows().find(row => row.dataset.prRow === "639")!;
    expect(viewed.classList.contains("is-viewing")).toBe(true);
    expect(viewed.getAttribute("aria-label")).toContain("Viewing");
    expect(viewed.querySelector(".switcher-row-line2")!.textContent).toBe("octo-cat·Fork·✓ checks");
    // The branch's own pull request is checked out.
    expect(rows().find(row => row.dataset.prRow === "642")!.querySelector(".switcher-row-mark.is-checked-out")).not.toBeNull();
    // The status card: both facts.
    expect(page.menu.querySelector("#switcher-status")!.textContent).toContain("Not checked out · terminal stays on feat/view-pr");

    page.click(page.menu.querySelector("[data-switcher-show-all]")!);
    expect(rows()).toHaveLength(5);

    page.click(rows().find(row => row.dataset.prRow === "636")!);
    expect(page.menu.hidden).toBe(true);
    expect(page.events).toEqual([{ type: OPEN_PULL_REQUEST_EVENT, detail: { repositoryId: "repo", number: 636 } }]);
  });

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

  test("the filter menu keeps its pull requests and gives focus back to its toggle", async () => {
    const page = await mount();
    openSwitcher();
    await page.settle();
    page.click(page.menu.querySelector('[data-switcher-menu-toggle="filter"]')!);
    expect(page.menu.querySelector<HTMLElement>(".switcher-filter-menu")!.hidden).toBe(false);
    page.click(page.menu.querySelector('[data-switcher-filter="drafts"]')!);
    expect([...page.menu.querySelectorAll<HTMLElement>("#switcher-pull-requests [role=option]")].map(row => row.dataset.prRow)).toEqual(["631"]);
    expect(page.menu.querySelector('[data-switcher-menu-toggle="filter"]')!.textContent).toContain("Drafts");
  });

  test("a search folds the status card and filters the rows; Enter on the active row acts on it", async () => {
    const page = await mount();
    openSwitcher();
    await page.settle();
    const search = page.menu.querySelector<HTMLInputElement>("#switcher-search")!;
    search.value = "63";
    search.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    expect(page.menu.hasAttribute("data-searching")).toBe(true);
    expect([...page.menu.querySelectorAll<HTMLElement>("#switcher-pull-requests [role=option]")].map(row => row.dataset.prRow)).toEqual(["639", "636", "631"]);
    page.key(search, "ArrowUp");
    expect(search.getAttribute("aria-activedescendant")).toBe("switcher-pr-631");
    page.key(search, "Enter");
    expect(page.events.at(-1)).toEqual({ type: OPEN_PULL_REQUEST_EVENT, detail: { repositoryId: "repo", number: 631 } });
  });

  test("the heading names the repository the pull requests are from", async () => {
    const page = await mount();
    openSwitcher();
    await page.settle();
    const heading = page.menu.querySelector("#switcher-pull-requests-heading")!;
    expect(heading.textContent).toBe("Pull requests·octo-org/uatu");
    // One repository: plain text, no selector.
    expect(heading.querySelector("button")).toBeNull();
  });

  test("a workspace with two Git repositories gets a repository selector; the status card names the other repository beside what is viewed", async () => {
    const page = await mount();
    const snapshot = (id: string, label: string, branch: string) => ({ id, label, metadata: { status: "git", branch, commitShort: "abc1234" } }) as unknown as import("../shared/types").RepositorySnapshot;
    const docs = { host: "github.com", owner: "octo-org", name: "docs" };
    githubApi.summary = async repositoryId => ({ status: "no-pull-request", mock: true, repository: repositoryId === "docs" ? docs : { host: "github.com", owner: "octo-org", name: "uatu" }, viewer: "octo-reviewer", checkedAt: 0, stale: false });
    const uatuList = await githubApi.pullRequests("repo");
    githubApi.pullRequests = async repositoryId => repositoryId === "docs"
      ? { ...uatuList, repository: docs, pullRequests: [item(12, { title: "docs: search" })] }
      : uatuList;
    try {
      pullRequestStore.syncRepositories([snapshot("repo", "uatu", "feat/view-pr"), snapshot("docs", "docs-site", "main")]);
      await page.settle();
      openSwitcher();
      await page.settle();
      const toggle = () => page.menu.querySelector<HTMLElement>('[data-switcher-menu-toggle="repository"]')!;
      expect(toggle().textContent).toContain("octo-org/uatu");
      expect(toggle().getAttribute("aria-haspopup")).toBe("menu");
      page.click(toggle());
      const options = [...page.menu.querySelectorAll<HTMLElement>('[data-switcher-menu="repository"] [role=menuitemradio]')];
      // A repository not read yet is named by its local label.
      expect(options.map(option => [option.textContent, option.getAttribute("aria-checked")])).toEqual([["octo-org/uatu" + "uatu", "true"], ["docs-site", "false"]]);
      page.click(options[1]!);
      await page.settle();
      expect(pullRequestStore.state.repositoryId).toBe("docs");
      expect(page.menu.querySelector<HTMLElement>('[data-switcher-menu="repository"]')!.hidden).toBe(true);
      expect(toggle().textContent).toContain("octo-org/docs");
      expect([...page.menu.querySelectorAll<HTMLElement>("#switcher-pull-requests [role=option]")].map(row => row.dataset.prRow)).toEqual(["12"]);

      // Viewing #12 of the other repository: the status card says which.
      pullRequestStore.select(12);
      refreshSwitcher();
      expect(page.menu.querySelector(".switcher-status-viewing")!.textContent).toContain("octo-org/docs #12");
    } finally {
      pullRequestStore.syncRepositories([]);
    }
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

  describe("with the Hub's worktree service: Check out as a worktree… creates it", () => {
    const created = (branch: string, workspaceId: string) => ({
      ok: true, operationId: "o1", kind: "create", phase: "complete", registered: true, started: false, pullRequestHead: "0123456789ab",
      checkout: {
        checkoutId: "c1", repositoryId: "r1", workspaceId, parentWorkspaceId: "uatu", path: `/src/uatu.worktrees/${workspaceId}`, branch,
        detached: false, main: false, ownership: "uatu", availability: "present", registered: true, running: false, locked: false, head: "0123456789ab",
      },
    });
    // A Hub whose answers wait until the test releases them.
    function hubFetch(answer: unknown) {
      const requests: { url: string; body: unknown }[] = [];
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      setGlobal("fetch", async (url: string, init?: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init?.body)) });
        await released;
        return Response.json(answer);
      });
      return { requests, release };
    }

    test("you stay here: Creating… under Checkouts, Checking out… on the row, then a notice offers Go to", async () => {
      const goTo: string[] = [];
      let refreshes = 0;
      const page = await mount({ hub: {
        worktreeSource: () => ({ api: "/api/hub/worktrees", sourceId: "uatu" }),
        goTo: id => { goTo.push(id); },
        refresh: () => { refreshes += 1; },
      } });
      const hub = hubFetch(created("pr/639", "pr-639"));
      openSwitcher();
      await page.settle();
      page.click(page.menu.querySelector('[data-pr-row="639"]')!);
      page.click(page.menu.querySelector('#switcher-step [data-choice="check-out"]')!);
      const step = page.menu.querySelector<HTMLElement>("#switcher-step")!;
      expect(step.textContent).not.toContain("Simulated");
      expect(step.textContent).toContain("pull/639/head from the base repository (origin)");
      page.click(step.querySelector('[data-choice="create"]')!);

      // Back on the lists, nothing navigated.
      expect(page.menu.hasAttribute("data-step")).toBe(false);
      expect(page.menu.hidden).toBe(false);
      expect(hub.requests).toEqual([{ url: "/api/hub/worktrees/create", body: { sourceWorkspaceId: "uatu", mode: "pull-request", pullRequest: { number: 639, remote: "origin" } } }]);
      const creating = page.menu.querySelector<HTMLElement>('#switcher-creating [data-creating-row="639"]')!;
      expect(creating.textContent).toContain("pr/639");
      expect(creating.textContent).toContain("Creating…");
      expect(page.menu.querySelector("#switcher-creating")!.hasAttribute("hidden")).toBe(false);
      expect(page.menu.querySelector('[data-pr-row="639"]')!.textContent).toContain("Checking out…");
      // Choosing it again cannot start it twice.
      page.click(page.menu.querySelector('[data-pr-row="639"]')!);
      expect([...step.querySelectorAll<HTMLElement>("[data-choice]")].map(choice => choice.dataset.choice)).toEqual(["view"]);
      expect(step.textContent).toContain("Checking out…");
      page.key(page.document, "Escape");
      // Closing the dialog cancels nothing.
      page.key(page.document, "Escape");
      expect(page.menu.hidden).toBe(true);

      hub.release();
      await page.until(() => page.document.querySelector<HTMLElement>("#switcher-ready")?.hidden === false);
      expect(refreshes).toBeGreaterThan(0);
      const notice = page.document.querySelector<HTMLElement>("#switcher-ready")!;
      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toContain("pr/639 is ready.");
      openSwitcher();
      expect(page.menu.querySelector('#switcher-creating [data-creating-row]')).toBeNull();
      page.click(notice.querySelector("[data-ready-go]")!);
      expect(goTo).toEqual(["pr-639"]);
      expect(notice.hidden).toBe(true);
    });

    test("a failure stays on its row with the reason and Retry", async () => {
      const page = await mount({ hub: { worktreeSource: () => ({ api: "/api/hub/worktrees", sourceId: "uatu" }) } });
      const refusal = { ok: false, operationId: "o", kind: "create", phase: "validating", error: { code: "ref-unavailable", message: "Pull request #639 was not found on origin: it has no refs/pull/639/head.", retry: "none" } };
      const hub = hubFetch(refusal);
      hub.release();
      openSwitcher();
      await page.settle();
      page.click(page.menu.querySelector('[data-pr-row="639"]')!);
      page.click(page.menu.querySelector('#switcher-step [data-choice="check-out"]')!);
      page.click(page.menu.querySelector('#switcher-step [data-choice="create"]')!);
      await page.until(() => page.document.querySelector("#switcher-live")!.textContent!.includes("Couldn't create"));
      const row = page.menu.querySelector<HTMLElement>('#switcher-creating [data-creating-row="639"]')!;
      expect(row.textContent).toContain("Couldn't create");
      expect(page.document.querySelector("#switcher-live")!.textContent).toContain("Couldn't create pr/639.");
      page.click(row.querySelector("[data-creating-open]")!);
      const step = page.menu.querySelector<HTMLElement>("#switcher-step")!;
      expect(step.textContent).toContain("not found on origin");
      expect([...step.querySelectorAll<HTMLElement>("[data-choice]")].map(choice => choice.dataset.choice)).toEqual(["view", "retry"]);
      page.click(step.querySelector('[data-choice="retry"]')!);
      expect(hub.requests).toHaveLength(2);
      expect(page.menu.hasAttribute("data-step")).toBe(false);
    });

    test("a same-repository pull request fetches, then tracks its head branch", async () => {
      const page = await mount({ hub: { worktreeSource: () => ({ api: "/api/hub/worktrees", sourceId: "uatu" }) } });
      const requests: { url: string; body: unknown }[] = [];
      setGlobal("fetch", async (url: string, init?: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json(url.endsWith("/fetch")
          ? { ok: true, refs: { local: ["main"], remote: ["origin/fix/pane-heights"], fetchedAt: 1 } }
          : created("fix/pane-heights", "fix-pane-heights"));
      });
      openSwitcher();
      await page.settle();
      page.click(page.menu.querySelector("[data-switcher-show-all]")!);
      page.click(page.menu.querySelector('[data-pr-row="636"]')!);
      page.click(page.menu.querySelector('#switcher-step [data-choice="check-out"]')!);
      expect(page.menu.querySelector("#switcher-step")!.textContent).not.toContain("From a fork");
      page.click(page.menu.querySelector('#switcher-step [data-choice="create"]')!);
      await page.settle();
      expect(requests.map(request => request.body)).toEqual([
        { sourceWorkspaceId: "uatu" },
        { sourceWorkspaceId: "uatu", mode: "remote-tracking", base: { kind: "remote", ref: "origin/fix/pane-heights" } },
      ]);
      expect(page.document.querySelector("#switcher-ready")!.textContent).toContain("fix/pane-heights is ready.");
    });
  });

  test("already checked out: Go to its worktree first, View here second", async () => {
    const goTo: string[] = [];
    const page = await mount({ hub: {
      findCheckout: branch => branch === "fix/pane-heights" ? { id: "uatu-fix", label: "fix/pane-heights", current: false, state: "Awaiting you", tone: "awaiting" } : null,
      goTo: id => { goTo.push(id); },
    } });
    openSwitcher();
    await page.settle();
    page.click(page.menu.querySelector("[data-switcher-show-all]")!);
    page.click(page.menu.querySelector('[data-pr-row="636"]')!);
    const choices = [...page.menu.querySelectorAll<HTMLElement>("#switcher-step [data-choice]")];
    expect(choices.map(choice => choice.dataset.choice)).toEqual(["go", "view"]);
    expect(choices[0]!.textContent).toContain("Opens fix/pane-heights");
    page.click(choices[0]!);
    expect(goTo).toEqual(["uatu-fix"]);
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
