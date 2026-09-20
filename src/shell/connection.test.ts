import { afterAll, afterEach, describe, expect, test } from "bun:test";
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

  const { applyChannelStatus, connectionDisplayState } = await import("./connection");
  const { createLiveChannel } = await import("./live-channel");
  const { installLiveChannelForTests, installManualRecoveryForTests } = await import("./live");
  const { installHubNavigationForTests } = await import("./hub-nav");
  const { setCurrentSessionRunning } = await import("./session-running");

  const indicator = document.querySelector("#connection-state") as unknown as HTMLElement;
  const label = indicator.querySelector(".connection-label") as unknown as HTMLElement;
  const errorLine = document.querySelector("#connection-error") as unknown as HTMLElement;

  const readIndicator = () => ({
    label: label.textContent,
    title: indicator.getAttribute("title"),
    live: indicator.classList.contains("is-live"),
    reconnecting: indicator.classList.contains("is-reconnecting"),
    connecting: indicator.classList.contains("is-connecting"),
    stopped: indicator.classList.contains("is-stopped"),
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
      ws: null,
      activity: false,
      timers,
      fetcher: async () => new Response("{}"),
      openSource: () => {
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
    channel.onStatus(applyChannelStatus);
    return {
      channel,
      sources,
      timers,
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

  describe("connection indicator reconnect control", () => {
    // The control drives the real `requestManualRecovery`, so the harness
    // channel has to be the page's channel and the reload / attempt window
    // have to be injected — otherwise the test would reload the process's
    // `window` and wait ten real seconds for the fallback.
    function controlHarness() {
      const h = harness();
      installLiveChannelForTests(h.channel);
      let reloads = 0;
      installManualRecoveryForTests({ reload: () => { reloads += 1; }, timers: h.timers });
      return { ...h, reloads: () => reloads };
    }

    const click = () => indicator.dispatchEvent(new Event("click"));
    // The attempt settles through the promise chain `requestManualRecovery`
    // built, so the DOM catches up a few microtasks after `confirm`.
    const settled = () => new Promise(resolve => setTimeout(resolve, 0));

    afterEach(() => {
      installLiveChannelForTests(null);
      installManualRecoveryForTests(null);
    });

    test("names the reconnect action rather than the state", () => {
      const h = controlHarness();
      h.channel.connect();
      h.channel.confirm(h.channel.currentGeneration());
      h.sources.at(-1)!.fail();

      expect(readIndicator().label).toBe("Reconnecting");
      expect(indicator.getAttribute("aria-label")).toBe("Reconnect to the uatu backend");
      // The title still names the state — it is what hover is for.
      expect(indicator.getAttribute("title")).toBe("Reconnecting to the uatu backend");
    });

    test("is inert while the connection is confirmed live", () => {
      const h = controlHarness();
      h.channel.connect();
      h.channel.confirm(h.channel.currentGeneration());
      expect(readIndicator().live).toBe(true);
      expect(indicator.getAttribute("aria-disabled")).toBe("true");

      const before = h.sources.length;
      click();
      // No superseding connect: a healthy page must not be disturbed.
      expect(h.sources.length).toBe(before);
      expect(indicator.hasAttribute("aria-busy")).toBe(false);
    });

    test("activation recovers in place, shows the attempt, and does not pile up", async () => {
      const h = controlHarness();
      h.channel.connect();
      h.channel.confirm(h.channel.currentGeneration());
      h.sources.at(-1)!.fail();
      const before = h.sources.length;

      click();
      expect(h.sources.length).toBe(before + 1);
      expect(indicator.getAttribute("aria-busy")).toBe("true");
      expect(indicator.classList.contains("is-attempting")).toBe(true);
      expect(indicator.getAttribute("aria-disabled")).toBe("false");

      // A second tap joins the attempt already running.
      click();
      expect(h.sources.length).toBe(before + 1);

      h.channel.confirm(h.channel.currentGeneration());
      await settled();
      expect(readIndicator()).toMatchObject({ label: "Connected", live: true });
      expect(indicator.hasAttribute("aria-busy")).toBe(false);
      expect(indicator.classList.contains("is-attempting")).toBe(false);
      expect(h.reloads()).toBe(0);
    });
  });

  describe("connection indicator on a stopped session", () => {
    const click = () => indicator.dispatchEvent(new Event("click"));
    const settled = () => new Promise(resolve => setTimeout(resolve, 0));
    const savedFetch = globalThis.fetch;
    const navigations: string[] = [];

    // The page is served at /s/uatu/ on a hub: the start targets that id.
    const meta = document.createElement("meta");
    meta.setAttribute("name", "uatu-base-path");
    meta.setAttribute("content", "/s/uatu/");
    document.head.appendChild(meta);

    function stoppedHarness(answer: { status: number; body: unknown } | "network") {
      const h = harness();
      installLiveChannelForTests(h.channel);
      let reloads = 0;
      installManualRecoveryForTests({ reload: () => { reloads += 1; }, timers: h.timers });
      installHubNavigationForTests(href => navigations.push(href));
      const starts: string[] = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.endsWith("/start")) {
          starts.push(url);
          if (answer === "network") throw new TypeError("network down");
          return Response.json(answer.body, { status: answer.status });
        }
        return new Response("{}");
      }) as unknown as typeof fetch;
      // Connected, then the child goes away and the hub says stopped.
      h.channel.connect();
      h.channel.confirm(h.channel.currentGeneration());
      h.channel.invalidate(h.channel.currentGeneration());
      expect(readIndicator().label).toBe("Reconnecting");
      setCurrentSessionRunning(false);
      return { ...h, starts, reloads: () => reloads };
    }

    afterEach(() => {
      setCurrentSessionRunning(null);
      installLiveChannelForTests(null);
      installManualRecoveryForTests(null);
      installHubNavigationForTests(null);
      globalThis.fetch = savedFetch;
      navigations.length = 0;
    });

    test("the display state is the channel's, except that a stopped session outranks every state but live", () => {
      expect(connectionDisplayState("reconnecting", true)).toBe("stopped");
      expect(connectionDisplayState("connecting", true)).toBe("stopped");
      expect(connectionDisplayState("live", true)).toBe("live");
      expect(connectionDisplayState("reconnecting", false)).toBe("reconnecting");
      expect(connectionDisplayState("connecting", false)).toBe("connecting");
    });

    test("reads Stopped, names the start action, and does not pulse; clears when the hub says running again", () => {
      const h = stoppedHarness({ status: 200, body: {} });
      expect(readIndicator()).toMatchObject({
        label: "Stopped",
        title: "The workspace session is stopped",
        stopped: true,
        reconnecting: false,
        live: false,
      });
      expect(indicator.getAttribute("aria-label")).toBe("Start the workspace session");
      expect(indicator.getAttribute("aria-disabled")).toBe("false");

      // Started from elsewhere: the flag clears and the channel's own word
      // is back until state is applied.
      setCurrentSessionRunning(true);
      expect(readIndicator()).toMatchObject({ label: "Reconnecting", stopped: false, reconnecting: true });
      expect(indicator.getAttribute("aria-label")).toBe("Reconnect to the uatu backend");
      h.channel.confirm(h.channel.currentGeneration());
      expect(readIndicator()).toMatchObject({ label: "Connected", live: true });
    });

    test("a confirmed-live channel outranks a stale stopped flag", () => {
      const h = stoppedHarness({ status: 200, body: {} });
      h.channel.confirm(h.channel.currentGeneration());
      expect(readIndicator()).toMatchObject({ label: "Connected", live: true, stopped: false });
    });

    test("activation starts the session instead of reconnecting, shows the attempt, and settles on live", async () => {
      const h = stoppedHarness({ status: 200, body: { id: "uatu", running: true } });
      const before = h.sources.length;

      click();
      expect(h.starts).toEqual(["/api/hub/sessions/uatu/start"]);
      // No superseding connect: a reconnect is not what was asked for.
      expect(h.sources.length).toBe(before);
      expect(indicator.getAttribute("aria-busy")).toBe("true");
      expect(indicator.classList.contains("is-attempting")).toBe(true);
      expect(readIndicator().label).toBe("Stopped");

      // A second tap while the start is in flight is refused.
      click();
      await settled();
      expect(h.starts).toHaveLength(1);
      expect(indicator.classList.contains("is-attempting")).toBe(true);

      // The hub's stream reports the session running, then state lands.
      setCurrentSessionRunning(true);
      h.channel.confirm(h.channel.currentGeneration());
      await settled();
      expect(readIndicator()).toMatchObject({ label: "Connected", live: true });
      expect(indicator.hasAttribute("aria-busy")).toBe(false);
      expect(indicator.classList.contains("is-attempting")).toBe(false);
      expect(h.reloads()).toBe(0);
      expect(errorLine.hidden).toBe(true);
    });

    test("a start the channel confirms before the hub answers settles at once", async () => {
      // The hub's answer is held; the started child's state lands first.
      let answer!: () => void;
      const held = new Promise<void>(resolve => { answer = resolve; });
      const h = stoppedHarness({ status: 200, body: { id: "uatu", running: true } });
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.endsWith("/start")) {
          h.starts.push(url);
          await held;
          return Response.json({ id: "uatu", running: true });
        }
        return new Response("{}");
      }) as unknown as typeof fetch;

      click();
      expect(indicator.classList.contains("is-attempting")).toBe(true);
      setCurrentSessionRunning(true);
      h.channel.confirm(h.channel.currentGeneration());
      expect(readIndicator().label).toBe("Connected");
      // Still waiting on the hub's answer, so still an attempt.
      await settled();
      expect(indicator.classList.contains("is-attempting")).toBe(true);

      answer();
      await settled();
      await settled();
      expect(indicator.classList.contains("is-attempting")).toBe(false);
      expect(indicator.hasAttribute("aria-busy")).toBe(false);
      expect(h.reloads()).toBe(0);
    });

    test("an accepted start that never confirms live drops the attempt after the window, without a reload", async () => {
      const h = stoppedHarness({ status: 200, body: { id: "uatu", running: true } });
      click();
      await settled();
      expect(indicator.classList.contains("is-attempting")).toBe(true);
      // The child did start: the hub says running, but no state arrives.
      setCurrentSessionRunning(true);
      expect(readIndicator().label).toBe("Reconnecting");

      h.fireReconnect();
      await settled();
      expect(indicator.classList.contains("is-attempting")).toBe(false);
      expect(indicator.hasAttribute("aria-busy")).toBe(false);
      expect(readIndicator().label).toBe("Reconnecting");
      expect(indicator.getAttribute("aria-label")).toBe("Reconnect to the uatu backend");
      expect(h.reloads()).toBe(0);
    });

    test("a refused start shows the hub's message under the indicator and stays actionable", async () => {
      const h = stoppedHarness({ status: 409, body: { error: "a folder mutation is pending; try again shortly" } });
      click();
      await settled();
      expect(errorLine.hidden).toBe(false);
      expect(errorLine.textContent).toBe("a folder mutation is pending; try again shortly");
      expect(readIndicator().label).toBe("Stopped");
      expect(indicator.getAttribute("aria-disabled")).toBe("false");
      expect(indicator.classList.contains("is-attempting")).toBe(false);
      expect(navigations).toEqual([]);

      // Trying again clears the old message first.
      click();
      expect(errorLine.hidden).toBe(true);
      await settled();
      expect(h.starts).toHaveLength(2);
      expect(errorLine.hidden).toBe(false);

      // Recovery from any path clears it for good.
      setCurrentSessionRunning(true);
      h.channel.confirm(h.channel.currentGeneration());
      expect(errorLine.hidden).toBe(true);
    });

    test("a locked-credential refusal hands off to the dashboard rather than showing an error", async () => {
      stoppedHarness({ status: 500, body: { error: "the assigned OpenPGP credential is locked; unlock it before starting the workspace" } });
      click();
      await settled();
      expect(navigations).toEqual(["/"]);
      expect(errorLine.hidden).toBe(true);
    });

    test("a network failure is reported like a refusal", async () => {
      stoppedHarness("network");
      click();
      await settled();
      expect(errorLine.hidden).toBe(false);
      expect(errorLine.textContent).toBe("start failed");
      expect(readIndicator().label).toBe("Stopped");
    });
  });

  afterAll(() => {
    for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
  });
}
