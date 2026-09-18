// The Usage pane's body and the plan-row DOM the composer readout shares
// with it. Chat owns the data and the row model (composer-status.ts); the
// sidebar owns the pane chrome and only ever asks this module to paint. The
// pane is per-login rather than per-conversation: it holds the workspace's
// last-known report, seeded from the server on load, and follows the newest
// plan-bearing report from any conversation the client holds. It also owns
// the one refresh path both the pane and the readout use.

import { PLAN_WARNING_UTILIZATION, planName, planReadoutRows, usageAsOf, usageReadFailureLabel, usageStale, type PlanReadoutRow } from "./composer-status";
import type { PlanUtilization, UsageReadMode, UsageReadResult } from "./types";

export type UsageReport = { plan: PlanUtilization; reportedAt: number; conversationId?: string };
export type UsageReadState = { reading: boolean; failure?: string };

const TICK_MS = 60_000;

/**
 * One node per row: label and figure on a line, a meter under them, then
 * the reset (or the note, for extra usage). Built once here so the readout
 * and the pane cannot drift apart in what a window looks like.
 */
export function buildPlanRowNodes(document: Document, rows: readonly PlanReadoutRow[]): HTMLElement[] {
  return rows.map(row => {
    const node = document.createElement("div");
    node.className = "plan-row";
    node.dataset.row = row.key;
    node.dataset.level = row.utilization !== undefined && row.utilization >= PLAN_WARNING_UTILIZATION ? "warning" : "normal";
    const head = document.createElement("div");
    head.className = "plan-row-head";
    const label = document.createElement("span");
    label.className = "plan-row-label";
    label.textContent = row.label;
    const figure = document.createElement("span");
    figure.className = "plan-row-figure";
    figure.textContent = row.utilization === undefined ? "?" : `${Math.round(row.utilization)}%`;
    head.append(label, figure);
    const meter = document.createElement("div");
    meter.className = "plan-meter";
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", row.label);
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    if (row.utilization !== undefined) meter.setAttribute("aria-valuenow", String(Math.round(row.utilization)));
    const fill = document.createElement("span");
    fill.className = "plan-meter-fill";
    fill.style.setProperty("--plan-fill", `${Math.min(100, Math.max(0, row.utilization ?? 0))}%`);
    meter.append(fill);
    node.append(head, meter);
    const detail = row.note ?? row.resetLabel;
    if (detail) {
      const reset = document.createElement("div");
      reset.className = "plan-row-reset";
      reset.textContent = detail;
      node.append(reset);
    }
    return node;
  });
}

/** A "Read now" control, disabled and relabelled while a read is out. */
export function buildReadButton(document: Document, state: UsageReadState, extraClass = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `usage-read-button${extraClass ? ` ${extraClass}` : ""}`;
  button.dataset.usageRead = "start";
  button.disabled = state.reading;
  button.textContent = state.reading ? "Reading…" : "Read now";
  return button;
}

/** The read's state as one line, or nothing when there is nothing to say. */
export function readStatusText(state: UsageReadState): string | undefined {
  if (state.reading) return "Reading…";
  if (state.failure) return `Couldn't read usage · ${state.failure}`;
  return undefined;
}

/**
 * Paints the pane body. No report yet says nothing has been read and, where
 * a read can be asked for, offers it; an empty plan (an API-key login) says
 * the login has no limits, rather than pretending a turn has not happened.
 * A held report is painted with its read time and age, marked stale past
 * the threshold, and the read's own state (in flight, failed) under it.
 */
export function renderUsagePaneBody(body: HTMLElement, report: UsageReport | undefined, now = Date.now(), state: UsageReadState = { reading: false }, readable = false): void {
  const document = body.ownerDocument;
  const status = (): HTMLElement[] => {
    const text = readStatusText(state);
    if (!text) return [];
    const line = document.createElement("p");
    line.className = "usage-pane-status";
    line.dataset.state = state.reading ? "reading" : "failed";
    line.textContent = text;
    return [line];
  };
  const empty = (text: string) => {
    const note = document.createElement("p");
    note.className = "pane-empty";
    note.textContent = text;
    body.replaceChildren(note, ...(readable ? [buildReadButton(document, state, "usage-read-inline")] : []), ...status());
  };
  delete body.dataset.stale;
  if (!report) {
    empty("No usage read yet.");
    return;
  }
  const rows = planReadoutRows(report.plan, now);
  if (rows.length === 0) {
    empty("This login reports no plan limits.");
    return;
  }
  const head = document.createElement("p");
  head.className = "usage-pane-head";
  const name = planName(report.plan);
  const asOf = usageAsOf(report.reportedAt, now);
  head.textContent = name ? `${name} · ${asOf}` : asOf;
  if (usageStale(report.reportedAt, now)) body.dataset.stale = "true";
  body.replaceChildren(head, ...buildPlanRowNodes(document, rows), ...status());
}

let current: UsageReport | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

/**
 * A fresh report from any source replaces the pane's figures wholesale —
 * newest wins, by the report's own time, so revisiting an older
 * conversation cannot roll the pane back. The age line and any relative
 * reset are re-painted once a minute for as long as a report is held.
 */
export function noteUsageReport(report: UsageReport): void {
  // Equal is not newer: the readout re-notes the report it painted on every
  // sync, and a note that notified would sync it again, without end.
  if (current && current.reportedAt >= report.reportedAt) return;
  current = report;
  // A failure described an older attempt; usage has been read since.
  delete state.failure;
  paintLiveUsagePane();
  if (tick === undefined) tick = setInterval(paintLiveUsagePane, TICK_MS);
  notify();
  // A report seeded into a pane or readout that is already open gets the
  // same unasked refresh opening it would have given.
  if (usageSurfaceShown()) refreshUsageIfStale();
}

/** The pane shown and expanded, or the readout open: somewhere the report is being looked at. */
function usageSurfaceShown(): boolean {
  if (typeof document === "undefined") return false;
  const section = document.querySelector<HTMLElement>('[data-pane-id="usage"]');
  const paneShown = Boolean(section && !section.hidden && !section.classList.contains("is-collapsed"));
  const readout = document.querySelector<HTMLDetailsElement>("#chat-plan-usage");
  return paneShown || Boolean(readout && !readout.hidden && readout.open);
}

export function currentUsageReport(): UsageReport | undefined {
  return current;
}

/** Repaints when the held report or the read state changes; for the readout beside the composer. */
export function onUsageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of listeners) listener();
}

function paintLiveUsagePane(): void {
  if (typeof document === "undefined") return;
  const body = document.querySelector<HTMLElement>("#usage-pane");
  if (body) renderUsagePaneBody(body, current, Date.now(), state, usageReadable());
  const action = document.querySelector<HTMLButtonElement>('[data-pane-id="usage"] .pane-action[data-usage-read]');
  if (action) {
    action.hidden = !usageReadable();
    action.disabled = state.reading;
  }
}

// ---- the read -------------------------------------------------------------

type UsageReadHandler = (mode: UsageReadMode) => Promise<UsageReadResult>;
let readHandler: UsageReadHandler | undefined;
let inFlight: Promise<boolean> | undefined;
const state: UsageReadState = { reading: false };

/**
 * The chat surface registers how a read is made once an agent that reports
 * plan usage is known; before that the controls stay hidden — there is
 * nothing to ask.
 */
export function onUsageRead(handler: UsageReadHandler | undefined): void {
  readHandler = handler;
  paintLiveUsagePane();
  notify();
  if (usageSurfaceShown()) refreshUsageIfStale();
}

export function usageReadable(): boolean {
  return readHandler !== undefined;
}

export function usageReadState(): UsageReadState {
  return { ...state };
}

/**
 * Read plan usage now. One read at a time: a second ask joins the first.
 * A report replaces the held one; a refusal keeps the figures and records
 * why, except that a live-only read finding no session is not a failure —
 * it is the expected answer to an unasked refresh. Resolves true when a
 * report landed.
 */
export function readUsageNow(mode: UsageReadMode): Promise<boolean> {
  if (inFlight) return inFlight;
  const handler = readHandler;
  if (!handler) return Promise.resolve(false);
  state.reading = true;
  delete state.failure;
  paintLiveUsagePane();
  notify();
  inFlight = (async () => {
    try {
      const result = await handler(mode);
      if (result.report) {
        noteUsageReport({ plan: result.report.plan, reportedAt: result.report.readAt, ...(result.report.conversationId ? { conversationId: result.report.conversationId } : {}) });
        return true;
      }
      if (!(mode === "live-only" && result.reason === "no-live-session")) state.failure = usageReadFailureLabel(result.reason);
      return false;
    } catch {
      state.failure = usageReadFailureLabel("network");
      return false;
    } finally {
      state.reading = false;
      inFlight = undefined;
      paintLiveUsagePane();
      notify();
    }
  })();
  return inFlight;
}

/**
 * The unasked refresh: only through a session that is already up, and only
 * when the held report is stale. Never starts a process (spec).
 */
export function refreshUsageIfStale(now = Date.now()): void {
  if (!readHandler || !current || state.reading || !usageStale(current.reportedAt, now)) return;
  void readUsageNow("live-only");
}

/**
 * Wires the pane's own controls: the header's read action and the inline
 * button of the empty state, and the unasked refresh when the pane is
 * shown or expanded (the sidebar stamps `hidden` and `is-collapsed` on the
 * section; watching the stamps keeps the import pointing sidebar → chat).
 */
export function initUsagePaneControls(root: Document = document): void {
  const section = root.querySelector<HTMLElement>('[data-pane-id="usage"]');
  if (!section) return;
  section.addEventListener("click", event => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest?.("[data-usage-read]")) return;
    event.preventDefault();
    void readUsageNow("start");
  });
  const shown = () => !section.hidden && !section.classList.contains("is-collapsed");
  let wasShown = shown();
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      const now = shown();
      if (now && !wasShown) refreshUsageIfStale();
      wasShown = now;
    }).observe(section, { attributes: true, attributeFilter: ["hidden", "class"] });
  }
  paintLiveUsagePane();
}

/** Test seam: forgets the held report, the read state, and the handler. */
export function resetUsagePaneForTests(): void {
  current = undefined;
  readHandler = undefined;
  inFlight = undefined;
  state.reading = false;
  delete state.failure;
  if (tick !== undefined) { clearInterval(tick); tick = undefined; }
  listeners.clear();
}

// The readout's pin reveals the pane, but pane state belongs to the sidebar
// (sidebar/panes.ts persists and re-renders it). The sidebar registers the
// reveal at init and chat only asks; this keeps the import pointing
// sidebar → chat, the direction the tab bar already set, and out of the
// chat surface's unit-test process.
let revealHandler: (() => void) | undefined;

export function onRevealUsagePane(handler: () => void): void {
  revealHandler = handler;
}

/** True when a sidebar answered; false before one registered. */
export function revealUsagePane(): boolean {
  if (!revealHandler) return false;
  revealHandler();
  return true;
}
