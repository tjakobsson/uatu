// Touch terminal switcher (add-terminal-auto-attach-switcher): touch mode
// renders exactly one pane at a time, so the keybar's switch action is the
// only way to reach the others, attach a detached session, take one over, or
// create a new terminal. iPad viewport — coarse pointer, wide — because the
// keybar is coarse-pointer-gated and the single-pane rule is UI-mode-gated.

import { expect, test } from "./fixtures";

async function bootTouchTerminal(
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
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
}

// Stage detached PTYs server-side: resources with no client holding them,
// exactly what a closed window leaves behind. Created from inside the page so
// the request carries the browser's Origin and auth cookie — the session REST
// surface refuses anything else.
async function stageSessions(
  page: import("@playwright/test").Page,
  count: number,
): Promise<string[]> {
  return page.evaluate(async total => {
    const ids: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const response = await fetch("/api/terminal/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      if (!response.ok) throw new Error(`session create failed: ${response.status}`);
      ids.push(((await response.json()) as { id: string }).id);
      // Keep `createdAt` values distinct so attach order and the "newest
      // wins" active-pane rule are never decided by a tie.
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return ids;
  }, count);
}

const switchKey = "#terminal-keybar .terminal-keybar-switch";

test.describe("touch terminal switcher", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  test("shows one pane at a time and switches between attached terminals", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    const staged = await stageSessions(page, 3);

    // Opening the Terminal tab auto-attaches all three, but only the active
    // one is on screen — three slivers on a tablet would be unusable.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
    await expect(page.locator(".terminal-pane[data-active]")).toHaveAttribute(
      "data-session-id",
      staged[2]!,
    );

    // The switcher lists every terminal: the visible one plus the two held
    // behind it.
    await page.locator(switchKey).click();
    await expect(page.locator("#terminal-switcher")).toBeVisible();
    await expect(page.locator(switchKey)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".terminal-switcher-row")).toHaveCount(3);
    await expect(
      page.locator('.terminal-switcher-row[data-state="visible"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('.terminal-switcher-row[data-state="attached-here"]'),
    ).toHaveCount(2);

    // Selecting a hidden terminal makes it the visible one; the sheet closes.
    await page
      .locator(`.terminal-switcher-row[data-session-id="${staged[0]!}"]`)
      .locator(".terminal-switcher-select")
      .click();
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator(switchKey)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".terminal-pane[data-active]")).toHaveAttribute(
      "data-session-id",
      staged[0]!,
    );
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);

    // Still three panes: switching reveals, it never detaches.
    await expect(page.locator(".terminal-pane")).toHaveCount(3);
  });

  test("every auto-attached terminal is genuinely attached, not just the visible one", async ({
    page,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    await stageSessions(page, 3);

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);

    // The server is the only witness that matters. xterm defers open() until a
    // ResizeObserver reports a non-zero rect, and the attach-ready handshake
    // waits on that open — so a hidden pane rendered with `display: none`
    // looks attached locally while the server still lists its session as
    // detached, free for another window to claim out from under this one.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const response = await fetch("/api/terminal/sessions");
            const body = (await response.json()) as {
              sessions: Array<{ attached: boolean }>;
            };
            return body.sessions.filter(session => session.attached).length;
          }),
        { timeout: 10000, message: "hidden panes must hold their sessions too" },
      )
      .toBe(3);

    // And each one is a real terminal, ready to receive output.
    for (const host of await page.locator(".terminal-pane-host").all()) {
      await expect(host).toHaveAttribute("data-terminal-ready", "true", { timeout: 10000 });
    }
  });

  test("creates a new terminal from the switcher", async ({ page, context, request }) => {
    await bootTouchTerminal(page, request);
    await stageSessions(page, 1);

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1, { timeout: 10000 });

    await page.locator(switchKey).click();
    await page.locator(".terminal-switcher-new").click();
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator(".terminal-pane")).toHaveCount(2, { timeout: 10000 });
    // The new terminal is the visible one, and it is the only visible one.
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);
    await expect(page.locator(".terminal-pane-host").last()).toHaveAttribute(
      "data-terminal-ready",
      "true",
      { timeout: 10000 },
    );
  });

  test("a session held by another window needs an explicit Take over", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);

    // A second window holds a session — it stays open, so the session stays
    // attached and can never be auto-claimed.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page2.locator("#touch-tab-terminal").click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 10000,
    });

    // Window 1 opens its terminal: nothing detached to claim, so the touch
    // decision surface is the switcher — never the desktop chooser.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator("#terminal-switcher")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".terminal-picker")).toHaveCount(0);
    await expect(page.locator(".terminal-pane")).toHaveCount(0);

    const row = page.locator('.terminal-switcher-row[data-state="attached-elsewhere"]');
    await expect(row).toHaveCount(1);
    // The row itself does nothing: transfer is the Take over action alone.
    await expect(row.locator(".terminal-switcher-select")).toBeDisabled();

    await row.locator(".terminal-switcher-takeover").click();
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 10000,
    });

    // Window 2 parked with the take-back affordance — the ordinary takeover
    // contract, reached from the switcher.
    await expect(page2.locator(".terminal-taken")).toBeVisible({ timeout: 10000 });

    await page2.close();
  });

  test("Escape closes the switcher before it leaves the fullscreen terminal", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    await stageSessions(page, 1);

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1, { timeout: 10000 });

    await page.locator(switchKey).click();
    await expect(page.locator("#terminal-switcher")).toBeVisible();

    // First Escape: the sheet only. The terminal is still the active surface.
    await page.keyboard.press("Escape");
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "terminal");

    // Second Escape: now it means "leave the fullscreen terminal".
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
  });

  test("leaving the Terminal tab closes the switcher and gives Escape back", async ({
    page,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    await stageSessions(page, 1);

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1, { timeout: 10000 });
    await page.locator(switchKey).click();
    await expect(page.locator("#terminal-switcher")).toBeVisible();

    // Switching tabs keeps the panel mounted so the PTYs survive — which is
    // exactly why the sheet has to be dismissed explicitly. Left open it is
    // invisible but still live: it would swallow Escape from the surface the
    // user is actually looking at, and reappear on the way back.
    await page.locator("#touch-tab-preview").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    await expect(page.locator("#terminal-switcher")).toBeHidden();

    // Escape on Preview belongs to Preview: it must not be consumed on behalf
    // of the terminal, and it must not bounce the user back to another tab.
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");

    // Returning to the terminal shows the terminal, not the sheet.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "terminal");
    await expect(page.locator("#terminal-switcher")).toBeHidden();
    await expect(page.locator(".terminal-pane")).toHaveCount(1);
    await expect(page.locator(switchKey)).toHaveAttribute("aria-expanded", "false");
  });

  test("taking a session back replaces the parked pane instead of duplicating it", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    const [staged] = await stageSessions(page, 1);

    // Window 1 attaches the session.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator(".terminal-pane")).toHaveAttribute("data-session-id", staged!);

    // Window 2 takes it over. Window 1's pane parks with the take-back notice:
    // it still holds a record, but no longer the resource.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page2.locator("#touch-tab-terminal").click();
    await expect(page2.locator("#terminal-switcher")).toBeVisible({ timeout: 10000 });
    await page2
      .locator('.terminal-switcher-row[data-state="attached-elsewhere"] .terminal-switcher-takeover')
      .click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(".terminal-taken")).toBeVisible({ timeout: 10000 });

    // Window 1 takes it back from its own switcher. The parked pane must be
    // replaced, not joined: two entries for one session would strand a
    // pane-cap slot forever and make every session-to-pane lookup ambiguous.
    await page.locator(switchKey).click();
    await expect(page.locator("#terminal-switcher")).toBeVisible();
    await page
      .locator('.terminal-switcher-row[data-state="attached-elsewhere"] .terminal-switcher-takeover')
      .click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 10000,
    });

    // Exactly one pane, and it is a live attachment rather than the notice.
    await expect(page.locator(".terminal-pane")).toHaveCount(1);
    await expect(page.locator(".terminal-taken")).toHaveCount(0);
    await expect(page.locator(".terminal-pane")).toHaveAttribute("data-session-id", staged!);

    await page2.close();
  });

  test("a parked pane whose session was killed elsewhere stops occupying a slot", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    // Two sessions, so the sweep has something to leave behind: with only the
    // zombie, emptying the pane map closes the whole panel and the assertion
    // would say nothing about slots.
    const staged = await stageSessions(page, 2);
    const victim = staged[0]!;

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2, { timeout: 10000 });
    // Both attachments must be live before window 2 reads inventory: a pane
    // exists before its socket does, and a session still reported detached
    // would be auto-attached by window 2 instead of offered for takeover.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const response = await fetch("/api/terminal/sessions");
            const body = (await response.json()) as {
              sessions: Array<{ attached: boolean }>;
            };
            return body.sessions.filter(session => session.attached).length;
          }),
        { timeout: 10000, message: "window 1 must hold both sessions" },
      )
      .toBe(2);

    // Window 2 takes one session over, then destroys it outright.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page2.locator("#touch-tab-terminal").click();
    await expect(page2.locator("#terminal-switcher")).toBeVisible({ timeout: 10000 });
    await page2
      .locator(`.terminal-switcher-row[data-session-id="${victim}"] .terminal-switcher-takeover`)
      .click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 10000,
    });
    // The parked notice lives in a hidden pane (the victim is not the active
    // terminal here), so assert it exists rather than that it is on screen.
    await expect(page.locator(".terminal-taken")).toHaveCount(1, { timeout: 10000 });

    await page2.evaluate(async id => {
      await fetch(`/api/terminal/sessions/${id}`, { method: "DELETE" });
    }, victim);

    // Window 1 now holds a pane for a session that no longer exists. Nothing
    // told it — there is no socket left to close — so without a reconcile it
    // would sit invisible in touch mode, holding a pane-cap slot until reload.
    await page.locator(switchKey).click();
    await expect(page.locator("#terminal-switcher")).toBeVisible();
    await expect(
      page.locator(`.terminal-switcher-row[data-session-id="${victim}"]`),
    ).toHaveCount(0);
    await expect(page.locator(".terminal-pane")).toHaveCount(1);
    await expect(page.locator(".terminal-taken")).toHaveCount(0);

    await page2.close();
  });

  // The "a failed inventory read must not sweep parked panes" rule is pinned by
  // `parkedPanesToSweep` in picker.test.ts rather than here. An E2E cannot
  // reach it: uatu registers a pass-through service worker, and Playwright's
  // page.route does not intercept fetches a service worker mediates, so the
  // aborted-request version of this test silently exercised a healthy read and
  // passed against the bug.

  test("a collision on the active pane never blanks the Terminal tab", async ({
    page,
    context,
    request,
  }) => {
    await bootTouchTerminal(page, request);
    const staged = await stageSessions(page, 2);

    // Window 1 holds both; the newest is the active one.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator(".terminal-pane[data-active]")).toHaveAttribute(
      "data-session-id",
      staged[1]!,
    );
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const response = await fetch("/api/terminal/sessions");
            const body = (await response.json()) as {
              sessions: Array<{ attached: boolean }>;
            };
            return body.sessions.filter(session => session.attached).length;
          }),
        { timeout: 10000 },
      )
      .toBe(2);

    // Window 2 takes the ACTIVE session away, so window 1's collision
    // reconciliation runs against the pane holding the active slot.
    const page2 = await context.newPage();
    await page2.goto("/");
    await expect(page2.locator("#connection-state .connection-label")).toHaveText("Connected");
    await page2.locator("#touch-tab-terminal").click();
    await expect(page2.locator("#terminal-switcher")).toBeVisible({ timeout: 10000 });
    await page2
      .locator(`.terminal-switcher-row[data-session-id="${staged[1]!}"] .terminal-switcher-takeover`)
      .click();
    await expect(page2.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 10000,
    });

    // Reload window 1. Restore replays both persisted records; the one window
    // 2 now holds is refused, which is the collision path — distinct from
    // being taken over, which parks the pane in place. The refused record is
    // the one that held the active slot.
    await page.reload();
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    // Touch mode shows only the pane carrying data-active, so leaving none
    // active blanks the tab while a live terminal sits hidden behind it.
    await expect(page.locator(".terminal-pane[data-active]")).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator(".terminal-pane[data-active]")).toHaveAttribute(
      "data-session-id",
      staged[0]!,
    );
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);

    await page2.close();
  });

  test("the paste-token form stays visible in touch mode", async ({ page, context, request }) => {
    await bootTouchTerminal(page, request);

    // Strip every credential, the way an expired session looks.
    await context.clearCookies();
    await page.evaluate(() => {
      try {
        window.sessionStorage.removeItem("uatu:terminal-token");
      } catch {
        // best-effort
      }
    });

    // The recovery surfaces reuse the `.terminal-pane` class but hold no
    // session and are never stamped active. A one-pane-at-a-time rule keyed on
    // `data-active` alone would hide them, leaving a blank Terminal tab at the
    // one moment the user needs a way back in.
    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-auth")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".terminal-auth-heading")).toHaveText("Reconnect to uatu");
    await expect(page.locator(".terminal-auth-input")).toBeVisible();
  });

  test("desktop mode renders every pane again", async ({ page, context, request }) => {
    await bootTouchTerminal(page, request);
    await stageSessions(page, 2);

    await page.locator("#touch-tab-terminal").click();
    await expect(page.locator(".terminal-pane")).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(1);

    // Single-pane rendering is presentation only: the stored panes are all
    // still attached and desktop mode shows the split.
    await page.locator("#touch-tab-files").click();
    await page.locator("#ui-mode-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(page.locator(".terminal-pane")).toHaveCount(2);
    await expect(page.locator(".terminal-pane:visible")).toHaveCount(2);
  });
});
