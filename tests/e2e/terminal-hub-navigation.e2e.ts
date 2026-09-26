// Terminal state across workspace navigation, through a REAL hub
// (fix-terminal-workspace-navigation). The reported flow: select a
// workspace from the switcher — even the one already open — and the
// terminal is gone, its shell behind a Take over action. Every test here
// drives `/s/<id>/` traffic through the hub's proxy and bridge, with two
// workspaces registered, and tells the SAME shell from a replacement by a
// variable set in it: `echo got_${NAME}_end` prints the value in the shell
// that set it and nothing in a fresh one.
//
// Each test also saves a lifecycle trace as evidence: page lifecycle events,
// terminal WebSocket open/close (with codes), the workspace-scoped terminal
// storage, and the child's inventory, plus browser and app versions. The
// trace is appended to sessionStorage so it survives a same-tab navigation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureScreenshot, saveEvidence } from "./evidence";
import { expect, openSessionTab, test, type HubE2EInfo, type HubE2EWorkspace } from "./hub-fixtures";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";

const appVersion = (JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")) as { version: string }).version;

test.use({ hubWorkspaces: ["alpha", "beta"] });

type Inventory = { id: string; attached: boolean }[];

const TRACE_KEY = "__uatuTerminalTrace";

// Installed before any page script: records lifecycle events and every
// terminal WebSocket's open/close into sessionStorage, where a same-tab
// navigation cannot lose it.
async function installTrace(context: BrowserContext): Promise<void> {
  await context.addInitScript((key: string) => {
    const record = (entry: Record<string, unknown>) => {
      try {
        const existing = JSON.parse(window.sessionStorage.getItem(key) ?? "[]") as unknown[];
        existing.push({ t: Date.now(), href: location.href, ...entry });
        window.sessionStorage.setItem(key, JSON.stringify(existing));
      } catch {
        // Storage unavailable — the trace is evidence, not a dependency.
      }
    };
    record({ event: "document-start", visibility: document.visibilityState });
    window.addEventListener("pagehide", event => record({ event: "pagehide", persisted: (event as PageTransitionEvent).persisted }));
    window.addEventListener("pageshow", event => record({ event: "pageshow", persisted: (event as PageTransitionEvent).persisted }));
    document.addEventListener("visibilitychange", () => record({ event: "visibilitychange", visibility: document.visibilityState }));
    const Native = window.WebSocket;
    let serial = 0;
    const Wrapped = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = new Native(url, protocols);
      const text = String(url);
      if (text.includes("/api/terminal")) {
        const id = ++serial;
        const sessionId = new URL(text).searchParams.get("sessionId");
        record({ event: "ws-new", ws: id, sessionId, takeover: new URL(text).searchParams.get("takeover") === "1" });
        socket.addEventListener("open", () => record({ event: "ws-open", ws: id, sessionId }));
        socket.addEventListener("close", event => record({ event: "ws-close", ws: id, sessionId, code: event.code, reason: event.reason }));
        const close = socket.close.bind(socket);
        socket.close = (code?: number, reason?: string) => {
          record({ event: "ws-close-called", ws: id, sessionId, code, reason });
          close(code, reason);
        };
      }
      return socket;
    } as unknown as typeof WebSocket;
    Wrapped.prototype = Native.prototype;
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
      Object.defineProperty(Wrapped, name, { value: Native[name] });
    }
    window.WebSocket = Wrapped;
  }, TRACE_KEY);
}

function readTrace(page: Page): Promise<unknown[]> {
  return page.evaluate(key => JSON.parse(window.sessionStorage.getItem(key) ?? "[]") as unknown[], TRACE_KEY);
}

// The workspace-scoped terminal keys in this tab's session storage.
function scopedTerminalStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index)!;
      if (key.startsWith("uatu:presentation:v1:") && key.includes("terminal")) out[key] = window.sessionStorage.getItem(key)!;
    }
    return out;
  });
}

async function inventory(context: BrowserContext, workspace: HubE2EWorkspace): Promise<Inventory> {
  const response = await context.request.get(`${workspace.sessionUrl}api/terminal/sessions`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { sessions: Inventory }).sessions;
}

async function armCloseDelay(workspace: HubE2EWorkspace, ms: number): Promise<void> {
  const response = await fetch(`${workspace.childOrigin}/s/${workspace.id}/__e2e/terminal-close-delay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ms }),
  });
  expect(response.ok).toBe(true);
}

async function saveTrace(page: Page, context: BrowserContext, workspace: HubE2EWorkspace, testInfo: TestInfo, name: string): Promise<void> {
  const report = {
    test: testInfo.title,
    status: testInfo.status,
    browser: `${page.context().browser()?.browserType().name()} ${page.context().browser()?.version()}`,
    app: appVersion,
    workspace: workspace.id,
    finalUrl: page.url(),
    terminalPanelHidden: await page.locator("#terminal-panel").isHidden(),
    paneSessionIds: await paneSessionIds(page),
    storage: await scopedTerminalStorage(page),
    inventory: await inventory(context, workspace),
    trace: await readTrace(page),
  };
  await saveEvidence(testInfo, `terminal-navigation-trace-${name}.json`, JSON.stringify(report, null, 2));
}

function paneSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".terminal-pane[data-session-id]")].map(pane => pane.dataset.sessionId!),
  );
}

async function waitForPrompt(page: Page, paneIndex = 0): Promise<void> {
  const rows = page.locator(".terminal-pane-host").nth(paneIndex).locator(".xterm-rows > div");
  await expect
    .poll(async () => (await rows.allTextContents()).some(text => text.trim().length > 0), {
      timeout: 10_000,
      message: "shell prompt must render before typing",
    })
    .toBe(true);
}

async function focusPane(page: Page, paneIndex: number): Promise<void> {
  await page.evaluate(index => {
    const host = document.querySelectorAll<HTMLElement>(".terminal-pane-host")[index];
    host?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
  }, paneIndex);
}

async function typeLine(page: Page, paneIndex: number, line: string): Promise<void> {
  await focusPane(page, paneIndex);
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function expectShellValue(page: Page, paneIndex: number, name: string, value: string): Promise<void> {
  await typeLine(page, paneIndex, `echo got_\${${name}}_end`);
  await expect(page.locator(".terminal-pane-host").nth(paneIndex)).toContainText(`got_${value}_end`, { timeout: 10_000 });
}

async function openTerminal(page: Page): Promise<void> {
  await page.locator("#terminal-toggle").click();
  await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 10_000 });
  await waitForPrompt(page, 0);
}

async function expectTerminalRestored(page: Page, paneCount: number): Promise<void> {
  await expect(page.locator("#terminal-panel")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".terminal-pane-host .xterm")).toHaveCount(paneCount, { timeout: 10_000 });
  await expect(page.locator(".terminal-taken, .terminal-occupied, .terminal-picker, .terminal-auth")).toHaveCount(0);
  for (let index = 0; index < paneCount; index += 1) await waitForPrompt(page, index);
}

async function openSwitcher(page: Page): Promise<void> {
  await expect(page.locator("#hub-control")).toBeVisible();
  await page.locator("#hub-toggle").click();
  await expect(page.locator("#hub-menu")).toBeVisible();
}

function menuEntry(page: Page, workspaceId: string) {
  return page.locator(`#hub-menu .hub-menu-item[data-workspace-id="${workspaceId}"]`);
}

async function switchTo(page: Page, workspace: HubE2EWorkspace): Promise<void> {
  await openSwitcher(page);
  await menuEntry(page, workspace.id).click();
  // The SPA rewrites the entry to the document it opened, so the session
  // URL is a prefix of what the page ends on.
  await expect(page).toHaveURL(new RegExp(`^${workspace.sessionUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
}

function byId(hub: HubE2EInfo, id: string): HubE2EWorkspace {
  return hub.workspaces.find(workspace => workspace.id === id)!;
}

// The hub and its children are worker-scoped; hub-fixtures' per-test reset
// restarts every child, so each test starts with no shells in either
// workspace and no held close.
test.beforeEach(async ({ hubContext }) => {
  await installTrace(hubContext);
});

// The trace is evidence of the lifecycle whether the test passed or not, so
// it is saved after every test for each page still open, named by the
// workspace the page ended on.
test.afterEach(async ({ hub, hubContext }, testInfo) => {
  for (const [index, page] of hubContext.pages().entries()) {
    if (page.isClosed()) continue;
    const id = /\/s\/([^/]+)\//.exec(page.url())?.[1];
    const workspace = id ? hub.workspaces.find(candidate => candidate.id === id) : undefined;
    if (!workspace) continue;
    await saveTrace(page, hubContext, workspace, testInfo, `page-${index + 1}`);
  }
});

test.describe("terminal survives workspace navigation through the hub", () => {
  test("selecting the current workspace keeps the page, its panes, and its shells", async ({ hub, hubContext }, testInfo) => {
    const alpha = byId(hub, "alpha");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await typeLine(page, 0, "UATU_NAV=same_page");
    const url = page.url();
    const paneIds = await paneSessionIds(page);
    expect(paneIds).toHaveLength(1);
    await page.evaluate(() => { (window as unknown as { __uatuMarker: string }).__uatuMarker = "original document"; });

    await openSwitcher(page);
    const current = menuEntry(page, "alpha");
    await expect(current).toHaveAttribute("aria-current", "true");
    await current.click();

    // No navigation: the same document, the same URL, the menu closed.
    await expect(page.locator("#hub-menu")).toBeHidden();
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => (window as unknown as { __uatuMarker?: string }).__uatuMarker)).toBe("original document");
    expect(await paneSessionIds(page)).toEqual(paneIds);
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator(".terminal-taken, .terminal-occupied")).toHaveCount(0);
    await expectShellValue(page, 0, "UATU_NAV", "same_page");
    const sessions = await inventory(hubContext, alpha);
    expect(sessions.map(session => session.id)).toEqual(paneIds);
    expect(sessions[0]!.attached).toBe(true);

    // Keyboard activation follows the same path.
    await openSwitcher(page);
    await current.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#hub-menu")).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { __uatuMarker?: string }).__uatuMarker)).toBe("original document");
  });

  test("an explicit new-tab gesture on the current workspace opens it there and leaves this page intact", async ({ hub, hubContext }) => {
    const alpha = byId(hub, "alpha");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await typeLine(page, 0, "UATU_NAV=still_here");
    const paneIds = await paneSessionIds(page);

    await openSwitcher(page);
    const opened = hubContext.waitForEvent("page");
    await menuEntry(page, "alpha").click({ modifiers: ["ControlOrMeta"] });
    const other = await opened;
    await expect(other).toHaveURL(alpha.sessionUrl);
    // The new tab is its own document with no pane references: it must not
    // claim this tab's shell.
    await expect(other.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(other.locator("#terminal-panel")).toBeHidden();

    expect(await paneSessionIds(page)).toEqual(paneIds);
    await expectShellValue(page, 0, "UATU_NAV", "still_here");
    await other.close();
  });

  test("a round trip through another workspace restores both panes and leaves the other workspace's terminal hidden", async ({ hub, hubContext }, testInfo) => {
    const alpha = byId(hub, "alpha");
    const beta = byId(hub, "beta");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane-host .xterm")).toHaveCount(2, { timeout: 10_000 });
    await waitForPrompt(page, 1);
    await typeLine(page, 0, "UATU_PANE=first");
    await typeLine(page, 1, "UATU_PANE=second");
    // A layout preference that must still be in effect afterwards.
    await page.locator("#terminal-dock-toggle").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "right");
    const paneIds = await paneSessionIds(page);
    expect(paneIds).toHaveLength(2);
    expect(await inventory(hubContext, alpha)).toHaveLength(2);

    await switchTo(page, beta);
    await expect(page.locator("#terminal-panel")).toBeHidden();
    expect(await inventory(hubContext, beta)).toHaveLength(0);

    await switchTo(page, alpha);
    await expectTerminalRestored(page, 2);
    expect(await paneSessionIds(page)).toEqual(paneIds);
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "right");
    await expectShellValue(page, 0, "UATU_PANE", "first");
    await expectShellValue(page, 1, "UATU_PANE", "second");
    const sessions = await inventory(hubContext, alpha);
    expect(sessions.map(session => session.id).sort()).toEqual([...paneIds].sort());
    expect(sessions.every(session => session.attached)).toBe(true);
    expect(await inventory(hubContext, beta)).toHaveLength(0);
  });

  test("reload restores the same shells without a takeover action", async ({ hub, hubContext }, testInfo) => {
    const alpha = byId(hub, "alpha");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await typeLine(page, 0, "UATU_RELOAD=survived");
    const paneIds = await paneSessionIds(page);

    await page.reload();
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expectTerminalRestored(page, 1);
    expect(await paneSessionIds(page)).toEqual(paneIds);
    await expectShellValue(page, 0, "UATU_RELOAD", "survived");
    expect(await inventory(hubContext, alpha)).toHaveLength(1);
  });

  test("browser back and forward restore each workspace's own terminal state", async ({ hub, hubContext }, testInfo) => {
    const alpha = byId(hub, "alpha");
    const beta = byId(hub, "beta");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await typeLine(page, 0, "UATU_HISTORY=alpha_shell");
    const paneIds = await paneSessionIds(page);
    const alphaUrl = page.url();

    await switchTo(page, beta);
    await expect(page.locator("#terminal-panel")).toBeHidden();
    const betaUrl = page.url();

    await page.goBack();
    await expect(page).toHaveURL(alphaUrl);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expectTerminalRestored(page, 1);
    expect(await paneSessionIds(page)).toEqual(paneIds);
    await expectShellValue(page, 0, "UATU_HISTORY", "alpha_shell");

    await page.goForward();
    await expect(page).toHaveURL(betaUrl);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(page.locator("#terminal-panel")).toBeHidden();
    expect(await inventory(hubContext, beta)).toHaveLength(0);

    await page.goBack();
    await expect(page).toHaveURL(alphaUrl);
    await expectTerminalRestored(page, 1);
    expect(await paneSessionIds(page)).toEqual(paneIds);
    expect(await inventory(hubContext, alpha)).toHaveLength(1);
  });

  test("a departing holder released late is reattached within the recovery window, not taken over", async ({ hub, hubContext }, testInfo) => {
    const alpha = byId(hub, "alpha");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await typeLine(page, 0, "UATU_LATE=released_late");
    const paneIds = await paneSessionIds(page);

    // The child processes the departing socket's close 1.5 s late: the
    // replacement page attaches into a PTY still held by its predecessor.
    await armCloseDelay(alpha, 1_500);
    await page.reload();
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    // While the departing holder is still being processed the pane stays
    // visible, reconciling, and says so.
    await expect(page.locator(".terminal-pane[data-state=\"recovering\"] .terminal-pane-status")).toBeVisible({ timeout: 5_000 });
    await captureScreenshot(page, testInfo, "terminal-reconnecting");
    await expectTerminalRestored(page, 1);
    expect(await paneSessionIds(page)).toEqual(paneIds);
    await expectShellValue(page, 0, "UATU_LATE", "released_late");
    const sessions = await inventory(hubContext, alpha);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.attached).toBe(true);
    await armCloseDelay(alpha, 0);
  });

  test("a shell another window holds is offered for explicit takeover after the recovery window", async ({ hub, hubContext }, testInfo) => {
    const alpha = byId(hub, "alpha");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await typeLine(page, 0, "UATU_OWNER=first_window");
    const paneIds = await paneSessionIds(page);

    // A second window takes the shell over explicitly.
    const other = await openSessionTab(hubContext, alpha);
    await other.locator("#terminal-toggle").click();
    await expect(other.locator(".terminal-picker")).toBeVisible({ timeout: 10_000 });
    await other.locator(".terminal-picker-attach").first().click();
    await expect(other.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".terminal-taken")).toBeVisible({ timeout: 10_000 });

    // The first window reloads onto its saved reference. The holder is real,
    // so recovery ends in an explicit choice — never a silent reclaim.
    await page.reload();
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator(".terminal-occupied")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".terminal-occupied-takeover")).toBeVisible();
    await captureScreenshot(page, testInfo, "terminal-occupied");
    await expect(other.locator(".terminal-taken")).toHaveCount(0);
    expect(await inventory(hubContext, alpha)).toEqual([{ id: paneIds[0]!, attached: true, createdAt: expect.any(Number), cols: expect.any(Number), rows: expect.any(Number), label: expect.any(String) }]);

    // Explicit takeover moves it back; the other window parks with Take back.
    // The card goes with the attach: the terminal is the pane's whole surface.
    await page.locator(".terminal-occupied-takeover").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".terminal-occupied")).toHaveCount(0);
    await waitForPrompt(page, 0);
    await expectShellValue(page, 0, "UATU_OWNER", "first_window");
    await expect(other.locator(".terminal-taken")).toBeVisible({ timeout: 10_000 });
    await other.close();
  });

  test("an exited shell is reported as ended with a way to open a new one, not offered for takeover", async ({ hub, hubContext }, testInfo) => {
    const alpha = byId(hub, "alpha");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await typeLine(page, 0, "exit");
    await expect(page.locator(".terminal-ended")).toBeVisible({ timeout: 10_000 });
    await captureScreenshot(page, testInfo, "terminal-ended");
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await expect(page.locator(".terminal-taken, .terminal-occupied")).toHaveCount(0);
    expect(await inventory(hubContext, alpha)).toHaveLength(0);

    await page.locator(".terminal-ended-new").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({ timeout: 10_000 });
    await waitForPrompt(page, 0);
    expect(await inventory(hubContext, alpha)).toHaveLength(1);
  });

  test("a duplicated tab's copied pane reference does not bypass explicit takeover", async ({ hub, hubContext }) => {
    const alpha = byId(hub, "alpha");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    await typeLine(page, 0, "UATU_DUP=original_tab");
    const paneIds = await paneSessionIds(page);
    const copied = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index)!;
        if (key.startsWith("uatu:presentation:v1:")) out[key] = window.sessionStorage.getItem(key)!;
      }
      return out;
    });

    // A duplicated tab carries the original's session storage — visibility
    // and pane records included. Its reference is a hint, never ownership:
    // the original keeps the shell, and the copy parks on the explicit
    // choice.
    const duplicate = await hubContext.newPage();
    await duplicate.goto(alpha.sessionUrl);
    await expect(duplicate.locator("#connection-state .connection-label")).toHaveText("Connected");
    await duplicate.evaluate(entries => {
      for (const [key, value] of Object.entries(entries)) window.sessionStorage.setItem(key, value);
    }, copied);
    await duplicate.reload();
    await expect(duplicate.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(duplicate.locator("#terminal-panel")).toBeVisible();
    await expect(duplicate.locator(".terminal-pane[data-state=\"occupied\"]")).toHaveCount(1, { timeout: 15_000 });
    await expect(duplicate.locator(".terminal-occupied-takeover")).toBeVisible();

    await expect(page.locator(".terminal-taken")).toHaveCount(0);
    expect(await paneSessionIds(page)).toEqual(paneIds);
    await expectShellValue(page, 0, "UATU_DUP", "original_tab");
    const sessions = await inventory(hubContext, alpha);
    expect(sessions.map(session => session.id)).toEqual(paneIds);
    await duplicate.close();
  });

  test("a confirmed close during recovery terminates the shell and leaves no retry work behind", async ({ hub, hubContext }) => {
    const alpha = byId(hub, "alpha");
    const page = await openSessionTab(hubContext, alpha);
    await openTerminal(page);
    const paneIds = await paneSessionIds(page);

    // A long-held departing holder keeps the restored pane reconciling.
    await armCloseDelay(alpha, 4_000);
    await page.reload();
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect(page.locator(".terminal-pane[data-state=\"recovering\"]")).toHaveCount(1, { timeout: 5_000 });

    // Closing it is a real loss (the shell is alive somewhere), so it is
    // confirmed — and the confirmation kills the PTY even though this pane
    // holds no connection the server would act on.
    await page.locator(".terminal-pane-close").click();
    await expect(page.locator("#terminal-confirm")).toBeVisible();
    await page.locator("#terminal-confirm-accept").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(0);
    await expect(page.locator("#terminal-panel")).toBeHidden();

    // The abandoned recovery must not come back: after the old holder's
    // release would have let it attach, nothing reappears.
    await page.waitForTimeout(5_000);
    await expect(page.locator(".terminal-pane")).toHaveCount(0);
    await expect(page.locator("#terminal-panel")).toBeHidden();
    await expect.poll(async () => (await inventory(hubContext, alpha)).map(session => session.id), { timeout: 10_000 })
      .not.toContain(paneIds[0]!);
    await armCloseDelay(alpha, 0);
  });

  test("an unreachable session leaves the pane retryable rather than ended; a retry after restart reports what became of the shell", async ({ hub, hubContext }, testInfo) => {
    // beta is used so alpha's stop/start elsewhere in the worker cannot
    // interfere, and so that this workspace's child restarting does not
    // affect any other test's shells.
    const beta = byId(hub, "beta");
    const page = await openSessionTab(hubContext, beta);
    await openTerminal(page);
    const paneIds = await paneSessionIds(page);

    // The child stops: the connection drops and every read of its inventory
    // fails (the hub answers 503 for a stopped session). A failed read
    // proves nothing about the shell, so the pane may not claim it ended.
    const stop = await hubContext.request.post(`${hub.origin}/api/hub/sessions/beta/stop`);
    expect(stop.ok()).toBe(true);
    await expect(page.locator(".terminal-pane[data-state=\"unreachable\"]")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(".terminal-unreachable-retry")).toBeVisible();
    await expect(page.locator(".terminal-ended, .terminal-occupied, .terminal-taken")).toHaveCount(0);
    expect(await paneSessionIds(page)).toEqual(paneIds);
    await captureScreenshot(page, testInfo, "terminal-unreachable");

    // Back up, the shell is gone with the old child: Retry reads a
    // successful inventory that omits it and says so.
    const start = await hubContext.request.post(`${hub.origin}/api/hub/sessions/beta/start`);
    expect(start.ok()).toBe(true);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected", { timeout: 15_000 });
    await page.locator(".terminal-unreachable-retry").click();
    await expect(page.locator(".terminal-ended")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".terminal-ended-new")).toBeVisible();
  });
});
