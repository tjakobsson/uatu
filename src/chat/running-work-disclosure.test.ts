import { describe, expect, test } from "bun:test";

import { RunningWorkDisclosure } from "./running-work-disclosure";

describe("a pinned list of running work", () => {
  test("an automatic open retained across conversations stays automatic when the new work detaches", () => {
    const list = new RunningWorkDisclosure();
    expect(list.paint("A", 1)).toBe(true);
    list.toggled(true);
    expect(list.paint(null, 0)).toBeUndefined();
    expect(list.paint("B", 0)).toBeUndefined();
    expect(list.paint("B", 1)).toBeUndefined();
    expect(list.paint("B", 0, true)).toBe(false);
  });

  test("a deliberate open retained across conversations stays deliberate when the new work detaches", () => {
    const list = new RunningWorkDisclosure();
    list.paint("A", 1);
    list.toggled(false);
    list.toggled(true);
    expect(list.paint("B", 0)).toBeUndefined();
    expect(list.paint("B", 1)).toBeUndefined();
    expect(list.paint("B", 0, true)).toBeUndefined();
  });
  test("detaching work collapses only the automatic expansion, including its late toggle echo", () => {
    const list = new RunningWorkDisclosure();
    expect(list.paint("one", 1)).toBe(true);
    expect(list.paint("one", 0, true)).toBe(false);
    list.toggled(false);
    expect(list.paint("one", 0, true)).toBeUndefined();
    expect(list.paint("one", 1)).toBe(true);
  });

  test("a deliberate reopening is retained when the work detaches", () => {
    const list = new RunningWorkDisclosure();
    list.paint("one", 1);
    list.toggled(false);
    list.toggled(true);
    expect(list.paint("one", 0, true)).toBeUndefined();
  });
  test("opens when running work first appears, and only then", () => {
    const list = new RunningWorkDisclosure();
    expect(list.paint("one", 0)).toBeUndefined();
    expect(list.paint("one", 1)).toBe(true);
    // Already open by its own hand: more work, or the same work repainted,
    // asks for nothing.
    list.toggled(true);
    expect(list.paint("one", 1)).toBeUndefined();
    expect(list.paint("one", 2)).toBeUndefined();
  });

  test("a list already open is not asked to open again", () => {
    const list = new RunningWorkDisclosure(true);
    expect(list.paint("one", 1)).toBeUndefined();
  });

  test("a user collapse of running work survives further work, and ends with that work", () => {
    const list = new RunningWorkDisclosure();
    expect(list.paint("one", 1)).toBe(true);
    list.toggled(true);
    list.toggled(false);
    expect(list.paint("one", 2)).toBeUndefined();
    expect(list.paint("one", 1)).toBeUndefined();
    // The work is over: the list is left as the user left it, and the next
    // work opens it again.
    expect(list.paint("one", 0)).toBeUndefined();
    expect(list.paint("one", 1)).toBe(true);
  });

  test("the list's own open is not taken for a user choice, however late its event lands", () => {
    const list = new RunningWorkDisclosure();
    expect(list.paint("one", 1)).toBe(true);
    // The user collapses before the open's own `toggle` has been delivered:
    // each event reads the element as it now stands, closed.
    list.toggled(false);
    list.toggled(false);
    expect(list.paint("one", 2)).toBeUndefined();
    // And the echo of an open that did stand is not a collapse either.
    const other = new RunningWorkDisclosure();
    expect(other.paint("one", 1)).toBe(true);
    other.toggled(true);
    expect(other.paint("one", 0)).toBeUndefined();
    expect(other.paint("one", 1)).toBeUndefined();
  });

  test("reopening by hand takes the collapse back", () => {
    const list = new RunningWorkDisclosure();
    list.paint("one", 1);
    list.toggled(false);
    list.toggled(true);
    list.toggled(false);
    list.toggled(true);
    // Open, so nothing is asked; closing again is again a held collapse.
    expect(list.paint("one", 2)).toBeUndefined();
    list.toggled(false);
    expect(list.paint("one", 3)).toBeUndefined();
  });

  test("collapsing a list that holds only finished work is not held against new work", () => {
    const list = new RunningWorkDisclosure(true);
    expect(list.paint("one", 0)).toBeUndefined();
    list.toggled(false);
    expect(list.paint("one", 1)).toBe(true);
  });

  test("a collapse belongs to its conversation: the next one's running work opens the list", () => {
    const list = new RunningWorkDisclosure();
    list.paint("one", 1);
    list.toggled(false);
    expect(list.paint("two", 1)).toBe(true);
    // Back again, the earlier collapse is not resurrected either: the list
    // is shown open, as it now stands, and stays so.
    list.toggled(true);
    expect(list.paint("one", 1)).toBeUndefined();
  });

  test("no conversation shown is a selection in flight, not the work ending", () => {
    const list = new RunningWorkDisclosure();
    list.paint("one", 1);
    list.toggled(false);
    expect(list.paint(null, 0)).toBeUndefined();
    expect(list.paint("one", 1)).toBeUndefined();
  });
});
