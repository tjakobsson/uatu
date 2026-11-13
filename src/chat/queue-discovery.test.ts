import { expect, test } from "bun:test";
import { QueueDiscovery } from "./queue-discovery";

test("only successful hold acceptance retires discovery, including when storage is unavailable", () => {
  const storage = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); } } as unknown as Storage;
  const hint = new QueueDiscovery(storage);
  expect(hint.visible(true)).toBe(true);
  expect(hint.visible(false)).toBe(false);
  hint.accepted(false);
  expect(hint.visible(true)).toBe(true);
  hint.accepted(true);
  expect(hint.visible(true)).toBe(false);
});

test("discovery persists only a boolean, not draft or receipt data", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key), setItem: (key: string, value: string) => data.set(key, value) } as unknown as Storage;
  new QueueDiscovery(storage).accepted(true);
  expect([...data.values()]).toEqual(["1"]);
  expect(new QueueDiscovery(storage).visible(true)).toBe(false);
});
