import type { MessageDelivery } from "./types";

// The delivery Enter uses while a steering conversation is busy, per device
// (opencode-v2-steering D10). Stored in the presentation scope, so it is
// scoped by base path like every other per-device chat preference, and read
// on every submission rather than cached: another tab on the same device may
// have changed it.
export const DELIVERY_PREFERENCE_KEY = "chat-delivery";
export const DEFAULT_DELIVERY: MessageDelivery = "steer";

export function readDeliveryPreference(storage: Storage | null): MessageDelivery {
  try {
    const value = storage?.getItem(DELIVERY_PREFERENCE_KEY);
    return value === "queue" ? "queue" : DEFAULT_DELIVERY;
  } catch {
    return DEFAULT_DELIVERY;
  }
}

export function writeDeliveryPreference(storage: Storage | null, delivery: MessageDelivery): void {
  try {
    storage?.setItem(DELIVERY_PREFERENCE_KEY, delivery);
  } catch {
    // Best effort: a device that refuses storage keeps the default.
  }
}

/** The delivery Enter does not use: what ⌥Enter submits with. */
export function otherDelivery(delivery: MessageDelivery): MessageDelivery {
  return delivery === "steer" ? "queue" : "steer";
}
