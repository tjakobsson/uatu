// GitHub #520: an agent's multi-question form rendered the full question
// text only inside the stepped tab strip, single-line with an ellipsis —
// with a ✓ tick on every tab whether or not the question had been answered,
// because optional questions counted as answered while empty. The real
// shape behind the report (captured from a live OpenCode form) maps the
// long question text into the structured question's header and a short
// label into its prompt, marks the questions optional, and asks them one
// per tab. This file pins the fixed presentation with measurements: the
// active panel states the question in full, wrapped, with nothing clipping
// it; a tab earns its tick only by a real choice; and each option states
// its selection with a visible control more than a colour tint.
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { captureScreenshot, recordEvidence, evidencePath } from "./evidence";
import { writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

const longPrompt =
  "Before I continue refactoring the renderer, pick which of the following concerns I should prioritize in this pass and which ones I can safely defer to a later change without breaking the preview pipeline";

const optionSet = [
  { label: "Timeline rendering", description: "How tool rows and question cards lay out the transcript" },
  { label: "Usage readouts", description: "Token and cost figures in the readout and receipt" },
  { label: "Terminal palette", description: "ANSI colors against the terminal's own theme" },
  { label: "Find in surface", description: "⌘F matching across preview and terminal panes" },
];

/** The chat surface opens differently per UI mode: the touch tab, or the desktop panel. */
async function openChat(page: Page): Promise<void> {
  const touchTab = page.locator("#touch-tab-chat");
  if (await touchTab.isVisible().catch(() => false)) {
    await touchTab.click();
    await expect(page.locator("#chat-surface")).toBeVisible();
    return;
  }
  await openChatPanel(page);
}

interface TextBlock { text?: string; lines?: number; scrollWidth?: number; clientWidth?: number; error?: string }

// One measurement pass: how the stepped form actually renders, as numbers a
// reviewer can check against the claim.
async function measureSteppedForm(page: Page, cardId: string): Promise<Record<string, unknown>> {
  return page.evaluate(requestedId => {
    const measureTextBlock = (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        text: element.textContent?.slice(0, 60),
        lines: [...range.getClientRects()].filter(rect => rect.width > 2 && rect.height > 2).length,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    };
    const card = document.querySelector<HTMLElement>(`[data-chat-item-id="${requestedId}"]`);
    if (!card) return { error: "question card not found" };
    const report: Record<string, unknown> = {};
    const legend = card.querySelector<HTMLElement>(".chat-question-panel:not([hidden]) > legend");
    const prompt = card.querySelector<HTMLElement>(".chat-question-panel:not([hidden]) > p");
    const statement = legend ?? prompt;
    if (statement) {
      report.statement = measureTextBlock(statement);
      report.statementStyle = {
        srOnly: statement.classList.contains("sr-only"),
        element: statement.tagName.toLowerCase(),
      };
      // The nearest horizontally clipping ancestor, if the statement is cut
      // off somewhere above the element itself.
      report.clippingAncestor = (() => {
        for (let element: HTMLElement | null = statement; element && element !== document.body; element = element.parentElement) {
          const ancestorStyle = getComputedStyle(element);
          if (ancestorStyle.overflowX !== "visible" && element.scrollWidth > element.clientWidth + 1) {
            return { className: element.className, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
          }
        }
        return null;
      })();
    } else {
      report.statement = "absent";
    }
    report.tabs = [...card.querySelectorAll<HTMLElement>(".chat-question-tab")].map(tab => {
      const range = document.createRange();
      range.selectNodeContents(tab);
      return {
        label: (tab.textContent ?? "").slice(0, 40),
        lines: [...range.getClientRects()].filter(rect => rect.width > 2 && rect.height > 2).length,
        marker: getComputedStyle(tab, "::before").content,
      };
    });
    report.options = [...card.querySelectorAll<HTMLElement>(".chat-question-panel:not([hidden]) .chat-question-option")].map(label => {
      const input = label.querySelector<HTMLInputElement>("input");
      const indicator = input ? getComputedStyle(input) : null;
      return {
        option: label.textContent?.slice(0, 24),
        inputType: input?.type,
        indicatorVisible: indicator ? indicator.display !== "none" && indicator.visibility !== "hidden" && Number.parseFloat(indicator.opacity) > 0 && indicator.position !== "absolute" : false,
      };
    });
    return report;
  }, cardId);
}

async function seedConversation(request: APIRequestContext): Promise<string> {
  await request.post("/__e2e/reset");
  return request.post("/__e2e/chat", { data: { action: "seed", title: "Four questions", items: [] } })
    .then(r => r.json() as Promise<{ conversation: { id: string } }>)
    .then(r => r.conversation.id);
}

async function seedQuestionItems(request: APIRequestContext, conversationId: string): Promise<void> {
  // The reported shape, as the live OpenCode form maps it: the long question
  // text rides in the header, the short label in the prompt, every question
  // optional, four of them stepped behind the tab strip.
  await request.post("/__e2e/chat", { data: { action: "item", conversationId, item: {
    id: "question:q-stepped", type: "question", createdAt: 3, requestId: "q-stepped", status: "pending",
    questions: [0, 1, 2, 3].map(step => ({
      prompt: `Q${step + 1} — Priorities`,
      header: longPrompt,
      multiple: step === 2, optional: true, allowFreeForm: true, options: optionSet,
    })),
  } } });
  // The replayed shape: one of those questions settled as a tool row — what a
  // reopened conversation shows where the form once sat.
  await request.post("/__e2e/chat", { data: { action: "item", conversationId, item: {
    id: "tool:question-replayed", type: "tool", createdAt: 2, name: "question", status: "completed",
    input: JSON.stringify({ questions: [
      { prompt: longPrompt, header: "Priorities", multiple: true, options: optionSet },
    ] }),
    output: "Timeline rendering",
  } } });
}

/** The report's acceptance, measured at one viewport: the active question is
 *  stated in full, wrapped, with nothing clipping it. */
async function assertReadable(page: Page, name: string): Promise<void> {
  const measured = await measureSteppedForm(page, "question:q-stepped") as {
    statement?: TextBlock;
    statementStyle?: { srOnly?: boolean; element?: string };
    clippingAncestor?: unknown;
  };
  console.log(`${name} statement:`, JSON.stringify(measured.statement), "style:", JSON.stringify(measured.statementStyle), "clippingAncestor:", JSON.stringify(measured.clippingAncestor));
  expect.soft(measured.statementStyle!.srOnly, `${name}: the question's statement is visible, not screen-reader-only`).toBe(false);
  expect.soft(measured.statement!.lines!, `${name}: statement wraps, not one line`).toBeGreaterThan(1);
  expect.soft(measured.statement!.scrollWidth!, `${name}: statement not clipped`).toBeLessThanOrEqual(measured.statement!.clientWidth! + 1);
  expect.soft(measured.clippingAncestor, `${name}: no clipping ancestor`).toBeNull();
}

async function assertDistinctSelection(page: Page, name: string): Promise<void> {
  const card = page.locator('[data-chat-item-id="question:q-stepped"]');
  const tabsBefore = await card.locator(".chat-question-tab").evaluateAll(tabs =>
    (tabs as HTMLElement[]).map(tab => getComputedStyle(tab, "::before").content));
  expect.soft(tabsBefore.every(marker => marker === "none" || marker === '""'), `${name}: no tick on unanswered tabs`).toBe(true);

  const readTick = () => card.locator(".chat-question-tab").evaluateAll(tabs =>
    (tabs as HTMLElement[]).map(tab => getComputedStyle(tab, "::before").content));
  const visiblePanel = card.locator(".chat-question-panel:not([hidden])");

  // Step 1 (radio): a choice ticks its own tab alone.
  await visiblePanel.locator(".chat-question-option input").first().check();
  let ticks = await readTick();
  expect.soft(ticks[0] !== "none" && ticks[0] !== '""', `${name}: the answered tab earns its tick`).toBe(true);
  expect.soft(ticks.slice(1).every(marker => marker === "none" || marker === '""'), `${name}: untouched tabs stay unticked`).toBe(true);

  // Step 3 (the multi-select one, multiple: true): a checkbox choice ticks
  // that step too, and the earlier choice keeps its tick.
  await card.locator('[data-question-tab="2"]').click();
  await visiblePanel.locator(".chat-question-option input[type=checkbox]").first().check();
  ticks = await readTick();
  expect.soft(ticks[2] !== "none" && ticks[2] !== '""', `${name}: the multi-select step ticks its tab`).toBe(true);
  expect.soft(ticks[0] !== "none" && ticks[0] !== '""', `${name}: the radio step keeps its tick`).toBe(true);
  expect.soft([1, 3].every(step => ticks[step] === "none" || ticks[step] === '""'), `${name}: untouched steps stay unticked`).toBe(true);
  // The pills name the steps apart — the critique's P1: four identical
  // ellipsised sentences told the reader nothing about which step was which.
  const labels = await card.locator(".chat-question-tab").evaluateAll(tabList =>
    (tabList as HTMLElement[]).map(tab => (tab.childNodes[0]?.textContent ?? "").trim()));
  expect.soft(new Set(labels).size, `${name}: tab pills name distinct steps`).toBe(4);
  expect.soft(labels.every(text => /^Q\d+ — Priorities$/.test(text)), `${name}: pills carry the short step label, not the long statement`).toBe(true);

  const read = (selector: string) => visiblePanel.locator(selector).first().evaluate((label: HTMLElement) => {
    const input = label.querySelector<HTMLInputElement>("input")!;
    const rowStyle = getComputedStyle(label);
    const indicator = getComputedStyle(input);
    return {
      rowBorder: rowStyle.borderColor,
      rowBackground: rowStyle.backgroundColor,
      indicatorVisible: indicator.display !== "none" && indicator.visibility !== "hidden" && indicator.position !== "absolute",
    };
  });
  const chosen = await read(".chat-question-option:has(input:checked)");
  const unchosen = await read(".chat-question-option:not(:has(input:checked))");
  expect.soft(chosen.indicatorVisible, `${name}: chosen option's control is visible`).toBe(true);
  expect.soft(unchosen.indicatorVisible, `${name}: unchosen option's control is visible`).toBe(true);
  // More than colour: the control itself states the state, so reading the
  // DOM presentation must not depend on the accent tint alone.
  console.log(`${name} chosen:`, JSON.stringify(chosen), "unchosen:", JSON.stringify(unchosen));
}

async function runRepro(page: Page, request: APIRequestContext, testInfo: TestInfo, viewports: Array<{ name: string; width: number; height: number }>, label: string): Promise<void> {
  const id = await seedConversation(request);
  await seedQuestionItems(request, id);
  const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await openChat(page);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(id, { timeout: 15_000 });

  // The stepped form is the only pending card, so it is the active one.
  await expect(page.locator('[data-chat-item-id="question:q-stepped"] .chat-question-tab')).toHaveCount(4);
  await expect(page.locator('[data-chat-item-id="tool:question-replayed"]')).toBeVisible();

  const evidence: Record<string, unknown> = {};
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(150);
    const measured = await measureSteppedForm(page, "question:q-stepped");
    evidence[viewport.name] = measured;
    await captureScreenshot(page, testInfo, `question-repro-${label}-${viewport.name}`);
    await assertReadable(page, `${label}/${viewport.name}`);
    await assertDistinctSelection(page, `${label}/${viewport.name}`);
    // The chosen-vs-unchosen pair: the critique's evidence gap — the visible
    // capture for each viewport shows the form with a real selection made.
    await captureScreenshot(page, testInfo, `question-repro-${label}-${viewport.name}-chosen`);
  }
  await writeFile(evidencePath(testInfo, `question-repro-${label}-measurements.json`), JSON.stringify(evidence, null, 2));
  await recordEvidence(testInfo, evidencePath(testInfo, `question-repro-${label}-measurements.json`));
  console.log("question readability measurements:", JSON.stringify(evidence, null, 2));
}

test.describe("touch (narrow, mobile emulation)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("an agent's long four-question form reads whole and its ticks state real choices", ({ page, request }, testInfo) =>
    runRepro(page, request, testInfo, [{ name: "narrow", width: 390, height: 844 }], "touch"));
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("an agent's long four-question form reads whole and its ticks state real choices", ({ page, request }, testInfo) =>
    runRepro(page, request, testInfo, [{ name: "wide", width: 1400, height: 900 }], "desktop"));

  // The never-disabling primary routes through validation on every press: a
  // required step holds the wizard at itself with the owed-answer message,
  // an optional empty steps on freely, and the button never greys.
  test("a required step gates advancement and an optional empty passes", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
    const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Required step", items: [] } })
      .then(r => r.json() as Promise<{ conversation: { id: string } }>);
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
      id: "question:q-required", type: "question", createdAt: 1, requestId: "q-required", status: "pending",
      questions: [
        { prompt: "Q1 — Scope", header: "Which surfaces should this pass cover", multiple: false, allowFreeForm: false, options: [{ label: "Timeline only", description: "" }, { label: "Whole chat", description: "" }] },
        { prompt: "Q2 — Depth", header: "How deep should coverage go", multiple: false, optional: true, allowFreeForm: false, options: [{ label: "Smoke", description: "" }, { label: "Thorough", description: "" }] },
      ],
    } } });
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await openChat(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id, { timeout: 15_000 });
    const card = page.locator('[data-chat-item-id="question:q-required"]');
    const next = card.locator("[data-question-primary]");
    await expect(next).toHaveText("Next");

    // The button never greys.
    await expect(next).toBeEnabled();
    // An empty required step does not advance: the wizard stays, and the
    // surface announcer says what is owed (spoken beside the status line —
    // the card itself also carries the step's tick state, not this message).
    await next.click();
    await expect(card.locator('[data-question-panel="1"]')).toBeHidden();
    await expect(page.locator("#chat-state")).toContainText("Still to answer");
    // Tabbing to the optional step without answering the required one keeps
    // the owed message alive — it names what is still outstanding.
    await card.locator('[data-question-tab="1"]').click();
    await expect(card.locator('[data-question-panel="1"]')).toBeVisible();
    await expect(page.locator("#chat-state")).toContainText("Still to answer");
    // Answer the required step and leave it by tab: the line goes. The
    // optional empty step then passes straight to Answer, which completes
    // the set.
    await card.locator('[data-question-tab="0"]').click();
    await card.locator('.chat-question-panel:not([hidden]) .chat-question-option input').first().check();
    await card.locator('[data-question-tab="1"]').click();
    await expect(page.locator("#chat-state")).not.toContainText("Still to answer");
    await expect(card.locator('[data-question-panel="1"]')).toBeVisible();
    await expect(next).toHaveText("Answer");
    expect(await next.isDisabled()).toBe(false);
    await next.click();
    await expect(card.locator(".chat-request-trace")).toHaveText("Answered");
    // A settled form drops the answered options: no residual selection state.
    await expect(card.locator(".chat-question-option input:checked")).toHaveCount(0);
  });

  // The advance branch owes its line to the whole form, not the step being
  // left: a required Q1 failed Next earlier, then an optional empty Q2 behind
  // Next must not clear the owed line while Q1 still stands. The tab path
  // already keeps the form-wide outstanding set; the two must not diverge.
  test("the Next advance keeps the owed line naming the required steps still outstanding", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
    const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Three steps", items: [] } })
      .then(r => r.json() as Promise<{ conversation: { id: string } }>);
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
      id: "question:q-steps", type: "question", createdAt: 1, requestId: "q-steps", status: "pending",
      questions: [
        { prompt: "Q1 — Scope", header: "Which surfaces should this pass cover", multiple: false, allowFreeForm: false, options: [{ label: "Timeline only", description: "" }, { label: "Whole chat", description: "" }] },
        { prompt: "Q2 — Depth", header: "How deep should coverage go", multiple: false, optional: true, allowFreeForm: false, options: [{ label: "Smoke", description: "" }, { label: "Thorough", description: "" }] },
        { prompt: "Q3 — Report", header: "How should results be reported", multiple: false, optional: true, allowFreeForm: false, options: [{ label: "Quiet", description: "" }, { label: "Verbose", description: "" }] },
      ],
    } } });
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await openChat(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id, { timeout: 15_000 });
    const card = page.locator('[data-chat-item-id="question:q-steps"]');
    const next = card.locator("[data-question-primary]");

    // The empty required step holds the wizard with the owed line naming it.
    await next.click();
    await expect(page.locator("#chat-state")).toContainText("Still to answer");
    await expect(page.locator("#chat-state")).toContainText("Q1 — Scope"); // the owed names are the labels the tabs render
    // Tab to the optional empty step: the line stands, naming what is owed.
    await card.locator('[data-question-tab="1"]').click();
    await expect(page.locator("#chat-state")).toContainText("Q1 — Scope"); // the owed names are the labels the tabs render
    // Next past the optional empty step: the advance must not clear the line
    // while the required step stands unanswered — the line names the form's
    // outstanding required steps, and Q2 was never one of them.
    await next.click();
    await expect(card.locator('[data-question-panel="2"]')).toBeVisible();
    await expect(page.locator("#chat-state")).toContainText("Still to answer");
    await expect(page.locator("#chat-state")).toContainText("Q1 — Scope"); // the owed names are the labels the tabs render
    // Answer the required step that held the line: retiring it clears the
    // line only once nothing is outstanding — Q2 and Q3 were optional.
    await card.locator('[data-question-tab="0"]').click();
    await card.locator('.chat-question-panel:not([hidden]) .chat-question-option input').first().check();
    await next.click();
    await expect(card.locator('[data-question-panel="1"]')).toBeVisible();
    await expect(page.locator("#chat-state")).not.toContainText("Still to answer");
    await next.click();
    await expect(card.locator('[data-question-panel="2"]')).toBeVisible();
    await next.click();
    await expect(card.locator(".chat-request-trace")).toHaveText("Answered");
  });

  // A required validation error leaves the owed line on the status region.
  // Rejecting the question retires the form — the line it was speaking has no
  // reader left, so a successful rejection must retire it too, still through
  // the guarded cleanup that never speaks over an unrelated status.
  test("a successful rejection retires the owed-answer line it left behind", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
    const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Rejected question", items: [] } })
      .then(r => r.json() as Promise<{ conversation: { id: string } }>);
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
      id: "question:q-reject", type: "question", createdAt: 1, requestId: "q-reject", status: "pending",
      questions: [
        { prompt: "Q1 — Scope", header: "Which surfaces should this pass cover", multiple: false, allowFreeForm: false, options: [{ label: "Timeline only", description: "" }, { label: "Whole chat", description: "" }] },
      ],
    } } });
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await openChat(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id, { timeout: 15_000 });
    const card = page.locator('[data-chat-item-id="question:q-reject"]');

    // The empty required question raises the owed line on the status region.
    await card.locator("[data-question-primary]").click();
    await expect(page.locator("#chat-state")).toContainText("Still to answer");
    await expect(page.locator("#chat-state")).toContainText("Q1 — Scope"); // the owed names are the labels the tabs render
    // Rejecting resolves the form; the line must go with it.
    await card.locator("[data-question-reject]").click();
    await expect(card.locator(".chat-request-trace")).toHaveText("Rejected");
    await expect(page.locator("#chat-state")).not.toContainText("Still to answer");
  });
});
