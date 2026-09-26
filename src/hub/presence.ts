// Whether a hub user is looking at Uatu, as the notification engine reads it.
//
//   present  at least one of the user's session pages is visible on some
//            device — it holds a live stream subscribed to `activity`
//            (hidden pages release theirs, the dashboard never asks for it)
//   recent   no such page now, but one was within the grace period, or the
//            hub started less than a grace period ago and pages may still
//            be reconnecting
//   away     neither
//
// The broker owns the signal (src/hub/live-broker.ts); src/hub/notifications.ts
// only reads it. Presence is per hub user across all of that user's devices.
export type Presence = "present" | "recent" | "away";

// How long a user stays `recent` after their last visible session page goes:
// long enough to absorb a tab switch or a stream reconnect, short enough that
// a question left unanswered still follows the user out promptly.
export const PRESENCE_GRACE_MS = 30_000;

export type PresenceSource = {
  presence(user: string): Presence;
  onPresenceChange(listener: (user: string) => void): () => void;
};
