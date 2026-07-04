import { describe, expect, it } from "bun:test";

import { formatSessionAge, pickerCandidates } from "./picker";
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
