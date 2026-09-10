import { afterEach, expect, test } from "bun:test";
import { dispatchMobileHistory, installMobileHistory, onWorkspaceForegroundChange, setWorkspaceForeground, workspaceForeground, writeMobileHistory } from "./coordinator-context";

afterEach(() => setWorkspaceForeground(true));
test("standalone defaults stay active; modal and Hub presentation gate only interaction", () => {
  expect(workspaceForeground()).toBe(true);
  const seen: boolean[] = [];
  const stop = onWorkspaceForegroundChange(() => seen.push(workspaceForeground()));
  setWorkspaceForeground(false);
  setWorkspaceForeground(false);
  setWorkspaceForeground(true, true);
  expect(workspaceForeground()).toBe(false);
  setWorkspaceForeground(true);
  expect(seen).toEqual([false, false, true]);
  stop();
});
test("one optional route owner partitions before workspace history; removing it restores defaults", () => {
  const event = { state: { documentId: "a" } } as PopStateEvent;
  expect(dispatchMobileHistory(event)).toBe(false);
  const writes: unknown[] = [];
  const stop = installMobileHistory({ dispatch: value => value === event, write: (...values) => { writes.push(values); return true; } });
  try {
    expect(dispatchMobileHistory(event)).toBe(true);
    expect(() => installMobileHistory({ dispatch: () => true, write: () => true })).toThrow();
    expect(writeMobileHistory({ documentId: "a" }, "/s/a/doc.md", true)).toBe(true);
    expect(writes).toEqual([[{ documentId: "a" }, "/s/a/doc.md", true]]);
  } finally { stop(); }
  expect(dispatchMobileHistory(event)).toBe(false);
  expect(writeMobileHistory({}, "/doc.md", false)).toBe(false);
});
