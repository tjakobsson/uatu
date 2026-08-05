import { describe, expect, test } from "bun:test";

import { presentationStorage } from "./presentation-storage";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("presentation storage", () => {
  test("isolates sibling Hub workspaces on one origin", () => {
    const raw = new MemoryStorage();
    const alpha = presentationStorage(raw, "/s/alpha/");
    const beta = presentationStorage(raw, "/s/beta/");
    alpha.setItem("sidebar-width", "420");
    beta.setItem("sidebar-width", "280");
    expect(alpha.getItem("sidebar-width")).toBe("420");
    expect(beta.getItem("sidebar-width")).toBe("280");
    expect(raw.getItem("sidebar-width")).toBeNull();
  });

  test("ignores legacy keys and clears only one workspace", () => {
    const raw = new MemoryStorage();
    raw.setItem("uatu:view-layout", "split-h");
    const alpha = presentationStorage(raw, "/s/alpha/");
    const beta = presentationStorage(raw, "/s/beta/");
    alpha.setItem("view-layout", "split-v");
    beta.setItem("view-layout", "single");
    expect(alpha.getItem("uatu:view-layout")).toBeNull();
    alpha.clear();
    expect(beta.getItem("view-layout")).toBe("single");
    expect(raw.getItem("uatu:view-layout")).toBe("split-h");
  });

  test("keeps the same workspace independent across browser clients", () => {
    const macBrowser = presentationStorage(new MemoryStorage(), "/s/project/");
    const narrowBrowser = presentationStorage(new MemoryStorage(), "/s/project/");
    macBrowser.setItem("terminal-width", "560");
    narrowBrowser.setItem("terminal-height", "240");
    expect(narrowBrowser.getItem("terminal-width")).toBeNull();
    expect(macBrowser.getItem("terminal-height")).toBeNull();
  });
});
