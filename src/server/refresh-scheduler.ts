export const REFRESH_DEBOUNCE_MS = 150;
export const REFRESH_MAX_WAIT_MS = 2000;
export type RefreshSchedulerClock = {
  now(): number;
  setTimer(fn: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
};
const realClock: RefreshSchedulerClock = {
  now: () => performance.now(), setTimer: (fn, delay) => setTimeout(fn, delay), clearTimer: clearTimeout,
};

export function createRefreshScheduler(fire: (changedId: string | null) => void, clock: RefreshSchedulerClock = realClock) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started: number | null = null;
  let changed: string | null = null;
  return {
    schedule(id: string | null = null) {
      if (id) changed = id;
      const now = clock.now();
      started ??= now;
      if (timer) clock.clearTimer(timer);
      timer = clock.setTimer(() => {
        timer = null; started = null;
        const next = changed; changed = null;
        fire(next);
      }, Math.max(0, Math.min(REFRESH_DEBOUNCE_MS, started + REFRESH_MAX_WAIT_MS - now)));
    },
    cancel() {
      if (timer) clock.clearTimer(timer);
      timer = null; started = null; changed = null;
    },
  };
}
