import { describe, expect, it } from "bun:test";

import {
  buildSwitcherRows,
  formatSessionAge,
  pickerCandidates,
  resolveActiveSessionId,
  resolveSessionPlan,
} from "./picker";
import type { TerminalSessionInfo } from "./server";

function session(overrides: Partial<TerminalSessionInfo>): TerminalSessionInfo {
  return {
    id: crypto.randomUUID(),
    attached: false,
    createdAt: 0,
    cols: 80,
    rows: 24,
    label: "zsh",
    ...overrides,
  };
}

describe("pickerCandidates", () => {
  it("filters out sessions this window already shows", () => {
    const shown = session({ id: "11111111-1111-4111-8111-111111111111" });
    const other = session({ id: "22222222-2222-4222-8222-222222222222" });
    const result = pickerCandidates([shown, other], [shown.id]);
    expect(result.map(s => s.id)).toEqual([other.id]);
  });

  it("orders detached before attached, oldest first within each group", () => {
    const attachedOld = session({ id: "a".repeat(8) + "-aaaa-4aaa-8aaa-" + "a".repeat(12), attached: true, createdAt: 100 });
    const detachedNew = session({ createdAt: 900 });
    const detachedOld = session({ createdAt: 100 });
    const result = pickerCandidates([attachedOld, detachedNew, detachedOld], []);
    expect(result[0]).toBe(detachedOld);
    expect(result[1]).toBe(detachedNew);
    expect(result[2]).toBe(attachedOld);
  });

  it("returns empty for an inventory fully covered by shown ids", () => {
    const a = session({});
    expect(pickerCandidates([a], [a.id])).toEqual([]);
    expect(pickerCandidates([], [])).toEqual([]);
  });
});

describe("resolveSessionPlan", () => {
  it("attaches every detached session, oldest first", () => {
    const newer = session({ createdAt: 900 });
    const older = session({ createdAt: 100 });
    const plan = resolveSessionPlan([newer, older], [], 8);
    expect(plan.attach.map(s => s.id)).toEqual([older.id, newer.id]);
    expect(plan.decide).toEqual([]);
  });

  it("never auto-attaches a session held by another client", () => {
    const elsewhere = session({ attached: true, createdAt: 100 });
    const free = session({ createdAt: 200 });
    const plan = resolveSessionPlan([elsewhere, free], [], 8);
    expect(plan.attach.map(s => s.id)).toEqual([free.id]);
    expect(plan.decide.map(s => s.id)).toEqual([elsewhere.id]);
  });

  it("leaves an all-attached-elsewhere inventory entirely to the user", () => {
    const a = session({ attached: true, createdAt: 100 });
    const b = session({ attached: true, createdAt: 200 });
    const plan = resolveSessionPlan([a, b], [], 8);
    expect(plan.attach).toEqual([]);
    expect(plan.decide.map(s => s.id)).toEqual([a.id, b.id]);
  });

  it("truncates the attach set at the free-slot count and defers the overflow", () => {
    const sessions = [100, 200, 300, 400].map(createdAt => session({ createdAt }));
    const plan = resolveSessionPlan(sessions, [], 2);
    expect(plan.attach.map(s => s.createdAt)).toEqual([100, 200]);
    expect(plan.decide.map(s => s.createdAt)).toEqual([300, 400]);
  });

  it("attaches nothing when the window is already at its pane cap", () => {
    const free = session({ createdAt: 100 });
    const plan = resolveSessionPlan([free], [], 0);
    expect(plan.attach).toEqual([]);
    expect(plan.decide.map(s => s.id)).toEqual([free.id]);
  });

  it("offers detached overflow ahead of sessions needing takeover", () => {
    const overflow = session({ createdAt: 300 });
    const elsewhere = session({ attached: true, createdAt: 100 });
    const attachable = session({ createdAt: 200 });
    const plan = resolveSessionPlan([overflow, elsewhere, attachable], [], 1);
    expect(plan.attach.map(s => s.id)).toEqual([attachable.id]);
    expect(plan.decide.map(s => s.id)).toEqual([overflow.id, elsewhere.id]);
  });

  it("ignores sessions this window already shows", () => {
    const shown = session({ createdAt: 100 });
    const other = session({ createdAt: 200 });
    const plan = resolveSessionPlan([shown, other], [shown.id], 8);
    expect(plan.attach.map(s => s.id)).toEqual([other.id]);
    expect(plan.decide).toEqual([]);
  });

  it("plans nothing for empty inventory", () => {
    const plan = resolveSessionPlan([], [], 8);
    expect(plan.attach).toEqual([]);
    expect(plan.decide).toEqual([]);
  });
});

describe("resolveActiveSessionId", () => {
  it("prefers the saved last-active session when it is in the batch", () => {
    const older = session({ createdAt: 100 });
    const newer = session({ createdAt: 900 });
    expect(resolveActiveSessionId([older, newer], older.id)).toBe(older.id);
  });

  it("falls back to the newest session when there is no saved reference", () => {
    const older = session({ createdAt: 100 });
    const newer = session({ createdAt: 900 });
    expect(resolveActiveSessionId([older, newer], undefined)).toBe(newer.id);
  });

  it("falls back to the newest when the saved reference attached elsewhere", () => {
    const attached = session({ createdAt: 100 });
    const held = session({ id: "99999999-9999-4999-8999-999999999999" });
    expect(resolveActiveSessionId([attached], held.id)).toBe(attached.id);
  });

  it("selects nothing for an empty batch", () => {
    expect(resolveActiveSessionId([], "anything")).toBeUndefined();
  });
});

describe("buildSwitcherRows", () => {
  const now = 60 * 60_000;

  it("orders this window's panes first, then detached, then attached elsewhere", () => {
    const mineVisible = session({ createdAt: 100, label: "zsh" });
    const mineHidden = session({ createdAt: 200, label: "vim" });
    const free = session({ createdAt: 300, label: "htop" });
    const elsewhere = session({ attached: true, createdAt: 400, label: "ssh" });
    const rows = buildSwitcherRows(
      [{ sessionId: mineVisible.id }, { sessionId: mineHidden.id }],
      [elsewhere, free, mineHidden, mineVisible],
      mineVisible.id,
      undefined,
      now,
      8,
    );
    expect(rows.map(r => r.state)).toEqual([
      "visible",
      "attached-here",
      "detached",
      "attached-elsewhere",
    ]);
    expect(rows.map(r => r.label)).toEqual(["zsh", "vim", "htop", "ssh"]);
  });

  it("offers selection for every terminal except the visible one", () => {
    const visible = session({ createdAt: 100 });
    const hidden = session({ createdAt: 200 });
    const free = session({ createdAt: 300 });
    const rows = buildSwitcherRows(
      [{ sessionId: visible.id }, { sessionId: hidden.id }],
      [visible, hidden, free],
      visible.id,
      undefined,
      now,
      8,
    );
    expect(rows.map(r => r.canSelect)).toEqual([false, true, true]);
  });

  it("requires takeover rather than selection for a session held elsewhere", () => {
    const elsewhere = session({ attached: true, createdAt: 100 });
    const [row] = buildSwitcherRows([], [elsewhere], undefined, undefined, now, 8);
    expect(row).toMatchObject({ state: "attached-elsewhere", canSelect: false, canTakeOver: true });
  });

  it("disables attach and takeover at the pane cap but keeps switching available", () => {
    const visible = session({ createdAt: 100 });
    const hidden = session({ createdAt: 200 });
    const free = session({ createdAt: 300 });
    const elsewhere = session({ attached: true, createdAt: 400 });
    const rows = buildSwitcherRows(
      [{ sessionId: visible.id }, { sessionId: hidden.id }],
      [visible, hidden, free, elsewhere],
      visible.id,
      undefined,
      now,
      0,
    );
    expect(rows.map(r => r.canSelect)).toEqual([false, true, false, false]);
    expect(rows.map(r => r.canTakeOver)).toEqual([false, false, false, false]);
  });

  it("marks the saved last-active terminal without changing its actions", () => {
    const free = session({ createdAt: 100 });
    const other = session({ createdAt: 200 });
    const rows = buildSwitcherRows([], [free, other], undefined, free.id, now, 8);
    expect(rows.map(r => r.lastActive)).toEqual([true, false]);
    expect(rows.map(r => r.canSelect)).toEqual([true, true]);
  });

  it("keeps a pane whose session left inventory on the list", () => {
    const ghost = { sessionId: "77777777-7777-4777-8777-777777777777" };
    const rows = buildSwitcherRows([ghost], [], ghost.sessionId, undefined, now, 8);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "visible", label: "shell", age: "" });
  });

  it("labels ages from the session's creation time", () => {
    const free = session({ createdAt: now - 5 * 60_000 });
    const [row] = buildSwitcherRows([], [free], undefined, undefined, now, 8);
    expect(row!.age).toBe("5m ago");
  });

  it("returns nothing when the window holds no panes and inventory is empty", () => {
    expect(buildSwitcherRows([], [], undefined, undefined, now, 8)).toEqual([]);
  });
});

describe("formatSessionAge", () => {
  const now = 10 * 24 * 60 * 60_000;

  it("buckets ages coarsely", () => {
    expect(formatSessionAge(now - 10_000, now)).toBe("just now");
    expect(formatSessionAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatSessionAge(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    expect(formatSessionAge(now - 2 * 24 * 60 * 60_000, now)).toBe("2d ago");
  });

  it("clamps a future createdAt to just now", () => {
    expect(formatSessionAge(now + 60_000, now)).toBe("just now");
  });
});
