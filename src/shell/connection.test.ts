import { afterAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
import type { LiveChannelSource, LiveChannelTimers } from "./live-channel";

const savedGlobals = new Map<string, unknown>();
const CHILD_PROCESS_FLAG = "UATU_CONNECTION_TEST_CHILD";

// `shell/connection.ts` queries its DOM at module load, so the module can only
// be imported once per process and only after globals exist. Running the
// browser half in a child keeps that global mutation out of the rest of the
// unit suite.
if (process.env[CHILD_PROCESS_FLAG] !== "1") {
  describe("shell connection indicator", () => {
    test("runs the browser integration in an isolated process", async () => {
      const child = Bun.spawn({
        cmd: [process.execPath, "test", import.meta.path],
        env: { ...process.env, [CHILD_PROCESS_FLAG]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    });
  });
} else {
  const { document, window } = parseHTML(html);
  const values: Record<string, unknown> = { document, window, Event: (window as unknown as Record<string, unknown>).Event };
  for (const [key, value] of Object.entries(values)) {
    savedGlobals.set(key, Reflect.get(globalThis, key));
    Reflect.set(globalThis, key, value);
  }

  const { applyChannelStatus } = await import("./connection");
  const { createLiveChannel } = await import("./live-channel");

  const indicator = document.querySelector("#connection-state") as unknown as HTMLElement;
  const label = indicator.querySelector(".connection-label") as unknown as HTMLElement;

  const readIndicator = () => ({
    label: label.textContent,
    title: indicator.getAttribute("title"),
    live: indicator.classList.contains("is-live"),
    reconnecting: indicator.classList.contains("is-reconnecting"),
    connecting: indicator.classList.contains("is-connecting"),
  });

  type FakeSource = LiveChannelSource & { fail(): void; open(): void };

  function harness() {
    const sources: FakeSource[] = [];
    const scheduled: { run: () => void; id: number }[] = [];
    let nextId = 1;
    const timers: LiveChannelTimers = {
      setTimeout(callback) {
        const id = nextId++;
        scheduled.push({ run: callback, id });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(timer) {
        const index = scheduled.findIndex(entry => entry.id === (timer as unknown as number));
        if (index >= 0) scheduled.splice(index, 1);
      },
    };
    const channel = createLiveChannel({
      timers,
      onStatus: applyChannelStatus,
      open: () => {
        const listeners: ((event: Event) => void)[] = [];
        const source: FakeSource = {
          addEventListener(type, listener) {
            if (type === "error") listeners.push(listener);
          },
          close() {},
          open() {},
          fail() {
            for (const listener of [...listeners]) listener(new Event("error"));
          },
        };
        sources.push(source);
        return source;
      },
    });
    return {
      channel,
      sources,
      fireReconnect() {
        const entry = scheduled.shift();
        if (!entry) throw new Error("no reconnect scheduled");
        entry.run();
      },
    };
  }

  describe("shell connection indicator", () => {
    test("stays Connecting until the first generation's state is applied, then reads Connected", () => {
      const h = harness();
      expect(readIndicator().label).toBe("Connecting");

      h.channel.connect();
      // An open socket proves nothing: the payload has not arrived.
      expect(readIndicator().label).toBe("Connecting");

      h.channel.confirm(h.channel.currentGeneration());
      expect(readIndicator()).toMatchObject({
        label: "Connected",
        title: "Connected to the uatu backend",
        live: true,
        reconnecting: false,
      });
    });

    test("stays Reconnecting across the whole gap and returns to Connected as soon as state is applied", () => {
      const h = harness();
      h.channel.connect();
      h.channel.confirm(h.channel.currentGeneration());
      expect(readIndicator().live).toBe(true);

      h.sources.at(-1)!.fail();
      expect(readIndicator()).toMatchObject({
        label: "Reconnecting",
        title: "Reconnecting to the uatu backend",
        reconnecting: true,
        live: false,
      });

      // A replacement stream opens but has not yet delivered state — the
      // indicator must not claim recovery on transport alone.
      h.fireReconnect();
      expect(readIndicator().label).toBe("Reconnecting");

      // Still nothing after another failed attempt.
      h.sources.at(-1)!.fail();
      h.fireReconnect();
      expect(readIndicator().label).toBe("Reconnecting");

      // The moment authoritative state lands, without any watched file
      // changing afterwards.
      h.channel.confirm(h.channel.currentGeneration());
      expect(readIndicator()).toMatchObject({ label: "Connected", live: true, reconnecting: false });
    });

    test("a stale generation's late confirmation cannot report recovery", () => {
      const h = harness();
      h.channel.connect();
      const stale = h.channel.currentGeneration();
      h.sources.at(-1)!.fail();
      h.fireReconnect();
      expect(readIndicator().label).toBe("Reconnecting");

      h.channel.confirm(stale);
      expect(readIndicator().label).toBe("Reconnecting");
    });
  });

  afterAll(() => {
    for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
  });
}
