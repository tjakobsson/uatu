import { describe, expect, test } from "bun:test";

import { DELIVERY_PREFERENCE_KEY, readDeliveryPreference, writeDeliveryPreference } from "./delivery-preference";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("the default delivery preference (opencode-v2-steering D10)", () => {
  test("starts as steer, and is read back as written", () => {
    const storage = memoryStorage();
    expect(readDeliveryPreference(storage)).toBe("steer");
    writeDeliveryPreference(storage, "queue");
    expect(readDeliveryPreference(storage)).toBe("queue");
    expect(storage.getItem(DELIVERY_PREFERENCE_KEY)).toBe("queue");
    writeDeliveryPreference(storage, "steer");
    expect(readDeliveryPreference(storage)).toBe("steer");
  });

  test("an unknown or unreadable value falls back to steer", () => {
    const storage = memoryStorage();
    storage.setItem(DELIVERY_PREFERENCE_KEY, "later");
    expect(readDeliveryPreference(storage)).toBe("steer");
    const broken: Storage = { ...storage, getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readDeliveryPreference(broken)).toBe("steer");
    expect(() => writeDeliveryPreference(broken, "queue")).not.toThrow();
    // No storage at all (a private window refusing it) reads as the default.
    expect(readDeliveryPreference(null)).toBe("steer");
  });
});
