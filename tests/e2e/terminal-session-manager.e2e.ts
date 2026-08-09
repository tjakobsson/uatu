import { expect, test } from "./fixtures";

// Coverage for add-terminal-session-manager and add-terminal-auto-attach-
// switcher: the session inventory, auto-attach of detached PTYs, the chooser
// that remains for sessions held by another window, attach-with-takeover
// (close code 4410 parks the losing pane with a take-back action), and
// kill-from-chooser.

async function bootWithTerminalCookie(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  await request.post("/__e2e/reset");
  const tokenResp = await request.get("/__e2e/terminal-token");
  const tokenBody = await tokenResp.json();
  if (!tokenBody.enabled) {
    test.skip(true, "terminal backend unavailable on this platform");
  }
  await page.goto(`/?t=${encodeURIComponent(tokenBody.token)}`);
  await page.evaluate(() => {
    try {
      window.sessionStorage.removeItem("uatu:terminal-visible");
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
}

async function openTerminal(page: import("@playwright/test").Page): Promise<void> {
  const panel = page.locator("#terminal-panel");
  if (await panel.isHidden()) {
    await page.locator("#terminal-toggle").click();
  }
  await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
    timeout: 5000,
  });
}

async function waitForPrompt(page: import("@playwright/test").Page): Promise<void> {
  const rows = page.locator(".terminal-pane-host .xterm-rows > div");
  await expect
    .poll(
      async () => {
        const texts = await rows.allTextContents();
        return texts.some(text => text.trim().length > 0);
      },
      { timeout: 5000, message: "shell prompt must render before typing" },
    )
    .toBe(true);
}

async function typeLine(page: import("@playwright/test").Page, line: string): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector(".terminal-pane-host") as HTMLElement | null;
    const helper = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    helper?.focus();
  });
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

test.describe("terminal session manager", () => {
  test("an orphaned session is auto-attached on split, with its shell state intact", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    // First open with a clean server: no picker, straight to a shell.
    await openTerminal(page);
    await expect(page.locator(".terminal-picker")).toHaveCount(0);
    await waitForPrompt(page);

    // Window 2 sees window 1 in inventory and explicitly chooses a new shell,
    // then closes for good — orphaning that new session.
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await page2.locator(".terminal-picker-fresh").click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    await expect
      .poll(
        async () => {
          const texts = await page2
            .locator(".terminal-pane-host .xterm-rows > div")
            .allTextContents();
          return texts.some(text => text.trim().length > 0);
        },
        { timeout: 5000 },
      )
      .toBe(true);
    await page2.evaluate(() => {
      const host = document.querySelector(".terminal-pane-host") as HTMLElement | null;
      const helper = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
      helper?.focus();
    });
    await page2.keyboard.type("UATU_ORPHAN=survivor");
    await page2.keyboard.press("Enter");
    // Ensure the variable landed before the abrupt close.
    await page2.keyboard.type("echo staged_${UATU_ORPHAN}_ok");
    await page2.keyboard.press("Enter");
    await expect(page2.locator(".terminal-pane-host")).toContainText("staged_survivor_ok", {
      timeout: 5000,
    });
    await page2.close();

    // Window 1 splits: the orphan belongs to nobody, so it attaches straight
    // into the new pane — no chooser, because there is nothing to choose.
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane-host")).toHaveCount(2, { timeout: 5000 });
    await expect(page.locator(".terminal-picker")).toHaveCount(0);
    const secondPane = page.locator(".terminal-pane-host").nth(1);
    await expect(secondPane.locator(".xterm")).toBeVisible({ timeout: 5000 });
    await expect(secondPane).toHaveAttribute("data-terminal-ready", "true", { timeout: 5000 });
    await page.evaluate(() => {
      const hosts = document.querySelectorAll(".terminal-pane-host");
      const helper = hosts[1]?.querySelector(".xterm-helper-textarea") as
        | HTMLTextAreaElement
        | null;
      helper?.focus();
    });
    await page.keyboard.type("echo got_${UATU_ORPHAN}_end");
    await page.keyboard.press("Enter");
    await expect(secondPane).toContainText("got_survivor_end", { timeout: 5000 });
  });

  test("takeover parks the losing pane; take-back reverses it", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await waitForPrompt(page);
    await typeLine(page, "UATU_OWNER=window1");
    await typeLine(page, "echo staged_${UATU_OWNER}_ok");
    await expect(page.locator(".terminal-pane-host")).toContainText("staged_window1_ok", {
      timeout: 5000,
    });

    // Window 2 starts at the inventory and explicitly takes over window 1.
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await expect(page2.locator(".terminal-picker-meta").first()).toContainText(
      "attached elsewhere",
    );
    await page2.locator(".terminal-picker-attach").first().click();

    // Window 2 now owns the session — the marker variable proves identity.
    const takenPane = page2.locator(".terminal-pane-host").first();
    await expect(takenPane.locator(".xterm")).toBeVisible({ timeout: 5000 });
    await page2.evaluate(() => {
      const host = document.querySelector(".terminal-pane-host");
      const helper = host?.querySelector(".xterm-helper-textarea") as
        | HTMLTextAreaElement
        | null;
      helper?.focus();
    });
    await page2.keyboard.type("echo taken_${UATU_OWNER}_ok");
    await page2.keyboard.press("Enter");
    await expect(takenPane).toContainText("taken_window1_ok", { timeout: 5000 });

    // Window 1's pane parked with the notice and take-back action.
    await expect(page.locator(".terminal-taken")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-taken-heading")).toHaveText(
      "Attached in another window",
    );

    // Take back: window 1 reattaches, window 2's pane parks.
    await page.locator(".terminal-taken-takeback").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    await typeLine(page, "echo back_${UATU_OWNER}_ok");
    await expect(page.locator(".terminal-pane-host")).toContainText("back_window1_ok", {
      timeout: 5000,
    });
    await expect(page2.locator(".terminal-taken")).toBeVisible({ timeout: 5000 });

    await page2.close();
  });

  test("kill from the chooser removes the session; nothing left to decide skips it", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await waitForPrompt(page);

    // A second window holds its own session. Left OPEN, so that session stays
    // attached — which is what keeps the chooser in play: auto-attach only
    // claims sessions nobody holds.
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await page2.locator(".terminal-picker-fresh").click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 5000,
    });
    await expect
      .poll(
        async () => {
          const texts = await page2
            .locator(".terminal-pane-host .xterm-rows > div")
            .allTextContents();
          return texts.some(text => text.trim().length > 0);
        },
        { timeout: 5000 },
      )
      .toBe(true);

    // Split → the only candidate is window 2's session, which needs a
    // decision → kill it → nothing left to decide, so the chooser falls
    // through to a fresh shell automatically.
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".terminal-picker-row")).toHaveCount(1);
    await expect(page.locator(".terminal-picker-meta")).toContainText("attached elsewhere");
    await page.locator(".terminal-picker-kill").click();
    await expect(page.locator(".terminal-picker")).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator(".terminal-pane-host")).toHaveCount(2);

    // The inventory no longer contains the killed session: only this
    // window's two panes remain. `context.request` shares the browser's
    // HttpOnly auth cookie (the standalone `request` fixture does not).
    await expect
      .poll(
        async () => {
          const inventory = await context.request.get("/api/terminal/sessions");
          const body = await inventory.json();
          return body.sessions.length;
        },
        { timeout: 5000 },
      )
      .toBe(2);

    await page2.close();
  });

  test("every detached session attaches when a fresh window opens the terminal", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);

    // Stage three detached PTYs through the inventory API — resources that
    // exist server-side with no client holding any of them, exactly the state
    // a closed window leaves behind. Issued from inside the page so they
    // carry the browser's Origin and auth cookie, which that surface demands.
    const created = await page.evaluate(async () => {
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const response = await fetch("/api/terminal/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cols: 80, rows: 24 }),
        });
        if (!response.ok) throw new Error(`session create failed: ${response.status}`);
        ids.push(((await response.json()) as { id: string }).id);
        // `createdAt` has millisecond resolution and orders both the attach
        // sequence and the "newest wins" active-pane rule. Space the
        // creations so the ordering under test is never a tie.
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return ids;
    });

    // A window that has nothing of its own to restore attaches all of them,
    // and never stops to ask.
    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host")).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator(".terminal-picker")).toHaveCount(0);

    // Every pane is a live attachment to one of the staged resources.
    const attachedIds = await page.evaluate(() =>
      [...document.querySelectorAll(".terminal-pane")].map(
        pane => (pane as HTMLElement).dataset.sessionId,
      ),
    );
    expect([...attachedIds].sort()).toEqual([...created].sort());
    for (const host of await page.locator(".terminal-pane-host").all()) {
      await expect(host).toHaveAttribute("data-terminal-ready", "true", { timeout: 10000 });
    }

    // Exactly one pane is active, and the newest staged session is it — no
    // saved last-active reference exists in this fresh window.
    await expect(page.locator(".terminal-pane[data-active]")).toHaveCount(1);
    await expect(page.locator(".terminal-pane[data-active]")).toHaveAttribute(
      "data-session-id",
      created[created.length - 1]!,
    );
  });

  test("the saved last-active session wins the active pane, even as the oldest", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);

    // Window opens a shell: that session becomes the saved last-active PTY in
    // personal state, which is server-side and survives the reload below.
    await openTerminal(page);
    await waitForPrompt(page);
    const firstSessionId = await page.evaluate(
      () => (document.querySelector(".terminal-pane") as HTMLElement).dataset.sessionId!,
    );

    // Two NEWER sessions, so "newest wins" and "last-active wins" disagree.
    const newer = await page.evaluate(async () => {
      const ids: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch("/api/terminal/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cols: 80, rows: 24 }),
        });
        if (!response.ok) throw new Error(`session create failed: ${response.status}`);
        ids.push(((await response.json()) as { id: string }).id);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return ids;
    });

    // Release the first session non-destructively, and wait until the server
    // agrees it is detached — opening the next window immediately would race
    // its inventory GET against the server processing the socket close, and
    // a session still reported as attached is excluded from auto-attach.
    await page.locator("#terminal-toggle").click();
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const response = await fetch("/api/terminal/sessions");
            const body = (await response.json()) as {
              sessions: Array<{ attached: boolean }>;
            };
            return body.sessions.filter(session => !session.attached).length;
          }),
        { timeout: 5000, message: "all three sessions must be detached first" },
      )
      .toBe(3);

    // A genuinely fresh window: its own empty sessionStorage, so nothing to
    // restore and auto-attach runs. The last-active reference lives in
    // server-side personal state, so it crosses over.
    const fresh = await context.newPage();
    await fresh.goto("/");
    await expect(fresh.locator("#connection-state .connection-label")).toHaveText("Connected");
    await fresh.locator("#terminal-toggle").click();

    // All three attach — and the pane the user lands in is the one they were
    // last working in, not the most recently created. Activating a pane
    // rewrites lastPtyId, so a batch that activates as it goes destroys the
    // saved reference before it can be read; this is the regression guard.
    await expect(fresh.locator(".terminal-pane")).toHaveCount(3, { timeout: 10000 });
    await expect(fresh.locator(".terminal-picker")).toHaveCount(0);
    await expect(fresh.locator(".terminal-pane[data-active]")).toHaveAttribute(
      "data-session-id",
      firstSessionId,
    );
    expect(newer).not.toContain(firstSessionId);

    await fresh.close();
  });

  test("a session held by another window is never auto-attached", async ({
    page,
    context,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await waitForPrompt(page);

    // Window 1 holds one session. Window 2 opens with nothing to restore:
    // there is no detached PTY to claim, so it must ask rather than take.
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.locator("#terminal-toggle").click();
    await expect(page2.locator(".terminal-picker")).toBeVisible({ timeout: 5000 });
    await expect(page2.locator(".terminal-picker-meta")).toContainText("attached elsewhere");
    await expect(page2.locator(".terminal-pane-host")).toHaveCount(0);

    // Window 1 is undisturbed: still attached, still its own shell.
    await expect(page.locator(".terminal-taken")).toHaveCount(0);
    await expect(page.locator(".terminal-pane-host")).toHaveCount(1);

    await page2.close();
  });
});
