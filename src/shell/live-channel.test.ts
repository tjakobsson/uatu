import { describe, expect, test } from "bun:test";

import {
  createLiveChannel,
  reconnectDelay,
  RECONNECT_MAX_DELAY_MS,
  type LiveChannelSource,
  type LiveChannelStatus,
  type LiveChannelTimers,
} from "./live-channel";

type FakeSource = LiveChannelSource & {
  generation: number;
  closed: boolean;
  fail(): void;
  emit(type: string): void;
};

function createHarness() {
  const sources: FakeSource[] = [];
  const statuses: LiveChannelStatus[] = [];
  const reconnectFlags: boolean[] = [];
  const scheduled: { delay: number; run: () => void; id: number }[] = [];
  let nextTimerId = 1;

  const timers: LiveChannelTimers = {
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      scheduled.push({ delay, run: callback, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer) {
      const index = scheduled.findIndex(entry => entry.id === (timer as unknown as number));
      if (index >= 0) scheduled.splice(index, 1);
    },
  };

  const channel = createLiveChannel({
    timers,
    onStatus: status => statuses.push(status),
    open: (generation, context) => {
      reconnectFlags.push(context.reconnect);
      const listeners = new Map<string, ((event: Event) => void)[]>();
      const source: FakeSource = {
        generation,
        closed: false,
        addEventListener(type, listener) {
          const bucket = listeners.get(type) ?? [];
          bucket.push(listener);
          listeners.set(type, bucket);
        },
        close() {
          source.closed = true;
        },
        emit(type) {
          for (const listener of listeners.get(type) ?? []) listener(new Event(type));
        },
        fail() {
          source.emit("error");
        },
      };
      sources.push(source);
      return source;
    },
  });

  return {
    channel,
    sources,
    statuses,
    reconnectFlags,
    scheduled,
    // Fires exactly the pending reconnect, mirroring a real timer firing once.
    runPendingTimer() {
      const entry = scheduled.shift();
      if (!entry) throw new Error("no reconnect scheduled");
      entry.run();
      return entry.delay;
    },
  };
}

describe("createLiveChannel", () => {
  test("repeated failures keep reconnecting on a capped exponential schedule", () => {
    const harness = createHarness();
    harness.channel.connect();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      harness.sources.at(-1)!.fail();
      delays.push(harness.runPendingTimer());
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(RECONNECT_MAX_DELAY_MS).toBe(15_000);
    // Eight sources: the original plus one per reconnect. The cycle never
    // gives up waiting for the browser to leave CONNECTING.
    expect(harness.sources).toHaveLength(8);
    expect(harness.statuses.every(status => status === "reconnecting")).toBe(true);
  });

  test("a failed source is closed so the browser's own retry cannot race ours", () => {
    const harness = createHarness();
    harness.channel.connect();
    const first = harness.sources[0]!;
    first.fail();
    expect(first.closed).toBe(true);
  });

  test("an error burst from one source schedules a single reconnect", () => {
    const harness = createHarness();
    harness.channel.connect();
    harness.sources[0]!.fail();
    harness.sources[0]!.fail();
    harness.sources[0]!.fail();
    expect(harness.scheduled).toHaveLength(1);
    harness.runPendingTimer();
    expect(harness.sources).toHaveLength(2);
  });

  test("callbacks from a superseded generation are ignored", () => {
    const harness = createHarness();
    harness.channel.connect();
    const stale = harness.sources[0]!;
    const staleGeneration = harness.channel.currentGeneration();

    harness.channel.connect();
    expect(stale.closed).toBe(true);
    expect(harness.channel.isCurrent(staleGeneration)).toBe(false);
    expect(harness.channel.isCurrent(harness.channel.currentGeneration())).toBe(true);
    // Superseding a generation leaves nothing confirmed, and the channel says
    // so rather than coasting on the previous generation's success.
    expect(harness.statuses).toEqual(["reconnecting"]);

    // A late error from the superseded source must not disturb the new one.
    stale.fail();
    expect(harness.scheduled).toHaveLength(0);
    expect(harness.statuses).toEqual(["reconnecting"]);

    // Nor may a late confirmation from it report a stale success.
    harness.channel.confirm(staleGeneration);
    expect(harness.statuses).toEqual(["reconnecting"]);
  });

  test("a deliberate replacement of a confirmed channel stops claiming Connected", () => {
    const harness = createHarness();
    harness.channel.connect();
    harness.channel.confirm(harness.channel.currentGeneration());
    expect(harness.statuses.at(-1)).toBe("live");

    // A lifecycle wake-up or a context change replaces the stream. Nothing is
    // confirmed until the replacement delivers state, and the replacement may
    // take arbitrarily long.
    harness.channel.connect();
    expect(harness.statuses.at(-1)).toBe("reconnecting");
    expect(harness.channel.isRecovering()).toBe(true);

    harness.channel.confirm(harness.channel.currentGeneration());
    expect(harness.statuses.at(-1)).toBe("live");
  });

  test("the first connect leaves the shell on its own Connecting state", () => {
    const harness = createHarness();
    harness.channel.connect();
    expect(harness.statuses).toEqual([]);
  });

  test("an attempt is marked a recovery only when it replaces a lost stream", () => {
    const harness = createHarness();
    harness.channel.connect();
    expect(harness.reconnectFlags).toEqual([false]);

    // A deliberate context change is not a recovery.
    harness.channel.connect();
    expect(harness.reconnectFlags).toEqual([false, false]);

    // A caller replacing a stream it believes it lost says so.
    harness.channel.connect({ resumed: true });
    expect(harness.reconnectFlags).toEqual([false, false, true]);

    // And the channel's own retry after a failure is one by definition.
    harness.sources.at(-1)!.fail();
    harness.runPendingTimer();
    expect(harness.reconnectFlags).toEqual([false, false, true, true]);
  });

  test("confirming the current generation reports live and resets failure accounting", () => {
    const harness = createHarness();
    harness.channel.connect();

    harness.sources.at(-1)!.fail();
    expect(harness.runPendingTimer()).toBe(1_000);
    harness.sources.at(-1)!.fail();
    expect(harness.runPendingTimer()).toBe(2_000);

    harness.channel.confirm(harness.channel.currentGeneration());
    expect(harness.statuses.at(-1)).toBe("live");
    expect(harness.channel.isRecovering()).toBe(false);

    // The next interruption starts a fresh sequence rather than inheriting the
    // old failure count.
    harness.sources.at(-1)!.fail();
    expect(harness.runPendingTimer()).toBe(1_000);
  });

  test("an open stream alone is not treated as connected", () => {
    const harness = createHarness();
    harness.channel.connect();
    harness.sources[0]!.emit("open");
    expect(harness.statuses).toEqual([]);
  });

  test("a replacement that opens but delivers nothing keeps reporting reconnecting", () => {
    const harness = createHarness();
    harness.channel.connect();
    harness.channel.confirm(harness.channel.currentGeneration());
    harness.channel.connect();
    harness.sources.at(-1)!.emit("open");
    expect(harness.statuses.at(-1)).toBe("reconnecting");
  });

  test("disposal stops the retry cycle and closes the current source", () => {
    const harness = createHarness();
    harness.channel.connect();
    harness.sources[0]!.fail();
    expect(harness.scheduled).toHaveLength(1);

    harness.channel.dispose();
    expect(harness.scheduled).toHaveLength(0);

    // Nothing reopens after disposal, from any entry point.
    harness.channel.connect();
    expect(harness.sources).toHaveLength(1);
    harness.channel.confirm(harness.channel.currentGeneration());
    expect(harness.statuses).toEqual(["reconnecting"]);
    expect(harness.channel.isCurrent(harness.channel.currentGeneration())).toBe(false);
  });

  test("a disposed source that errors late cannot resurrect the cycle", () => {
    const harness = createHarness();
    harness.channel.connect();
    const source = harness.sources[0]!;
    harness.channel.dispose();
    source.fail();
    expect(harness.scheduled).toHaveLength(0);
    expect(harness.statuses).toEqual([]);
  });
});

describe("reconnectDelay", () => {
  test("doubles from one second and saturates at the cap", () => {
    expect([1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  });
});
