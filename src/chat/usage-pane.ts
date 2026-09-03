// The Usage pane's body and the plan-row DOM the composer readout shares
// with it. Chat owns the data and the row model (composer-status.ts); the
// sidebar owns the pane chrome and only ever asks this module to paint. The
// pane is per-login rather than per-conversation, so it follows the newest
// plan-bearing report from any conversation the client holds.

import { PLAN_WARNING_UTILIZATION, planName, planReadoutRows, type PlanReadoutRow } from "./composer-status";
import type { PlanUtilization } from "./types";

export type UsageReport = { plan: PlanUtilization; reportedAt: number };

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

/**
 * Paints the pane body. No report yet says where one comes from; an empty
 * plan (an API-key login) says the login has no limits, rather than
 * pretending a turn has not happened.
 */
export function renderUsagePaneBody(body: HTMLElement, report: UsageReport | undefined, now = Date.now()): void {
  const document = body.ownerDocument;
  const empty = (text: string) => {
    const note = document.createElement("p");
    note.className = "pane-empty";
    note.textContent = text;
    body.replaceChildren(note);
  };
  if (!report) {
    empty("Plan usage appears here after a Claude Code turn.");
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
  const asOf = `as of ${new Date(report.reportedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  head.textContent = name ? `${name} · ${asOf}` : asOf;
  body.replaceChildren(head, ...buildPlanRowNodes(document, rows));
}

let current: UsageReport | undefined;
let tick: ReturnType<typeof setInterval> | undefined;

/**
 * A fresh report from any conversation replaces the pane's figures
 * wholesale — newest wins, by the report's own time, so revisiting an older
 * conversation cannot roll the pane back. Relative resets are re-painted
 * once a minute for as long as a window carries one.
 */
export function noteUsageReport(report: UsageReport): void {
  if (current && current.reportedAt > report.reportedAt) return;
  current = report;
  paintLiveUsagePane();
  const hasReset = planReadoutRows(report.plan).some(row => row.resetsAt !== undefined);
  if (hasReset && tick === undefined) tick = setInterval(paintLiveUsagePane, TICK_MS);
  if (!hasReset && tick !== undefined) { clearInterval(tick); tick = undefined; }
}

export function currentUsageReport(): UsageReport | undefined {
  return current;
}

function paintLiveUsagePane(): void {
  const body = document.querySelector<HTMLElement>("#usage-pane");
  if (body) renderUsagePaneBody(body, current);
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
