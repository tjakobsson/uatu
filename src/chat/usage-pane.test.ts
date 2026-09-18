import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { buildPlanRowNodes, currentUsageReport, initUsagePaneControls, noteUsageReport, onRevealUsagePane, onUsageChange, onUsageRead, readUsageNow, refreshUsageIfStale, renderUsagePaneBody, resetUsagePaneForTests, revealUsagePane, usageReadState } from "./usage-pane";
import { planReadoutRows } from "./composer-status";
import type { UsageReadMode, UsageReadResult } from "./types";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();

function paneBody(): HTMLElement {
  const { document } = parseHTML(html);
  return document.querySelector<HTMLElement>("#usage-pane")!;
}

describe("usage pane", () => {
  test("the shipped chrome already carries the empty state; rendering nothing keeps it and offers a read where one can be asked", () => {
    const body = paneBody();
    expect(body.textContent).toContain("No usage read yet.");
    renderUsagePaneBody(body, undefined);
    expect(body.querySelector(".pane-empty")?.textContent).toBe("No usage read yet.");
    expect(body.querySelectorAll(".plan-row")).toHaveLength(0);
    expect(body.querySelector("[data-usage-read]")).toBeNull();
    renderUsagePaneBody(body, undefined, Date.now(), { reading: false }, true);
    expect(body.querySelector<HTMLButtonElement>("[data-usage-read]")?.textContent).toBe("Read now");
  });

  test("the head states the read time and age; past ten minutes the body is marked stale", () => {
    const body = paneBody();
    const readAt = Date.parse("2026-09-02T10:00:00.000Z");
    const plan = { subscription: "pro", fiveHour: { utilization: 9 }, sevenDay: { utilization: 25 } };
    renderUsagePaneBody(body, { plan, reportedAt: readAt }, readAt + 3 * 60_000);
    expect(body.querySelector(".usage-pane-head")?.textContent).toMatch(/^Pro plan · as of \d{1,2}:\d{2}(?: [AP]M)? · 3 min ago$/);
    expect(body.dataset.stale).toBeUndefined();
    renderUsagePaneBody(body, { plan, reportedAt: readAt }, readAt + 12 * 60_000);
    expect(body.querySelector(".usage-pane-head")?.textContent).toMatch(/· 12 min ago$/);
    expect(body.dataset.stale).toBe("true");
    expect(body.querySelectorAll(".plan-row")).toHaveLength(2);
    // The read's state rides under the figures, which stand either way.
    renderUsagePaneBody(body, { plan, reportedAt: readAt }, readAt, { reading: true });
    expect(body.querySelector(".usage-pane-status")?.textContent).toBe("Reading…");
    renderUsagePaneBody(body, { plan, reportedAt: readAt }, readAt, { reading: false, failure: "timed out" });
    expect(body.querySelector(".usage-pane-status")?.textContent).toBe("Couldn't read usage · timed out");
    expect(body.querySelectorAll(".plan-row")).toHaveLength(2);
  });

  test("an empty plan says the login has no limits rather than waiting for a turn", () => {
    const body = paneBody();
    renderUsagePaneBody(body, { plan: {}, reportedAt: 1 });
    expect(body.querySelector(".pane-empty")?.textContent).toBe("This login reports no plan limits.");
  });

  test("a report renders the plan name, its time, and one meter per window", () => {
    const body = paneBody();
    const now = Date.parse("2026-09-02T10:00:00.000Z");
    renderUsagePaneBody(body, {
      reportedAt: now,
      plan: {
        subscription: "max",
        fiveHour: { utilization: 9, resetsAt: now + 35 * 60_000 },
        sevenDay: { utilization: 25.4, resetsAt: now + 4 * 86_400_000 },
        modelScoped: [{ label: "Fable", utilization: 83 }],
      },
    }, now);
    expect(body.querySelector(".usage-pane-head")?.textContent).toMatch(/^Max plan · as of \d{1,2}:\d{2}/);
    const rows = [...body.querySelectorAll<HTMLElement>(".plan-row")];
    expect(rows.map(row => row.dataset.row)).toEqual(["session", "week", "week-model-0"]);
    expect(rows.map(row => row.querySelector(".plan-row-label")?.textContent)).toEqual(["Session", "Week", "Week · Fable"]);
    expect(rows.map(row => row.querySelector(".plan-row-figure")?.textContent)).toEqual(["9%", "25%", "83%"]);
    expect(rows.map(row => row.dataset.level)).toEqual(["normal", "normal", "warning"]);
    expect(rows[0]!.querySelector(".plan-row-reset")?.textContent).toMatch(/in 35m$/);
    expect(rows[2]!.querySelector(".plan-row-reset")).toBeNull();
    const meter = rows[1]!.querySelector<HTMLElement>(".plan-meter")!;
    expect(meter.getAttribute("role")).toBe("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("25");
    expect(meter.querySelector<HTMLElement>(".plan-meter-fill")!.style.getPropertyValue("--plan-fill")).toBe("25.4%");
  });

  test("row nodes clamp the fill and mark an unreported figure", () => {
    const { document } = parseHTML(html);
    const nodes = buildPlanRowNodes(document, planReadoutRows({ fiveHour: { utilization: 140 }, sevenDay: { resetsAt: 5 } }, 0));
    expect(nodes[0]!.querySelector<HTMLElement>(".plan-meter-fill")!.style.getPropertyValue("--plan-fill")).toBe("100%");
    expect(nodes[1]!.querySelector(".plan-row-figure")?.textContent).toBe("?");
    expect(nodes[1]!.querySelector(".plan-meter")?.getAttribute("aria-valuenow")).toBeNull();
  });

  test("revealing the pane is answered only once a sidebar has registered", () => {
    expect(revealUsagePane()).toBe(false);
    let revealed = 0;
    onRevealUsagePane(() => { revealed += 1; });
    expect(revealUsagePane()).toBe(true);
    expect(revealed).toBe(1);
  });
});

describe("usage pane: the held report and the read", () => {
  const plan = (utilization: number) => ({ fiveHour: { utilization }, sevenDay: { utilization: 25 } });

  test("a seeded report paints before any conversation opens, and an older report never rolls it back", () => {
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    Reflect.set(globalThis, "document", document);
    Reflect.set(globalThis, "window", window);
    try {
      noteUsageReport({ plan: plan(40), reportedAt: 2_000 });
      expect(document.querySelector("#usage-pane .plan-row-figure")?.textContent).toBe("40%");
      noteUsageReport({ plan: plan(10), reportedAt: 1_000 });
      expect(currentUsageReport()?.reportedAt).toBe(2_000);
      expect(document.querySelector("#usage-pane .plan-row-figure")?.textContent).toBe("40%");
      noteUsageReport({ plan: plan(55), reportedAt: 3_000, conversationId: "c1" });
      expect(document.querySelector("#usage-pane .plan-row-figure")?.textContent).toBe("55%");
      // Re-noting the held report is a no-op: nothing repaints, nothing is told.
      let changes = 0;
      onUsageChange(() => { changes += 1; });
      noteUsageReport({ plan: plan(55), reportedAt: 3_000, conversationId: "c1" });
      expect(changes).toBe(0);
      noteUsageReport({ plan: plan(56), reportedAt: 3_001 });
      expect(changes).toBe(1);
    } finally {
      resetUsagePaneForTests();
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("a second click joins the read in flight; a failed read keeps the figures and says why", async () => {
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    Reflect.set(globalThis, "document", document);
    Reflect.set(globalThis, "window", window);
    try {
      const reads: UsageReadMode[] = [];
      let settle!: (result: UsageReadResult) => void;
      onUsageRead(mode => { reads.push(mode); return new Promise(resolve => { settle = resolve; }); });
      noteUsageReport({ plan: plan(40), reportedAt: Date.now() });
      const action = document.querySelector<HTMLButtonElement>('[data-pane-id="usage"] .pane-action[data-usage-read]')!;
      expect(action.hidden).toBe(false);
      const first = readUsageNow("start");
      const second = readUsageNow("start");
      expect(second).toBe(first);
      expect(usageReadState()).toEqual({ reading: true });
      expect(action.disabled).toBe(true);
      expect(document.querySelector("#usage-pane .usage-pane-status")?.textContent).toBe("Reading…");
      settle({ report: null, reason: "timeout" });
      expect(await first).toBe(false);
      expect(reads).toEqual(["start"]);
      expect(usageReadState()).toEqual({ reading: false, failure: "timed out" });
      expect(document.querySelector("#usage-pane .plan-row-figure")?.textContent).toBe("40%");
      expect(document.querySelector("#usage-pane .usage-pane-status")?.textContent).toBe("Couldn't read usage · timed out");
      // A read that answers replaces the figures and clears the failure.
      const third = readUsageNow("start");
      settle({ report: { plan: plan(61), readAt: Date.now() + 1 } });
      expect(await third).toBe(true);
      expect(usageReadState()).toEqual({ reading: false });
      expect(document.querySelector("#usage-pane .plan-row-figure")?.textContent).toBe("61%");
      expect(document.querySelector("#usage-pane .usage-pane-status")).toBeNull();
      // A live-only refresh that finds no session is not a failure.
      const fourth = readUsageNow("live-only");
      settle({ report: null, reason: "no-live-session" });
      expect(await fourth).toBe(false);
      expect(usageReadState()).toEqual({ reading: false });
    } finally {
      resetUsagePaneForTests();
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("a stale report seeded into an already-open pane refreshes unasked, and a newer report clears an old failure", async () => {
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    Reflect.set(globalThis, "document", document);
    Reflect.set(globalThis, "window", window);
    try {
      // The pane was persisted visible and expanded: shown before Chat seeds it.
      const section = document.querySelector<HTMLElement>('[data-pane-id="usage"]')!;
      expect(section.hidden).toBe(false);
      const reads: UsageReadMode[] = [];
      let settle!: (result: UsageReadResult) => void;
      onUsageRead(mode => { reads.push(mode); return new Promise(resolve => { settle = resolve; }); });
      const now = Date.now();
      noteUsageReport({ plan: plan(40), reportedAt: now - 11 * 60_000 });
      expect(reads).toEqual(["live-only"]);
      settle({ report: null, reason: "timeout" });
      await Promise.resolve(); await Promise.resolve();
      expect(usageReadState().failure).toBe("timed out");
      // A later turn's report supersedes the failed attempt's message.
      noteUsageReport({ plan: plan(41), reportedAt: now });
      expect(usageReadState()).toEqual({ reading: false });
      expect(document.querySelector("#usage-pane .usage-pane-status")).toBeNull();
      expect(reads).toEqual(["live-only"]);
      // Hidden pane, closed readout: a stale seed starts nothing.
      resetUsagePaneForTests();
      section.hidden = true;
      const laterReads: UsageReadMode[] = [];
      onUsageRead(async mode => { laterReads.push(mode); return { report: null, reason: "no-live-session" }; });
      noteUsageReport({ plan: plan(40), reportedAt: now - 11 * 60_000 });
      expect(laterReads).toEqual([]);
    } finally {
      resetUsagePaneForTests();
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("a click during an unasked live-only refresh reads after it rather than joining it", async () => {
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    Reflect.set(globalThis, "document", document);
    Reflect.set(globalThis, "window", window);
    try {
      const reads: UsageReadMode[] = [];
      const settle: Array<(result: UsageReadResult) => void> = [];
      onUsageRead(mode => { reads.push(mode); return new Promise(resolve => { settle.push(resolve); }); });
      const quiet = readUsageNow("live-only");
      const click = readUsageNow("start");
      expect(reads).toEqual(["live-only"]);
      settle[0]!({ report: null, reason: "no-live-session" });
      expect(await quiet).toBe(false);
      await Promise.resolve();
      expect(reads).toEqual(["live-only", "start"]);
      settle[1]!({ report: { plan: plan(33), readAt: Date.now() } });
      expect(await click).toBe(true);
      expect(currentUsageReport()?.plan.fiveHour?.utilization).toBe(33);
    } finally {
      resetUsagePaneForTests();
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("the unasked refresh posts one live-only read for a stale report and none for a fresh one", async () => {
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    Reflect.set(globalThis, "document", document);
    Reflect.set(globalThis, "window", window);
    try {
      const reads: UsageReadMode[] = [];
      onUsageRead(async mode => { reads.push(mode); return { report: null, reason: "no-live-session" }; });
      const now = Date.now();
      refreshUsageIfStale(now);
      expect(reads).toEqual([]);
      noteUsageReport({ plan: plan(40), reportedAt: now - 11 * 60_000 });
      refreshUsageIfStale(now);
      refreshUsageIfStale(now);
      await Promise.resolve();
      expect(reads).toEqual(["live-only"]);
      // A fresh report needs no refresh.
      noteUsageReport({ plan: plan(40), reportedAt: now - 60_000 });
      refreshUsageIfStale(now);
      expect(reads).toEqual(["live-only"]);
      // The pane's controls: the inline empty-state button and the header action read on click,
      // and showing the pane refreshes a stale report unasked.
      initUsagePaneControls(document);
      const section = document.querySelector<HTMLElement>('[data-pane-id="usage"]')!;
      section.querySelector<HTMLButtonElement>(".pane-action[data-usage-read]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
      expect(reads).toEqual(["live-only", "start"]);
    } finally {
      resetUsagePaneForTests();
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
    }
  });
});
