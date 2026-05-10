import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MetricsRegistry,
  NdjsonAppender,
  writeSnapshotAtomic,
} from "./debug-metrics";

describe("MetricsRegistry", () => {
  test("inc / set / get round-trip", () => {
    const reg = new MetricsRegistry();
    reg.inc("a");
    reg.inc("a", 4);
    reg.set("b", 7);
    expect(reg.get("a")).toBe(5);
    expect(reg.get("b")).toBe(7);
    expect(reg.get("missing")).toBe(0);
  });

  test("snapshot is JSON-serializable and includes pid + counters", () => {
    const reg = new MetricsRegistry();
    reg.inc("foo");
    reg.set("bar", 99);
    const snap = reg.snapshot(1234, 1_700_000_000_000);
    expect(snap.pid).toBe(1234);
    expect(snap.takenAtMs).toBe(1_700_000_000_000);
    expect(snap.counters).toEqual({ foo: 1, bar: 99 });
    // Round-trip through JSON without loss.
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  test("snapshot is a copy — later mutations don't leak", () => {
    const reg = new MetricsRegistry();
    reg.inc("x");
    const snap = reg.snapshot(1, 0);
    reg.inc("x", 10);
    expect(snap.counters.x).toBe(1);
  });
});

describe("writeSnapshotAtomic", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-snap-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("writes valid JSON and overwrites previous content", async () => {
    const target = path.join(dir, "snap.json");
    await writeSnapshotAtomic(target, { takenAtMs: 1, pid: 9, counters: { a: 1 } });
    const first = JSON.parse(await fs.readFile(target, "utf8"));
    expect(first).toEqual({ takenAtMs: 1, pid: 9, counters: { a: 1 } });

    await writeSnapshotAtomic(target, { takenAtMs: 2, pid: 9, counters: { a: 2, b: 5 } });
    const second = JSON.parse(await fs.readFile(target, "utf8"));
    expect(second).toEqual({ takenAtMs: 2, pid: 9, counters: { a: 2, b: 5 } });

    // The .tmp file must not linger.
    await expect(fs.stat(`${target}.tmp`)).rejects.toThrow();
  });
});

describe("NdjsonAppender ring-buffer", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-nd-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("appends one JSON line per call", async () => {
    const target = path.join(dir, "log.ndjson");
    const appender = new NdjsonAppender(target);
    await appender.append({ takenAtMs: 1, pid: 1, counters: {} });
    await appender.append({ takenAtMs: 2, pid: 1, counters: { a: 1 } });
    const text = await fs.readFile(target, "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ takenAtMs: 1, pid: 1, counters: {} });
    expect(JSON.parse(lines[1]!)).toEqual({ takenAtMs: 2, pid: 1, counters: { a: 1 } });
  });

  test("truncates at the soft cap and keeps recent history", async () => {
    const target = path.join(dir, "log.ndjson");
    // Tiny cap so a few writes trigger truncation.
    const appender = new NdjsonAppender(target, { softCapBytes: 200 });
    for (let i = 0; i < 50; i += 1) {
      await appender.append({ takenAtMs: i, pid: 1, counters: { i } });
    }
    const text = await fs.readFile(target, "utf8");
    expect(text.length).toBeLessThan(400);
    const lines = text.split("\n").filter(Boolean);
    // Each line must still be valid JSON (truncation snaps to newlines).
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.takenAtMs).toBe("number");
    }
    // The most recent entry must still be present.
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    expect(lastEntry.counters.i).toBe(49);
  });
});
