// Shared by the pull request e2e files: the in-memory GitHub fake (the e2e
// server's reset with `github: true` or a scenario name; src/github/fake.ts,
// seeds src/github/fake-data.ts) and the real service over the transport
// fake (`github: "transport"`, tests/fixtures/github-fake.ts), plus the
// layout checks the touch suites share (hit tests at a control's centre,
// 44px targets). Nothing here reaches GitHub.

import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { expect, standardBeforeEach } from "./fixtures";

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

export const PORTRAIT = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } as const;
export const LANDSCAPE = { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true } as const;

// Writes (a fetch, a comment, a review) carry the workspace credential, as a
// session URL printed by the CLI does: `/?t=<token>` sets its cookie.
export async function signIn(page: Page, request: APIRequestContext): Promise<void> {
  const { token } = await request.get("/__e2e/terminal-token").then(answer => answer.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
}

// Desktop: the standard baseline, then a Git workspace whose GitHub routes
// answer from the fake (`true` or a scenario name) or the real service.
export async function resetGithub(page: Page, request: APIRequestContext, github: boolean | string = true, extra: Record<string, unknown> = {}): Promise<void> {
  await standardBeforeEach(page, request);
  await request.post("/__e2e/reset", { data: { git: true, github, ...extra } });
  await signIn(page, request);
}

// Touch (a coarse pointer: `test.use(PORTRAIT)` or LANDSCAPE): the same
// workspace, with the browser's stored preferences cleared so every touch
// default (the accordion, the review hint) starts fresh.
export async function resetTouchGithub(page: Page, request: APIRequestContext, github: boolean | string = true): Promise<void> {
  await request.post("/__e2e/reset", { data: { git: true, github } });
  await page.goto("/");
  await page.evaluate(() => {
    try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* best-effort */ }
  });
  await signIn(page, request);
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
}

// The fake's scenario, switched the way its own pane control does
// (`Mock scenario`), for a page already showing the pane.
export async function chooseScenario(page: Page, scenario: string): Promise<void> {
  const select = page.locator("[data-pr-scenario]");
  if (!(await select.isVisible())) await openPullRequestPane(page);
  await select.selectOption(scenario);
}

// The session's one Git repository's id, as `?repository=` names it.
export async function repositoryId(page: Page, index = 0): Promise<string> {
  const state = await page.request.get("/api/state").then(answer => answer.json()) as { repositories: { id: string; rootPath: string }[] };
  return state.repositories[index]!.id;
}

// A write through the session's own API from the page (so it carries the
// page's origin and credential, as the UI's own writes do).
async function githubWrite(page: Page, path: string, body: Record<string, unknown>): Promise<void> {
  const answer = await page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: response.ok, text: response.ok ? "" : await response.text() };
  }, { path, body });
  expect(answer.ok, answer.text).toBe(true);
}

// A pending review comment made through the API, not the UI: a precondition
// for the dialogs and indicators a test then drives with real clicks.
export async function addPendingComment(page: Page, number: number, path: string, line: number, side: "LEFT" | "RIGHT" = "RIGHT", body = "A pending note"): Promise<void> {
  const repository = await repositoryId(page);
  const detail = await page.request.get(`/api/github/pull-request?repository=${encodeURIComponent(repository)}&number=${number}`).then(answer => answer.json()) as { summary: { headRefOid: string } };
  await githubWrite(page, "/api/github/review/threads", { repository, number, headOid: detail.summary.headRefOid, path, line, side, body });
}

// A conversation comment through the API.
export async function postComment(page: Page, number: number, body: string): Promise<void> {
  await githubWrite(page, "/api/github/comments", { repository: await repositoryId(page), number, body });
}

const touchMode = async (page: Page) => (await page.locator("html").getAttribute("data-ui-mode")) === "touch";

// Touch mode keeps the preview and the sidebar on separate tabs.
export async function showTab(page: Page, tab: "files" | "preview"): Promise<void> {
  if (!(await touchMode(page))) return;
  const button = page.locator(`#touch-tab-${tab}`);
  if ((await button.getAttribute("aria-selected")) !== "true") await button.click();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", tab);
}

// The Pull request pane, shown: on touch the Files tab with the pane
// expanded in its accordion.
export async function openPullRequestPane(page: Page): Promise<void> {
  await showTab(page, "files");
  const toggle = page.locator('[data-pane-toggle="pull-request"]');
  if ((await touchMode(page)) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.locator("#pull-request-pane")).toBeVisible();
}

// A pull request's view, opened by URL, once its first tab has rendered.
export async function openPullRequest(page: Page, query: string): Promise<void> {
  await page.goto(`/?${query}`);
  await showTab(page, "preview");
  const params = new URLSearchParams(query);
  if (params.get("tab") === "files") {
    await expect(page.locator('#pr-panel-files diffs-container').first()).toBeVisible();
  } else if (!params.has("path")) {
    await expect(page.locator("#pr-panel-conversation .pr-timeline")).toBeVisible();
  }
}

// One line number in Files changed: Pierre renders it in its shadow root as
// a button named `Comment on <path> line <n>` (` (removed)` on the old side).
export function lineNumber(page: Page, path: string, line: number, kind: "addition" | "deletion" | "context" = "addition"): Locator {
  const type = kind === "context" ? "context" : `change-${kind}`;
  return page.locator(`.pr-file[data-file-path="${path}"] diffs-container [data-column-number="${line}"][data-line-type="${type}"]`);
}

// The open inline composer (Files changed or the file view's Diff).
export function inlineComposer(page: Page): Locator {
  return page.locator(".pr-inline-composer").filter({ has: page.getByRole("button", { name: "Add to review" }) });
}

// The preview header's one review button: Review, or Finish (n) while a
// review is in progress.
export function reviewButton(page: Page): Locator {
  return page.locator("#pr-view-review").locator("[data-review-open], [data-review-finish]");
}

// The open review dialog.
export function reviewDialog(page: Page): Locator {
  return page.locator("dialog.gh-dialog[open]").filter({ has: page.locator("[data-review-submit]") });
}

// What has focus, through open shadow roots, described for an assertion.
export async function focusedElement(page: Page): Promise<{ tag: string; label: string; data: string[]; text: string; inside: (selector: string) => Promise<boolean> }> {
  const described = await page.evaluate(() => {
    let element: Element | null = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    const html = element as HTMLElement | null;
    return {
      tag: html?.tagName.toLowerCase() ?? "",
      label: html?.getAttribute("aria-label") ?? "",
      data: html ? Object.keys(html.dataset) : [],
      text: (html?.textContent ?? "").trim().slice(0, 60),
    };
  });
  return { ...described, inside: (selector: string) => page.evaluate(sel => Boolean(document.activeElement?.closest(sel)), selector) };
}

// Where a tap at the control's centre lands, as the browser hit-tests it:
// null when on the control (or inside it), else what covers it.
export async function centreMiss(target: Locator): Promise<string | null> {
  return target.evaluate(element => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return "not rendered";
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return `outside the viewport at ${Math.round(x)},${Math.round(y)}`;
    const hit = document.elementFromPoint(x, y);
    if (hit === element || element.contains(hit)) return null;
    // A shadow host answers for its own shadow tree.
    if (hit && hit.shadowRoot && hit.shadowRoot.contains(element)) return null;
    return `covered by ${hit?.tagName.toLowerCase()}.${(hit as HTMLElement | null)?.className ?? ""}`;
  });
}

// A touch control: at least 44×44 CSS pixels and taken at its centre (after
// the scroll a tap into view would do).
export async function expectTouchTarget(target: Locator, name: string, minimum = { width: 44, height: 44 }): Promise<void> {
  await target.evaluate(element => element.scrollIntoView({ block: "nearest", inline: "nearest" }));
  const box = await target.evaluate(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height }; });
  expect(box.width, `${name} is ${Math.round(box.width)}px wide`).toBeGreaterThanOrEqual(minimum.width - 0.5);
  expect(box.height, `${name} is ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(minimum.height - 0.5);
  expect(await centreMiss(target), `${name} at its centre`).toBeNull();
}

// A real tap at the control's centre, where it is on screen now (Playwright's
// tap() would first scroll a pinned control to its static place).
export async function tapCentre(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box, "the control is on screen").not.toBeNull();
  await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

// Files changed scrolled to `y`: every file header pinned there (one at a
// time is the rule), anything painted over the pinned preview header, and
// any sliver of the title row left above the tabs row.
export async function pinnedFileHeadersAt(page: Page, y: number): Promise<{ scroll: number; pinned: string[]; over: string[]; slivers: string[] }> {
  return page.evaluate(y => new Promise(resolve => {
    const shell = document.querySelector<HTMLElement>(".preview-shell")!;
    const root = shell.scrollHeight > shell.clientHeight + 4 && getComputedStyle(shell).overflowY !== "visible" ? shell : document.scrollingElement as HTMLElement;
    root.scrollTop = y;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const header = document.querySelector<HTMLElement>(".preview-header")!.getBoundingClientRect();
      const bar = document.querySelector<HTMLElement>('[data-pr-panel="files"] .pr-review-bar.is-active')?.getBoundingClientRect();
      const pinBottom = bar && Math.abs(bar.top - header.bottom) < 2 ? bar.bottom : header.bottom;
      const pinned = [...document.querySelectorAll<HTMLElement>(".pr-file-header")]
        .map(element => ({ path: element.dataset.fileHeader ?? "", box: element.getBoundingClientRect() }))
        .filter(entry => entry.box.height > 0 && Math.abs(entry.box.top - pinBottom) <= 1.5)
        .map(entry => entry.path);
      const over: string[] = [];
      for (let row = Math.max(0, Math.ceil(header.top)) + 1; row < header.bottom - 1; row += 6) {
        for (const x of [header.left + 6, header.left + header.width * 0.25, header.left + header.width / 2, header.left + header.width * 0.75, header.right - 6]) {
          const element = document.elementFromPoint(x, row);
          if (element && !element.closest(".preview-header, #touch-tab-bar")) over.push(`${Math.round(x)},${row}: ${element.closest(".pr-file-header") ? "a file header" : `${element.tagName.toLowerCase()}.${element.className}`}`);
        }
      }
      // The title row's controls scroll away whole: no sliver left above the tabs row.
      const toolbarTop = document.querySelector<HTMLElement>(".preview-toolbar")!.getBoundingClientRect().top;
      const pinnedTop = parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".preview-header")!).top);
      const slivers = header.top < -1 && Math.abs(header.top - pinnedTop) < 1
        ? ["#pr-view-github", "#preview-title"].filter(selector => {
          const box = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
          return box && box.height > 0 && box.bottom > 0.5 && box.bottom <= toolbarTop + 1;
        })
        : [];
      resolve({ scroll: Math.round(root.scrollTop), pinned, over, slivers });
    }));
  }), y);
}

export async function previewScrollHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".preview-shell")!;
    const root = shell.scrollHeight > shell.clientHeight + 4 && getComputedStyle(shell).overflowY !== "visible" ? shell : document.scrollingElement as HTMLElement;
    return root.scrollHeight;
  });
}

// `/__e2e/github` makes fixture pull request #42 the workspace's own: the
// checkout moves to its head branch `feature/login` at HEAD and a local bare
// remote stands in for GitHub's Git side (tests/e2e/server.ts). `reset` adds
// options to the workspace reset first (`secondRepository`).
export async function ownPullRequest(page: Page, request: APIRequestContext, options: OwnPullRequestOptions = {}, reset: Record<string, unknown> = {}): Promise<{ head: string }> {
  await request.post("/__e2e/reset", { data: { git: true, github: "transport", ...reset } });
  const response = await request.post("/__e2e/github", {
    data: { action: "own-pull-request", files: ["feature.md"], base: "exact", ...options },
  });
  expect(response.ok()).toBe(true);
  // Loading the page asks for the GitHub summary, which sets the base and
  // collects Git data again.
  await signIn(page, request);
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

