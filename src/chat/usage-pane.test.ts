import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { buildPlanRowNodes, onRevealUsagePane, renderUsagePaneBody, revealUsagePane } from "./usage-pane";
import { planReadoutRows } from "./composer-status";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();

function paneBody(): HTMLElement {
  const { document } = parseHTML(html);
  return document.querySelector<HTMLElement>("#usage-pane")!;
}

describe("usage pane", () => {
  test("the shipped chrome already carries the empty state, and rendering nothing keeps it", () => {
    const body = paneBody();
    expect(body.textContent).toContain("Plan usage appears here after a Claude Code turn.");
    renderUsagePaneBody(body, undefined);
    expect(body.querySelector(".pane-empty")?.textContent).toBe("Plan usage appears here after a Claude Code turn.");
    expect(body.querySelectorAll(".plan-row")).toHaveLength(0);
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
