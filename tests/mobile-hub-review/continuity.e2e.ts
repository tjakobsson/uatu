import { expect, test, type Page } from "@playwright/test";
import { activeTask } from './navigation';
import { continuityCommit } from "./continuity-fixture";
import { recordMotionEvidence } from "./motion-evidence";

async function openNavigation(page: Page) {
  // A completed workspace visit precedes these continuity actions. In-flight
  // pointer interaction is tested separately in motion.e2e.ts; don't ask the
  // browser to scroll an as-yet offscreen fixed destination into view.
  await expect.poll(() => page.locator("#mobile-workspace-root").evaluate(el => el.getBoundingClientRect().x)).toBe(0);
  const handle = page.locator("#navigation-handle");
  if (await handle.isVisible()) await handle.click();
}
async function detour(page: Page) {
  await openNavigation(page);
  await page.locator("#navigation-hub").click();
  await expect(page.locator("#mobile-hub-root h1")).toHaveText("Workspaces");
  await page.locator('#mobile-hub-root [data-action="settings"]').click();
  await page.locator('#mobile-hub-root [data-action="preview-side"]').click();
  await expect(activeTask(page, 'editor', 'Preview File Controls')).toBeVisible();
  await expect(page.locator("#preview-file-navigation")).toBeHidden();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
}

test.beforeEach(async ({ request }) => { await request.post("/review/reset", { data: { scenario: "mixed" } }); });

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus || !page || page.isClosed()) return;
  // Failure-only diagnostics: geometry/timeline, never form values or content.
  const snapshot = await page.evaluate(() => ({
    visibility: document.visibilityState, focus: document.hasFocus(),
    foreground: document.documentElement.dataset.workspaceForeground,
    now: performance.now(), timeline: document.timeline.currentTime,
    roots: ["#mobile-hub-root", "#mobile-workspace-root"].map(selector => {
      const el = document.querySelector<HTMLElement>(selector)!;
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        inert: el.inert, hidden: el.hidden, visibility: style.visibility, left: style.left,
        translate: style.translate, transition: style.transition,
        animations: el.getAnimations().map(animation => ({ currentTime: animation.currentTime,
          startTime: animation.startTime, state: animation.playState, pending: animation.pending,
          playbackRate: animation.playbackRate, timing: animation.effect?.getComputedTiming() })) };
    }),
  })).catch(error => ({ diagnosticError: String(error) }));
  await info.attach("continuity-failure-geometry", { body: JSON.stringify(snapshot, null, 2), contentType: "application/json" });
});

test("one actual workspace survives Hub/Settings sheet round trips on all four surfaces", async ({ page, request }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const servicePaths: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.includes("/api/") && !path.startsWith("/api/hub/")) servicePaths.push(path); });
  page.on("websocket", socket => servicePaths.push(new URL(socket.url()).pathname));
  let boots = 0; page.on("request", request => { if (new URL(request.url()).pathname === "/s/atlas/api/state") boots++; });
  await page.goto("/");
  await expect(page.locator('#mobile-hub-root [data-workspace="atlas"]')).toBeVisible();
  expect(boots).toBe(0);
  await page.locator('[data-action="open:atlas"]').click();
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await page.evaluate(() => { (window as any).retainedRoot = document.querySelector(".app-shell"); (window as any).retainedState = window.__mobileHubReview!.state; });
  for (const surface of ["files", "preview", "chat", "terminal"]) {
    await openNavigation(page);
    await page.locator(`[data-tab="${surface}"]`).click();
    if (surface === "terminal") await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
    await detour(page);
    await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
    await page.keyboard.press("Control+`");
    await page.keyboard.press("Control+Shift+f");
    await page.keyboard.press("Meta+Shift+f");
    await page.evaluate(() => window.__uatuFind?.search());
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", surface);
    await page.locator('#mobile-hub-root [data-action="return"]').click();
    await expect(page).toHaveURL(/\/s\/atlas\/README.md$/);
    await expect(page.locator("#mobile-hub-root")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", surface);
    expect(await page.evaluate(() => (window as any).retainedRoot === document.querySelector(".app-shell"))).toBe(true);
    expect(await page.evaluate(() => (window as any).retainedState === window.__mobileHubReview!.state)).toBe(true);
    expect(await page.evaluate(() => window.__mobileHubReview!.state.selectedId)).toBe("readme");
    await expect(page.locator("#touch-tab-bar")).toHaveAttribute("data-open", "true");
  }
  expect(boots).toBe(1);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(servicePaths.length).toBeGreaterThan(0);
  expect(servicePaths.every(path => path.startsWith("/s/atlas/"))).toBe(true);
  expect((await (await request.get("/review/state")).json()).missing).toEqual([]);
});

test("Chat retains draft and exact uploading File while a real terminal transport stays attached", async ({ page, request }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  let sockets = 0; page.on("websocket", () => sockets++);
  await openNavigation(page);
  await page.locator('[data-tab="terminal"]').click();
  await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
  await page.evaluate(() => { (window as any).retainedTerminal = document.querySelector(".xterm"); });
  await page.locator('[data-tab="chat"]').click();
  await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).toHaveValue("review:conversation-1");
  const composer = page.getByRole("textbox", { name: "Message Synthetic agent" });
  await composer.fill("Exact retained unsent draft");
  await request.post("/review/control/upload-hold");
  await page.evaluate(() => {
    const file = new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6p1sAAAAASUVORK5CYII="), c => c.charCodeAt(0))], "retained.png", { type: "image/png" });
    (window as any).retainedFile = file;
    const original = FormData.prototype.append;
    FormData.prototype.append = function(name: string, value: string | Blob, filename?: string) {
      if (value instanceof File) (window as any).uploadedFile = value;
      if (typeof value === "string") (original as (name: string, value: string) => void).call(this, name, value);
      else original.call(this, name, value, filename ?? (value instanceof File ? value.name : "blob"));
    };
    const data = new DataTransfer(); data.items.add(file);
    const input = document.querySelector<HTMLInputElement>("#chat-attach-input")!;
    input.files = data.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => (await (await request.get("/review/state")).json()).protocols.pendingUploads).toBe(1);
  await detour(page);
  await request.post("/review/control/terminal-output");
  await request.post("/review/control/chat-output");
  await request.post("/review/control/upload-settle");
  expect(await page.evaluate(() => (window as any).retainedFile === (window as any).uploadedFile)).toBe(true);
  await page.locator('[data-action="return"]').click();
  await expect(composer).toHaveValue("Exact retained unsent draft");
  await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
  await expect(page.locator("#chat-items")).toContainText("Synthetic streamed response 1");
  expect((await (await request.get("/review/state")).json()).protocols.uploadAttempts).toBe(1);
  expect(sockets).toBe(1);
  expect(await page.evaluate(() => (window as any).retainedTerminal === document.querySelector(".xterm"))).toBe(true);
  await openNavigation(page);
  await page.locator('[data-tab="terminal"]').click();
  await page.getByRole("button", { name: "Select terminal text", exact: true }).click();
  await expect(page.locator(".terminal-transcript-text")).toContainText("Synthetic background output");
});

test("canonical Back/Forward dispatch and Stop invalidation never revive protected workspace", async ({ page, request }) => {
  await page.goto("/s/atlas/README.md#synthetic-review-document");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await detour(page);
  await page.goBack();
  await expect(page.locator("#mobile-hub-root h1")).toHaveText("Workspaces");
  await page.goBack();
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  await expect(page).toHaveURL(/\/s\/atlas\/README.md#synthetic-review-document$/);
  await page.goForward();
  await expect(page.locator("#mobile-hub-root h1")).toHaveText("Workspaces");
  await request.post("/review/backend/stopWorkspace", { data: ["atlas"] });
  await expect(page.locator('[data-action="return"]')).toBeDisabled();
  await page.goBack();
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
  const result = await (await request.post("/review/backend/readWorkspace", { data: ["atlas"] })).json();
  expect(result.value.runtime.status).toBe("stopped");
});

test("current-session revoke defeats a delayed successful Return read", async ({ page, request }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await detour(page);
  let settle: () => void = () => {};
  const held = new Promise<void>(resolve => { settle = resolve; });
  let reached: () => void = () => {};
  const requested = new Promise<void>(resolve => { reached = resolve; });
  await page.route("**/review/backend/readWorkspace", async route => {
    const response = await route.fetch();
    reached(); await held;
    await route.fulfill({ response });
  });
  await page.locator('[data-action="return"]').click();
  await requested;
  await request.post("/review/backend/revokeDevice", { data: ["review-device"] });
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
  await expect(page.locator('[data-action="return"]')).toHaveCount(0);
  settle();
  await page.waitForTimeout(100);
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
  await page.goBack();
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
});

test("an authoritative synthetic 401 removes retained access; direct Settings never boots a workspace", async ({ page }) => {
  let boots = 0; page.on("request", request => { if (new URL(request.url()).pathname === "/s/atlas/api/state") boots++; });
  await page.goto("/settings");
  await expect(page.locator("#mobile-hub-root h1")).toHaveText("Settings");
  expect(boots).toBe(0);
  await page.locator('[data-action="hub"]').click();
  await page.locator('[data-action="open:atlas"]').click();
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await detour(page);
  await page.route("**/review/backend/readWorkspace", route => route.fulfill({ status: 401, body: "Synthetic unauthorized" }));
  await page.locator('[data-action="return"]').click();
  await expect(page.locator('[data-action="return"]')).toHaveCount(0);
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
  expect(boots).toBe(1);
});

test("detail history addresses safe frontend identity and managing B retains A", async ({ page }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await openNavigation(page);
  await page.locator("#navigation-hub").click();
  await page.locator('[data-action="info:notes"]').click();
  await expect(page).toHaveURL(/\/?\?detail=workspace&id=notes$/);
  await page.goBack();
  await expect(page.locator("#mobile-hub-root h1:visible")).toHaveText("Workspaces");
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="security"]').click();
  await page.locator('[data-flow="devices"]').click();
  await expect(page).toHaveURL(/\/settings\?detail=devices$/);
  await page.goBack();
  await expect(page.locator("#mobile-hub-root h1:visible")).toHaveText("Session Security");
  await page.goForward();
  await expect(page.locator("#mobile-hub-root h1:visible")).toHaveText("Devices");
  await page.locator('[data-action="return"]').click();
  await expect(page).toHaveURL(/\/s\/atlas\/README.md$/);
  await page.goto("/settings?detail=devices");
  await expect(page.locator("#mobile-hub-root h1:visible")).toHaveText(["Devices"]);
  await expect(page.locator('[data-action="return"]')).toHaveCount(0);
});

test("hidden terminal never sends zero-size fits or Hub keystrokes and reconciles visible geometry", async ({ page, request }) => {
  const frames: Array<string | Buffer> = [];
  page.on("websocket", socket => socket.on("framesent", frame => frames.push(frame.payload)));
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await openNavigation(page);
  await page.locator('[data-tab="terminal"]').click();
  await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
  await detour(page);
  const before = frames.length;
  await page.setViewportSize({ width: 740, height: 390 });
  await page.locator('[data-action="default-folder"]').click();
  await page.locator('[data-flow="edit"]').click();
  const field = page.getByRole("textbox", { name: "Folder path" });
  await field.fill("/synthetic/ordinary-hub-typing");
  await page.keyboard.press("Control+`");
  await page.keyboard.press("Control+Shift+`");
  await page.keyboard.press("Control+Shift+f");
  await page.keyboard.press("Meta+Shift+f");
  await page.keyboard.press("Meta+f");
  await page.evaluate(() => { window.__uatuFind?.open(); window.__uatuFind?.search(); });
  await expect(field).toBeFocused();
  await expect(page.locator("#find-bar")).toBeHidden();
  await page.keyboard.press("Escape");
  await request.post("/review/control/terminal-output");
  await page.waitForTimeout(100);
  expect(frames.length).toBe(before);
  await page.locator('[data-action="return"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-active-tab", "terminal");
  await expect.poll(() => frames.length).toBeGreaterThan(before);
  for (const frame of frames) {
    if (typeof frame !== "string") continue;
    const parsed = JSON.parse(frame);
    if (parsed.type === "resize" || parsed.type === "attach-ready") { expect(parsed.cols).toBeGreaterThan(0); expect(parsed.rows).toBeGreaterThan(0); }
  }
});

test("explicit commit query retains its unavailable-commit meaning and canonical location", async ({ page }) => {
  const destination = "/s/atlas/?repository=synthetic&commit=1234567";
  await page.goto(destination);
  await expect(page.locator("#preview")).toContainText("Repository data is not available for commit 1234567.");
  await expect.poll(() => page.evaluate(() => window.__mobileHubReview?.state.previewMode.kind)).toBe("commit");
  await detour(page);
  await page.locator('[data-action="return"]').click();
  await expect(page).toHaveURL(new RegExp("/s/atlas/\\?repository=synthetic&commit=1234567$"));
  await expect(page.locator("#preview")).toContainText("Repository data is not available for commit 1234567.");
  expect(await page.evaluate(() => window.__mobileHubReview!.state.selectedId)).toBeNull();
});

test("Hub scroll is independent of workspace state and the existing desktop mode escape reloads normally", async ({ page }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await detour(page);
  const scroll = page.locator("#mobile-hub-root .mh-page");
  await scroll.evaluate(el => { el.scrollTop = 160; });
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(160);
  await page.locator('[data-action="hub"]').click();
  await page.goBack();
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBe(160);
  await page.locator('[data-action="return"]').click();
  await openNavigation(page);
  await page.locator('[data-tab="files"]').click();
  await page.locator("#ui-mode-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
  await expect(page.locator("#mobile-hub-root")).toHaveCount(0);
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  expect(await page.evaluate(() => window.__mobileHubReview)).toBeUndefined();
});

test("product sign-out sheet invalidates the retained workspace without stopping its synthetic runtime", async ({ page, request }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await detour(page);
  await page.locator('[data-action="security"]').click();
  await page.locator('[data-flow="signout"]').click();
  await page.locator('[data-action="commit-sheet"]').click();
  await expect(page.locator("#mobile-hub-root h1:visible")).toHaveText("Sign in required");
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
  await page.goBack();
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
  const snapshot = await (await request.get("/review/state")).json();
  expect(snapshot.authenticated).toBe(false);
  expect(snapshot.log.some((entry: { method: string }) => entry.method === "stopWorkspace")).toBe(false);
});

test("Stop then Forget keeps missing retained history inaccessible", async ({ page, request }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await detour(page);
  await request.post("/review/backend/stopWorkspace", { data: ["atlas"] });
  await request.post("/review/backend/forgetWorkspace", { data: ["atlas"] });
  await expect(page.locator('[data-workspace="atlas"]')).toHaveCount(0);
  await expect(page.locator('[data-action="return"]')).toBeDisabled();
  await page.goBack();
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
  const read = await (await request.post("/review/backend/readWorkspace", { data: ["atlas"] })).json();
  expect(read).toMatchObject({ status: "unavailable", problem: { kind: "not-found" } });
});

test("exact real Files, document, Chat and xterm scroll roots survive repeated animated detours", async ({ page, request }) => {
  test.setTimeout(60_000);
  const evidence: object[] = [];
  await request.post("/review/control/continuity-fixture");
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Continuity section 79");
  for (const surface of ["files", "preview", "chat", "terminal"]) {
    const scrollPosition = () => page.evaluate(surface => surface === "terminal" ? window.__mobileHubReview!.terminals.at(-1)!.buffer.active.viewportY : (window as any).__scrollRoot.scrollTop as number, surface);
    await openNavigation(page);
    await page.locator(`[data-tab="${surface}"]`).click();
    if (surface === "chat") {
      await expect(page.locator("#chat-items")).toContainText("Synthetic message 39");
      await expect(page.locator("#chat-timeline")).not.toHaveAttribute("aria-busy", "true");
      await expect(page.locator("#chat-timeline .uatu-loading-bar")).toHaveCount(0);
    }
    if (surface === "terminal") {
      await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
      await Promise.all(Array.from({ length: 100 }, () => request.post("/review/control/terminal-output")));
      await expect.poll(() => page.evaluate(() => window.__mobileHubReview!.terminals.at(-1)!.buffer.active.baseY)).toBeGreaterThan(20);
      await page.evaluate(() => { (window as any).__scrollRoot = document.querySelector(".xterm"); window.__mobileHubReview!.terminals.at(-1)!.scrollToLine(8); });
    }
    if (surface !== "terminal") {
      await expect.poll(() => page.evaluate(surface => {
      if (surface === "preview") { (window as any).__scrollRoot = document.scrollingElement; return document.scrollingElement!.scrollHeight - innerHeight; }
      const root = document.querySelector(surface === "files" ? ".sidebar" : surface === "chat" ? "#chat-timeline" : ".terminal-panel")!;
      const candidates: HTMLElement[] = [];
      const visit = (node: Element) => { if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 300 && /auto|scroll/.test(getComputedStyle(node).overflowY)) candidates.push(node); for (const child of node.children) visit(child); if (node.shadowRoot) for (const child of node.shadowRoot.children) visit(child); };
      visit(root); (window as any).__scrollRoot = candidates[0];
      return candidates[0] ? candidates[0].scrollHeight - candidates[0].clientHeight : 0;
      }, surface)).toBeGreaterThan(300);
      if (surface === "chat") {
        // The initial bottom-pinned render leaves the first rows as 100px
        // content-visibility placeholders. Reveal those rows before choosing
        // an exact pixel baseline; fonts.ready does not unskip their layout.
        await page.evaluate(() => { (window as any).__scrollRoot.scrollTop = 0; });
        await expect.poll(() => page.locator("#chat-items > [data-chat-item-id]").evaluateAll(rows =>
          rows.slice(0, 3).length === 3 && rows.slice(0, 3).every(row => row.checkVisibility({ contentVisibilityAuto: true }))
        )).toBe(true);
        // Chat's ResizeObserver schedules anchor restoration in the next rAF.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      }
      // Optional diagnostics do not change the settled baseline or assertions.
      if (surface === "chat" && process.env.CHAT_SCROLL_DIAGNOSIS === "on") await page.evaluate(() => {
        const root = (window as any).__scrollRoot as HTMLElement;
        const samples: object[] = (window as any).__chatScrollDiagnosis = [];
        const capture = (reason: string, stack?: string) => {
          if (samples.length >= 100) return;
          samples.push({ reason, stack, now: performance.now(), fontStatus: document.fonts.status,
            root: { id: root.id, className: root.className, top: root.scrollTop, height: root.clientHeight, scrollHeight: root.scrollHeight, rect: root.getBoundingClientRect().toJSON() },
            children: Array.from(root.querySelectorAll("#chat-items, [data-chat-item-id], [role=status], .uatu-loading-bar")).map(el => ({ id: el.id, className: el.className, item: el.getAttribute("data-chat-item-id"), rect: el.getBoundingClientRect().toJSON(), contentVisibility: getComputedStyle(el).contentVisibility, intrinsicSize: getComputedStyle(el).containIntrinsicSize })) });
        };
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        Object.defineProperty(root, "scrollTop", { configurable: true, get() { return descriptor.get!.call(this); }, set(value) { capture(`write-before:${value}`, new Error().stack); descriptor.set!.call(this, value); capture(`write-after:${value}`); } });
        root.addEventListener("scroll", () => capture("scroll"));
        new ResizeObserver(() => capture("resize")).observe(root.querySelector("#chat-items") ?? root);
        new MutationObserver(() => capture("mutation")).observe(root, { childList: true, subtree: true });
        void document.fonts.ready.then(() => capture("fonts-ready"));
        capture("before-test-scroll");
      });
      await page.evaluate(() => { (window as any).__scrollRoot.scrollTop = 210; });
    }
    try {
      await expect.poll(scrollPosition).toBe(surface === "terminal" ? 8 : 210);
    } catch (error) {
      if (surface === "chat" && process.env.CHAT_SCROLL_DIAGNOSIS === "on") await test.info().attach("chat-initial-scroll-diagnosis", { body: JSON.stringify(await page.evaluate(() => (window as any).__chatScrollDiagnosis), null, 2), contentType: "application/json" });
      throw error;
    }
    await page.waitForTimeout(100); // let the existing anchor/viewport owner observe the user scroll
    const retainedScroll = await scrollPosition();
    expect(retainedScroll).toBeGreaterThan(0);
    evidence.push({ surface, retainedScroll, units: surface === "terminal" ? "buffer lines" : "CSS pixels", scroller: await page.evaluate(() => { const e = (window as any).__scrollRoot as HTMLElement; return { id: e.id, className: e.className, height: e.clientHeight, scrollHeight: e.scrollHeight }; }) });
    for (let round = 0; round < 2; round++) {
      await detour(page);
      if (surface === "terminal") await request.post("/review/control/terminal-output");
      if (surface === "chat") await request.post("/review/control/chat-output");
      expect(await scrollPosition()).toBe(retainedScroll);
      await page.locator('[data-action="return"]').click();
      await expect(page.locator("#mobile-hub-root")).toBeHidden();
      expect(await page.evaluate(() => (window as any).__scrollRoot.isConnected)).toBe(true);
      await expect.poll(scrollPosition).toBe(retainedScroll);
      await expect(page.locator("html")).toHaveAttribute("data-active-tab", surface);
    }
  }
  await test.info().attach("retained-scroll-owners", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  await recordMotionEvidence(test.info(), "scroll", { roundTripsPerSurface: 2, owners: evidence });
});

test("populated commit direct load and document/hash history delegate to the original selection owner", async ({ page, request }) => {
  await request.post("/review/control/continuity-fixture");
  const destination = `/s/atlas/?repository=continuity-repo&commit=${continuityCommit}`;
  await page.goto(destination);
  await expect(page.locator("#preview .commit-preview")).toContainText("Synthetic populated commit");
  await detour(page);
  await page.locator('[data-action="return"]').click();
  await expect(page).toHaveURL(new URL(destination, page.url()).href);
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  await expect(page.locator("#preview .commit-preview")).toContainText("Retain the canonical commit destination");
  // Browser-native same-document history is then dispatched by the real owner.
  await page.evaluate(() => { history.pushState({ documentId: "readme" }, "", "/s/atlas/README.md#continuity-section-30"); dispatchEvent(new PopStateEvent("popstate", { state: history.state })); });
  await expect(page.locator("#preview")).toContainText("Continuity section 79");
  await expect.poll(() => page.evaluate(() => window.__mobileHubReview!.state.selectedId)).toBe("readme");
  await expect(page.locator("#continuity-section-30")).toBeInViewport();
  // Let the original smooth fragment reveal settle before recording Back's
  // native scroll restoration position; an interrupted reveal is not its end.
  await expect.poll(() => page.locator("#continuity-section-30").evaluate(el => Math.abs(el.getBoundingClientRect().top - parseFloat(getComputedStyle(el).scrollMarginTop) - (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0)))).toBeLessThan(2);
  await page.goBack();
  await expect(page.locator("#preview .commit-preview")).toContainText("Synthetic populated commit");
  await page.goForward();
  await expect(page.locator("#preview")).toContainText("Continuity section 79");
  await expect(page.locator("#continuity-section-30")).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  await page.goto("/s/atlas/note-001.md#continuity-section-5");
  await expect.poll(() => page.evaluate(() => window.__mobileHubReview?.state.selectedId)).toBe("continuity-1");
  await expect(page.locator("#continuity-section-5")).toBeInViewport();
});

test("detail history restores its own scroller after an asynchronous read, without booting a workspace", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator("#mobile-hub-root h1:visible")).toHaveText(["Settings"]);
  await page.locator('[data-action="tools"]').click();
  const detail = page.locator(".mh-flow-content");
  await expect.poll(() => detail.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(180);
  await detail.evaluate(el => { el.scrollTop = 160; });
  await expect.poll(() => page.evaluate(() => history.state?.mobileHub?.scroll)).toBe(160);
  await page.locator('[data-action="settings"]').click();
  await expect(page.locator("#mobile-hub-root h1:visible")).toHaveText(["Settings"]);
  await page.goBack();
  await expect.poll(() => detail.evaluate(el => el.scrollTop)).toBe(160);
  expect(await page.evaluate(() => window.__mobileHubReview)).toBeUndefined();
});
