import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ReadinessResult } from "../credential-types";
import { diagnosticReport, readiness, readinessSummary } from "./readiness";

describe("progressive readiness", () => {
  test("explicit prerequisite prevents successful diagnostics from claiming usability", () => {
    const { document } = parseHTML(readiness([{ layer: "binary", status: "ready", message: "Available" }], "Unlock this key before connecting or signing on this Hub."));
    expect(document.querySelector(".mh-readiness-summary")?.textContent).toContain("Needs attention");
    expect(document.querySelector(".mh-readiness-summary")?.textContent).toContain("Unlock this key");
    expect(document.querySelector(".mh-readiness-summary")?.textContent).not.toContain("Ready on this Hub");
    expect(document.querySelector("details, [data-readiness-layer]")).toBeNull();
  });
  test("summarizes explicit statuses rather than diagnostic prose", () => {
    expect(readinessSummary([]).label).toBe("Not checked");
    expect(readinessSummary([{ layer: "credential", status: "not-applicable", message: "Ready" }]).label).toBe("Not checked");
    expect(readinessSummary([{ layer: "credential", status: "ready", message: "Unavailable, locked" }]).label).toBe("Ready on this Hub");
    expect(readinessSummary([{ layer: "credential", status: "unavailable", message: "Ready" }]).label).toBe("Needs attention");
  });
  test("explicit report retains all 17 anonymous rows without a disclosure", () => {
    const rows: ReadinessResult[] = Array.from({ length: 17 }, (_, i) => ({ layer: i === 16 ? "credential" : "binary", status: i === 16 ? "unavailable" : "ready", message: i === 16 ? "Unlock <this> identity & retry" : "Executable is available" }));
    const { document } = parseHTML(diagnosticReport(rows));
    const details = document.querySelector(".mh-diagnostic-report")!;
    expect(document.querySelector("details")).toBeNull();
    const retained = [...details.querySelectorAll("[data-readiness-layer]")].map(el => ({ layer: el.getAttribute("data-readiness-layer"), status: el.getAttribute("data-readiness-status"), message: el.querySelector("small")?.textContent }));
    expect(retained).toEqual(rows);
    expect(document.querySelectorAll("[data-readiness-layer]")).toHaveLength(17);
    expect(details.textContent).toContain("Unlock <this> identity & retry");
    expect(details.querySelector("this")).toBeNull();
    expect(document.querySelector("[data-tool]")).toBeNull();
  });
  test("concise outcomes deduplicate recovery prose but reports keep every original row", () => {
    const rows: ReadinessResult[] = [{ layer: "binary", status: "unavailable", message: "Missing executable" }, { layer: "runtime", status: "unavailable", message: "Agent unavailable" }];
    rows.push(rows[0]!);
    const { document } = parseHTML(readiness(rows));
    expect(document.querySelectorAll(".mh-readiness-blockers li")).toHaveLength(2);
    expect(document.querySelectorAll("[data-readiness-layer]")).toHaveLength(0);
    expect(parseHTML(diagnosticReport(rows)).document.querySelectorAll("[data-readiness-layer]")).toHaveLength(3);
  });
});
