import type { ReadinessResult } from "../credential-types";
import { escapeHtml as esc } from "../../shared/html";

/** Summarize supplied statuses only. Anonymous credential checks have no tool identity. */
export function readinessSummary(rows: readonly ReadinessResult[]) {
  const ready = rows.filter(row => row.status === "ready").length;
  const unavailable = rows.filter(row => row.status === "unavailable").length;
  const notApplicable = rows.filter(row => row.status === "not-applicable").length;
  return {
    label: unavailable ? "Needs attention" : ready ? "Ready on this Hub" : "Not checked",
    ready, unavailable, notApplicable, total: rows.length,
  };
}

export function readiness(rows: readonly ReadinessResult[], prerequisite = ""): string {
  const summary = readinessSummary(rows);
  if (prerequisite) summary.label = "Needs attention";
  const blockers = rows.filter(row => row.status === "unavailable");
  return `<div class="mh-readiness"><div class="mh-readiness-summary"><strong>${summary.label}</strong><p class="mh-note">${prerequisite ? esc(prerequisite) : blockers.length ? "Resolve these issues, then check setup again." : summary.ready ? "Local setup checks passed. Remote permissions have not been checked." : "No applicable checks were returned."}</p></div>${blockers.length ? `<ul class="mh-readiness-blockers">${[...new Set(blockers.map(r => r.message))].map(message => `<li>${esc(message)}</li>`).join("")}</ul>` : ""}</div>`;
}

/** The explicit report preserves every backend row, including repeated anonymous checks. */
export function diagnosticReport(rows: readonly ReadinessResult[]): string {
  const labels = { binary: "Required software", version: "Software compatibility", runtime: "Local services", credential: "Key or token availability", capability: "Selected purpose" };
  const statuses = { ready: "Passed", unavailable: "Needs attention", "not-applicable": "Not applicable" };
  const row = (r: ReadinessResult) => `<div class="mh-fact-row mh-fact-row-stacked" data-readiness-layer="${esc(r.layer)}" data-readiness-status="${esc(r.status)}"><span>${statuses[r.status]}</span><span class="mh-value"><small>${esc(r.message)}</small></span></div>`;
  const reports = Object.entries(labels).map(([layer, label]) => {
    const checks = rows.filter(r => r.layer === layer);
    return checks.length ? `<section><h4>${label}</h4>${checks.map(row).join("")}</section>` : "";
  }).join("");
  return `<div class="mh-diagnostic-report">${reports || '<p class="mh-note">No checks were returned.</p>'}</div>`;
}
