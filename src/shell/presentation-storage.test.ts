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

class DeniedStorage implements Storage {
  get length(): number { throw new Error("denied"); }
  clear(): void { throw new Error("denied"); }
  getItem(_key: string): string | null { throw new Error("denied"); }
  key(_index: number): string | null { throw new Error("denied"); }
  removeItem(_key: string): void { throw new Error("denied"); }
  setItem(_key: string, _value: string): void { throw new Error("denied"); }
}

describe("presentation storage under denial", () => {
  test("falls back to client-local values when every method throws", () => {
    const denied = new DeniedStorage();
    const scoped = presentationStorage(denied, "/s/alpha/");
    expect(() => scoped.setItem("terminal-visible", "1")).not.toThrow();
    expect(scoped.getItem("terminal-visible")).toBe("1");
    expect(scoped.getItem("missing")).toBeNull();
    expect(scoped.length).toBe(1);
    expect(scoped.key(0)).toBe("terminal-visible");
    expect(() => scoped.removeItem("terminal-visible")).not.toThrow();
    expect(scoped.getItem("terminal-visible")).toBeNull();
  });

  test("shares the fallback across separate wrappers for one workspace", () => {
    const denied = new DeniedStorage();
    presentationStorage(denied, "/s/alpha/").setItem("sidebar-width", "420");
    expect(presentationStorage(denied, "/s/alpha/").getItem("sidebar-width")).toBe("420");
  });

  test("keeps sibling workspaces isolated in the fallback", () => {
    const denied = new DeniedStorage();
    const alpha = presentationStorage(denied, "/s/alpha/");
    const beta = presentationStorage(denied, "/s/beta/");
    alpha.setItem("view-layout", "split-v");
    beta.setItem("view-layout", "single");
    expect(alpha.getItem("view-layout")).toBe("split-v");
    expect(beta.getItem("view-layout")).toBe("single");
    alpha.clear();
    expect(alpha.getItem("view-layout")).toBeNull();
    expect(beta.getItem("view-layout")).toBe("single");
  });

  test("a denied write is not shadowed by the stale value it failed to replace", () => {
    const raw = new MemoryStorage();
    const quotaBound: Storage = Object.assign(Object.create(raw) as Storage, {
      setItem() { throw new Error("QuotaExceededError"); },
    });
    // Seed a durable value, then deny the update that should replace it.
    presentationStorage(raw, "/s/alpha/").setItem("view-layout", "split-v");
    const scoped = presentationStorage(quotaBound, "/s/alpha/");
    expect(scoped.getItem("view-layout")).toBe("split-v");
    scoped.setItem("view-layout", "stacked");
    expect(scoped.getItem("view-layout")).toBe("stacked");
    // Removal clears both, so the stale durable value cannot resurface.
    scoped.removeItem("view-layout");
    expect(scoped.getItem("view-layout")).toBeNull();
  });

  test("does not throw when a working store rejects only writes", () => {
    const raw = new MemoryStorage();
    const quotaBound: Storage = Object.assign(Object.create(raw) as Storage, {
      setItem() { throw new Error("QuotaExceededError"); },
    });
    const scoped = presentationStorage(quotaBound, "/s/alpha/");
    expect(() => scoped.setItem("terminal-height", "240")).not.toThrow();
    expect(scoped.getItem("terminal-height")).toBe("240");
  });
});
