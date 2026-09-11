import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { resetAppBasePathForTests } from "../shared/app-url";
import { createLiveChannel, type LiveChannel, type LiveChannelStatus } from "./live-channel";
import { disposeLiveChannel, installLiveChannelForTests, watchPageLifecycle } from "./live";
import {
  applyWorkspaceActivity,
  chipLabel,
  chipDotClass,
  initHubNav,
  parseHubState,
  sortHubWorkspaces,
  startFailureNeedsHubUnlock,
  submitHubSignOut,
  switcherBadge,
  switcherBadgeLabel,
  workspaceIdFromBasePath,
  workspaceMenuDetail,
  workspaceMenuLabel,
  workspaceMenuState,
} from "./hub-nav";

function summary(id: string, running: boolean, displayName = id, path = "/src/" + id) {
  return { id, displayName, path, running };
}

describe("workspaceIdFromBasePath", () => {
  test("extracts the id from a hub-shaped base path", () => {
    expect(workspaceIdFromBasePath("/s/uatu/")).toBe("uatu");
    expect(workspaceIdFromBasePath("/s/my-project-2/")).toBe("my-project-2");
    expect(workspaceIdFromBasePath("/s/sp%20ace/")).toBe("sp ace");
  });

  test("returns null for the default and non-hub-shaped prefixes", () => {
    expect(workspaceIdFromBasePath("/")).toBeNull();
    expect(workspaceIdFromBasePath("/docs/")).toBeNull();
    expect(workspaceIdFromBasePath("/s/")).toBeNull();
    expect(workspaceIdFromBasePath("/s/a/b/")).toBeNull();
    expect(workspaceIdFromBasePath("/s/%GG/")).toBeNull();
  });
});

describe("sortHubWorkspaces", () => {
  test("orders current first, then running, then stopped, alphabetically within groups", () => {
    const sorted = sortHubWorkspaces(
      [
        summary("zeta", false),
        summary("beta", true),
        summary("alpha", false),
        summary("uatu", true),
        summary("gamma", true),
      ],
      "uatu",
    );
    expect(sorted.map(workspace => workspace.id)).toEqual(["uatu", "beta", "gamma", "alpha", "zeta"]);
  });

  test("does not mutate the input", () => {
    const input = [
      summary("b", false),
      summary("a", true),
    ];
    sortHubWorkspaces(input, null);
    expect(input.map(workspace => workspace.id)).toEqual(["b", "a"]);
  });
});

describe("chipDotClass", () => {
  test("live only when the hub reports the current session running", () => {
    expect(chipDotClass([summary("uatu", true)], "uatu")).toBe("indicator-dot is-live");
    expect(chipDotClass([summary("uatu", false)], "uatu")).toBe("indicator-dot");
  });

  test("unknown or absent workspaces read as not running", () => {
    expect(chipDotClass([], "uatu")).toBe("indicator-dot");
    expect(chipDotClass([summary("other", true)], "uatu")).toBe("indicator-dot");
    expect(chipDotClass([summary("uatu", true)], null)).toBe("indicator-dot");
  });
});

describe("chipLabel", () => {
  test("uses the latest display name and falls back to the stable id", () => {
    expect(chipLabel([summary("uatu", true, "Uatu Docs")], "uatu")).toBe("Uatu Docs");
    expect(chipLabel([summary("other", true)], "uatu")).toBe("uatu");
  });
});

describe("parseHubState", () => {
  test("extracts well-formed workspace entries with display names and paths", () => {
    const state = parseHubState({
      workspaces: [
        { id: "uatu", displayName: "Uatu Docs", path: "/src/uatu", running: true },
        { id: "junk" },
      ],
    });
    expect(state).toEqual({ workspaces: [{ id: "uatu", displayName: "Uatu Docs", path: "/src/uatu", running: true }] });
  });

  test("pre-display-name hubs fall back to the id as the label", () => {
    const state = parseHubState({ workspaces: [{ id: "uatu", running: false }] });
    expect(state).toEqual({ workspaces: [{ id: "uatu", displayName: "uatu", path: "", running: false }] });
  });

  test("rejects non-hub payloads", () => {
    expect(parseHubState({ workspaces: [] })).toEqual({ workspaces: [] });
    expect(parseHubState({})).toBeNull();
    expect(parseHubState(null)).toBeNull();
  });
});

describe("workspace menu labels", () => {
  test("labels by display name and sorts by it within groups", () => {
    const workspaces = [
      summary("payments-service", false, "Payments API"),
      summary("api", false, "Billing"),
    ];
    expect(workspaceMenuLabel(workspaces[0]!)).toBe("Payments API");
    expect(sortHubWorkspaces(workspaces, null).map(workspace => workspace.id)).toEqual(["api", "payments-service"]);
  });

  test("duplicate display names get path detail; unique names get none", () => {
    const duplicates = [
      summary("api", true, "API", "/home/a/api"),
      summary("api-2", false, "API", "/home/b/api"),
      summary("docs", false, "Docs"),
    ];
    expect(workspaceMenuDetail(duplicates, duplicates[0]!)).toBe("/home/a/api");
    expect(workspaceMenuDetail(duplicates, duplicates[1]!)).toBe("/home/b/api");
    expect(workspaceMenuDetail(duplicates, duplicates[2]!)).toBeNull();
  });

  test("a duplicate without a path falls back to the stable id", () => {
    const duplicates = [
      summary("api", true, "API", ""),
      summary("api-2", false, "API", ""),
    ];
    expect(workspaceMenuDetail(duplicates, duplicates[1]!)).toBe("api-2");
  });
});

describe("startFailureNeedsHubUnlock", () => {
  test("locked-credential rejections route to the dashboard's unlock flow", () => {
    // The exact server messages from credential-context resolution.
    expect(startFailureNeedsHubUnlock("an assigned SSH credential is locked; unlock it before starting the workspace")).toBe(true);
    expect(startFailureNeedsHubUnlock("the assigned OpenPGP credential is locked; unlock it before starting the workspace")).toBe(true);
  });

  test("other failures stay inline in the switcher", () => {
    expect(startFailureNeedsHubUnlock("session for 'repo' failed to start: child exited (code 1)")).toBe(false);
    expect(startFailureNeedsHubUnlock("")).toBe(false);
  });
});

describe("submitHubSignOut", () => {
  // A minimal stand-in for the pieces of Document this touches; the unit
  // suite runs without a DOM.
  function fakeDocument() {
    const form: Record<string, unknown> & { submitted: boolean } = { submitted: false };
    form.submit = () => {
      form.submitted = true;
    };
    const appended: unknown[] = [];
    const doc = {
      createElement: (tag: string) => {
        form.tag = tag;
        return form;
      },
      body: { appendChild: (node: unknown) => appended.push(node) },
    };
    return { doc: doc as unknown as Document, form, appended };
  }

  test("posts a form to the hub's origin-rooted logout route", () => {
    const { doc, form } = fakeDocument();
    submitHubSignOut(doc);
    expect(form.tag).toBe("form");
    expect(form.method).toBe("post");
    // Origin-rooted on purpose: a session lives under /s/<id>/ but the hub's
    // logout route is at the origin root.
    expect(form.action).toBe("/logout");
  });

  test("submits a hidden form attached to the document", () => {
    const { doc, form, appended } = fakeDocument();
    submitHubSignOut(doc);
    // A detached form does not submit, and a visible one would flash.
    expect(form.hidden).toBe(true);
    expect(appended).toEqual([form]);
    expect(form.submitted).toBe(true);
  });
});

describe("switcher activity", () => {
  const facts = (running: boolean, working = false, awaiting = false) => ({ running, working, awaiting });

  test("a question in another workspace badges the chip; agents merely working are a quieter note; the current workspace never counts", () => {
    const list = [summary("uatu", true), summary("two", true), summary("three", true)];
    const activity = new Map([
      ["uatu", facts(true, true, true)],
      ["two", facts(true, true, false)],
      ["three", facts(true, false, false)],
    ]);
    expect(switcherBadge(list, activity, "uatu")).toEqual({ kind: "working", count: 1 });
    activity.set("three", facts(true, true, true));
    expect(switcherBadge(list, activity, "uatu")).toEqual({ kind: "awaiting", count: 1 });
    // Answered from any device: the badge clears back to the quieter note.
    activity.set("three", facts(true, true, false));
    expect(switcherBadge(list, activity, "uatu")).toEqual({ kind: "working", count: 2 });
    activity.set("two", facts(true, false, false));
    activity.set("three", facts(false, true, true));
    expect(switcherBadge(list, activity, "uatu")).toBeNull();
  });

  test("activity for a workspace the hub list no longer has never counts toward the badge", () => {
    // Facts left over from before the workspace was forgotten: the stream
    // never says so, and a reopened stream simply omits it.
    const activity = new Map([
      ["gone", facts(true, true, true)],
      ["two", facts(true, true, false)],
    ]);
    expect(switcherBadge([summary("uatu", true), summary("two", true)], activity, "uatu")).toEqual({ kind: "working", count: 1 });
    expect(switcherBadge([summary("uatu", true)], activity, "uatu")).toBeNull();
    expect(switcherBadge([], activity, "uatu")).toBeNull();
  });

  test("the badge is spoken, never colour alone", () => {
    expect(switcherBadgeLabel({ kind: "awaiting", count: 1 })).toBe("1 workspace awaiting your reply");
    expect(switcherBadgeLabel({ kind: "awaiting", count: 2 })).toBe("2 workspaces awaiting your reply");
    expect(switcherBadgeLabel({ kind: "working", count: 1 })).toBe("Agents working in 1 workspace");
    expect(switcherBadgeLabel(null)).toBe("");
  });

  test("menu entries name stopped, awaiting, and working; idle running entries stay quiet", () => {
    const activity = new Map([["a", facts(true, true, true)], ["b", facts(true, true, false)], ["c", facts(true)]]);
    expect(workspaceMenuState(summary("a", true), activity)).toEqual({ text: "awaiting you", tone: "awaiting" });
    expect(workspaceMenuState(summary("b", true), activity)).toEqual({ text: "working", tone: "working" });
    expect(workspaceMenuState(summary("c", true), activity)).toBeNull();
    expect(workspaceMenuState(summary("d", true), activity)).toBeNull();
    expect(workspaceMenuState(summary("a", false), activity)).toEqual({ text: "stopped", tone: "stopped" });
  });

  test("an activity update folds its running fact into the hub list without touching other entries", () => {
    const list = [summary("uatu", true), summary("two", false)];
    const updated = applyWorkspaceActivity(list, "two", facts(true, true, false));
    expect(updated.map(workspace => workspace.running)).toEqual([true, true]);
    expect(updated[0]).toBe(list[0]);
    expect(applyWorkspaceActivity(list, "unknown", facts(true))).toEqual(list);
  });
});

describe("initHubNav with the live activity topic", () => {
  const savedGlobals = new Map<string, unknown>();
  const setGlobal = (key: string, value: unknown) => {
    if (!savedGlobals.has(key)) savedGlobals.set(key, Reflect.get(globalThis, key));
    Reflect.set(globalThis, key, value);
  };

  afterEach(() => {
    disposeLiveChannel();
    installLiveChannelForTests(null);
    for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
    savedGlobals.clear();
    resetAppBasePathForTests();
  });

  test("a question elsewhere badges the chip and names the workspace in the open menu; answering clears it", async () => {
    const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
    const { document, window } = parseHTML(html);
    const meta = document.createElement("meta");
    meta.setAttribute("name", "uatu-base-path");
    meta.setAttribute("content", "/s/uatu/");
    document.head.appendChild(meta);
    setGlobal("document", document);
    setGlobal("window", window);
    setGlobal("Node", (window as unknown as Record<string, unknown>).Node);
    resetAppBasePathForTests();

    let stateFetches = 0;
    const workspaces: unknown[] = [
      { id: "uatu", displayName: "Uatu", path: "/src/uatu", running: true },
      { id: "two", displayName: "Payments", path: "/src/two", running: true },
    ];
    setGlobal("fetch", async (url: string) => {
      if (url === "/api/hub/state") {
        stateFetches += 1;
        return Response.json({ workspaces });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    });
    let deliver: ((ws: string, activity: { running: boolean; working: boolean; awaiting: boolean }) => void) | null = null;
    installLiveChannelForTests({
      onActivity(listener: typeof deliver) { deliver = listener; return () => {}; },
      onStreamOpened() { return () => {}; },
      dispose() {},
    } as unknown as LiveChannel);

    initHubNav();
    const control = document.querySelector<HTMLElement>("#hub-control")!;
    const toggle = document.querySelector<HTMLButtonElement>("#hub-toggle")!;
    const badge = document.querySelector<HTMLElement>("#hub-activity-badge")!;
    const menu = document.querySelector<HTMLElement>("#hub-menu")!;
    for (let attempt = 0; attempt < 100 && control.hidden; attempt += 1) await Bun.sleep(1);
    expect(control.hidden).toBe(false);
    expect(badge.hidden).toBe(true);
    expect(deliver).not.toBeNull();

    // An agent in Payments asks the user a question.
    deliver!("two", { running: true, working: true, awaiting: true });
    expect(badge.hidden).toBe(false);
    expect(badge.className).toBe("hub-activity-badge is-awaiting");
    expect(badge.textContent).toBe("1");
    expect(toggle.getAttribute("aria-label")).toContain("1 workspace awaiting your reply");
    expect(toggle.title).toContain("1 workspace awaiting your reply");

    // The open menu names it, and keeps up without being reopened.
    toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(menu.hidden).toBe(false);
    const entryState = () => [...menu.querySelectorAll<HTMLElement>(".hub-menu-item")]
      .find(item => item.textContent?.includes("Payments"))
      ?.querySelector<HTMLElement>(".hub-menu-state")?.textContent ?? null;
    expect(entryState()).toBe("awaiting you");
    // No conversation content or title reaches the menu.
    expect(menu.textContent).not.toContain("question");

    // Answered from another device: the badge falls back to the quieter
    // working note, then clears once the agent goes idle.
    deliver!("two", { running: true, working: true, awaiting: false });
    expect(badge.className).toBe("hub-activity-badge is-working");
    expect(badge.textContent).toBe("");
    expect(toggle.getAttribute("aria-label")).toContain("Agents working in 1 workspace");
    expect(entryState()).toBe("working");
    deliver!("two", { running: true, working: false, awaiting: false });
    expect(badge.hidden).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe("Switch workspace or open the hub dashboard");
    expect(entryState()).toBeNull();

    // The current workspace stopping elsewhere turns the chip's dot off.
    const chipDot = toggle.querySelector<HTMLElement>(".indicator-dot")!;
    expect(chipDot.className).toBe("indicator-dot is-live");
    deliver!("uatu", { running: false, working: false, awaiting: false });
    expect(chipDot.className).toBe("indicator-dot");

    // A workspace the list does not know yet: the list is refetched, and the
    // activity kept meanwhile badges the chip as soon as the entry exists.
    const fetchesBefore = stateFetches;
    workspaces.push({ id: "three", displayName: "New", path: "/src/three", running: true });
    deliver!("three", { running: true, working: false, awaiting: true });
    for (let attempt = 0; attempt < 100 && badge.hidden; attempt += 1) await Bun.sleep(1);
    expect(stateFetches).toBe(fetchesBefore + 1);
    expect(badge.className).toBe("hub-activity-badge is-awaiting");
    expect(badge.textContent).toBe("1");
  });

  type Facts = { running: boolean; working: boolean; awaiting: boolean };
  type Workspace = { id: string; displayName: string; path: string; running: boolean };
  type FakeStream = {
    closed: boolean;
    hello(streamId: string): void;
    activity(ws: string, facts: Facts): void;
    documentState(): void;
    documentUnavailable(): void;
    fail(): void;
    addEventListener(type: string, listener: (event: Event) => void): void;
    close(): void;
  };
  const idle: Facts = { running: true, working: false, awaiting: false };
  const working: Facts = { running: true, working: true, awaiting: false };
  const awaiting: Facts = { running: true, working: true, awaiting: true };
  const stopped: Facts = { running: false, working: false, awaiting: false };
  const workspace = (id: string, displayName: string, running = true): Workspace =>
    ({ id, displayName, path: `/src/${id}`, running });
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await Bun.sleep(1);
  };
  const settle = () => Bun.sleep(5);

  // A session page at /s/uatu/ on a hub, holding the page's real live channel
  // over fake streams and timers. Its document consumer does what
  // shell/events.ts does: state or `ready` confirms the generation, and
  // `unavailable` invalidates it.
  async function mountHubPage(initial: Workspace[]) {
    const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
    const { document, window } = parseHTML(html);
    const meta = document.createElement("meta");
    meta.setAttribute("name", "uatu-base-path");
    meta.setAttribute("content", "/s/uatu/");
    document.head.appendChild(meta);
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
    setGlobal("document", document);
    setGlobal("window", window);
    setGlobal("Node", (window as unknown as Record<string, unknown>).Node);
    resetAppBasePathForTests();

    // The hub answers with its list as it is when asked. While answers are
    // held, each waits for its own release, in request order.
    const hub = { workspaces: initial, stateFetches: 0 };
    const held: (() => void)[] = [];
    let holding = false;
    setGlobal("fetch", async (url: string) => {
      if (url !== "/api/hub/state") return Response.json({ error: "unexpected" }, { status: 404 });
      hub.stateFetches += 1;
      const answer = Response.json({ workspaces: hub.workspaces });
      if (holding) await new Promise<void>(resolve => { held.push(resolve); });
      return answer;
    });

    let cursor = 0;
    const sources: FakeStream[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const channel = createLiveChannel({
      ws: "uatu",
      activity: true,
      fetcher: async () => Response.json({ ok: true }),
      timers: {
        setTimeout(callback) {
          const id = nextTimer++;
          timers.set(id, callback);
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout(timer) { timers.delete(timer as unknown as number); },
      },
      openSource: () => {
        const listeners = new Map<string, (event: Event) => void>();
        const emit = (type: string, data?: unknown) =>
          listeners.get(type)?.({ type, data: data === undefined ? undefined : JSON.stringify(data) } as unknown as Event);
        const document = (event: unknown) =>
          emit("live", { ws: "uatu", topic: "document", key: "scope=folder", cursor: `d${++cursor}`, event });
        const stream: FakeStream = {
          closed: false,
          hello: streamId => emit("hello", { streamId }),
          activity: (ws, facts) => emit("live", { ws, topic: "activity", cursor: `a${++cursor}`, event: { kind: "data", data: facts } }),
          documentState: () => document({ kind: "data", data: {} }),
          documentUnavailable: () => document({ kind: "unavailable" }),
          fail: () => emit("error"),
          addEventListener(type, listener) { listeners.set(type, listener); },
          close() { stream.closed = true; },
        };
        sources.push(stream);
        return stream;
      },
    });
    const statuses: LiveChannelStatus[] = [];
    channel.onStatus(status => statuses.push(status));
    channel.subscribe({ topic: "document", key: "scope=folder" }, {
      data: (_data, _cursor, generation) => channel.confirm(generation),
      ready: generation => channel.confirm(generation),
      unavailable: generation => channel.invalidate(generation),
    });
    installLiveChannelForTests(channel);

    const control = document.querySelector<HTMLElement>("#hub-control")!;
    const toggle = document.querySelector<HTMLButtonElement>("#hub-toggle")!;
    const badge = document.querySelector<HTMLElement>("#hub-activity-badge")!;
    const menu = document.querySelector<HTMLElement>("#hub-menu")!;
    const setVisibility = (next: "visible" | "hidden") => {
      visibility = next;
      document.dispatchEvent(new window.Event("visibilitychange"));
    };
    return {
      hub,
      sources,
      statuses,
      badge,
      toggle,
      menu,
      latest: () => sources.at(-1)!,
      hold() { holding = true; },
      heldAnswers: () => held.length,
      release: (index: number) => held[index]!(),
      runPendingTimer() {
        const [id, run] = [...timers][0]!;
        timers.delete(id);
        run();
      },
      hide: () => setVisibility("hidden"),
      show: () => setVisibility("visible"),
      // The menu as it renders the moment it opens, before the refresh that
      // opening starts has answered: what the page already believed.
      openMenu() {
        toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
        expect(menu.hidden).toBe(false);
        return [...menu.querySelectorAll<HTMLAnchorElement>(".hub-menu-item")];
      },
      // Boot as the app does: the stream opens, the lifecycle watch is
      // installed, and the switcher probes. Then the stream says hello, the
      // document state lands, and the hub sends its activity snapshot.
      async boot(snapshot: [string, Facts][]) {
        channel.connect();
        watchPageLifecycle();
        initHubNav();
        await waitFor(() => !control.hidden);
        expect(control.hidden).toBe(false);
        sources[0]!.hello("stream-boot");
        sources[0]!.documentState();
        for (const [ws, facts] of snapshot) sources[0]!.activity(ws, facts);
      },
    };
  }
  const hrefs = (items: HTMLAnchorElement[]) => items.map(item => item.getAttribute("href"));

  test("a workspace forgotten while the page was hidden leaves no badge and no menu entry, though the stopped current workspace never lets the stream count as live", async () => {
    const page = await mountHubPage([workspace("uatu", "Uatu"), workspace("two", "Payments"), workspace("scratch", "Scratch")]);
    // An agent in Scratch is waiting on the user.
    await page.boot([["uatu", idle], ["two", idle], ["scratch", awaiting]]);
    expect(page.badge.hidden).toBe(false);
    expect(page.badge.className).toBe("hub-activity-badge is-awaiting");

    // The page goes to the background and releases its stream. Meanwhile,
    // from another device, this workspace is stopped, and Scratch is stopped
    // and forgotten.
    page.hide();
    expect(page.sources[0]!.closed).toBe(true);
    page.hub.workspaces = [workspace("uatu", "Uatu", false), workspace("two", "Payments")];

    // Shown again: a replacement stream opens. Nothing is asked of the hub
    // before it says hello.
    const fetchesBefore = page.hub.stateFetches;
    const statusesBefore = page.statuses.length;
    page.show();
    expect(page.sources).toHaveLength(2);
    await settle();
    expect(page.hub.stateFetches).toBe(fetchesBefore);

    // It says hello, its snapshot no longer mentions Scratch, and the stopped
    // workspace's document topic is unavailable.
    const replacement = page.latest();
    replacement.hello("stream-shown");
    replacement.activity("uatu", stopped);
    replacement.activity("two", idle);
    replacement.documentUnavailable();

    await waitFor(() => page.badge.hidden === true);
    // The stream never counted as live.
    expect(page.statuses.slice(statusesBefore)).toEqual(["reconnecting"]);
    expect(page.hub.stateFetches).toBe(fetchesBefore + 1);
    expect(page.badge.hidden).toBe(true);
    expect(page.toggle.getAttribute("aria-label")).toBe("Switch workspace or open the hub dashboard");
    const entries = hrefs(page.openMenu());
    expect(entries).toContain("/s/two/");
    expect(entries).not.toContain("/s/scratch/");
    expect(page.menu.textContent).not.toContain("Scratch");
    expect(page.menu.textContent).not.toContain("awaiting you");
  });

  for (const [interruption, failedAttempts] of [["a dropped connection", 0], ["a hub restart", 2]] as const) {
    test(`after ${interruption}, the list is read once, when the replacement stream says hello`, async () => {
      const page = await mountHubPage([workspace("uatu", "Uatu"), workspace("two", "Payments"), workspace("scratch", "Scratch")]);
      await page.boot([["uatu", idle], ["two", idle], ["scratch", awaiting]]);
      expect(page.badge.hidden).toBe(false);
      const fetchesBefore = page.hub.stateFetches;

      // The stream is lost; Scratch is forgotten before one is back. While
      // the hub restarts, the first reconnect attempts fail before hello.
      page.sources[0]!.fail();
      page.hub.workspaces = [workspace("uatu", "Uatu"), workspace("two", "Payments")];
      page.runPendingTimer();
      for (let attempt = 0; attempt < failedAttempts; attempt += 1) {
        page.latest().fail();
        page.runPendingTimer();
      }
      expect(page.sources).toHaveLength(2 + failedAttempts);
      await settle();
      expect(page.hub.stateFetches).toBe(fetchesBefore);

      page.latest().hello("stream-back");
      page.latest().activity("uatu", idle);
      page.latest().activity("two", idle);
      await waitFor(() => page.badge.hidden === true);
      expect(page.hub.stateFetches).toBe(fetchesBefore + 1);
      expect(page.badge.hidden).toBe(true);
      expect(hrefs(page.openMenu())).not.toContain("/s/scratch/");

      // The document confirming the stream live asks nothing more.
      const fetchesAtOpen = page.hub.stateFetches;
      page.latest().documentState();
      expect(page.statuses.at(-1)).toBe("live");
      await settle();
      expect(page.hub.stateFetches).toBe(fetchesAtOpen);
    });
  }

  for (const order of ["after", "before"] as const) {
    test(`the reconnect list answer landing ${order} the new stream's activity drops the forgotten workspace and keeps what the stream reported since`, async () => {
      const page = await mountHubPage([workspace("uatu", "Uatu"), workspace("two", "Payments"), workspace("scratch", "Scratch")]);
      await page.boot([["uatu", idle], ["two", idle], ["scratch", awaiting]]);
      page.hide();
      page.hub.workspaces = [workspace("uatu", "Uatu", false), workspace("two", "Payments")];
      page.hold();
      page.show();

      // Hello: the reconnect's request goes out, and its answer is the list
      // as it is at this moment.
      const replacement = page.latest();
      replacement.hello("stream-shown");
      expect(page.heldAnswers()).toBe(1);
      if (order === "before") {
        page.release(0);
        await settle();
        expect(page.badge.hidden).toBe(true);
      }

      // The stream reports: the snapshot, then a workspace registered after
      // that request, whose agent at once asks a question. Scratch is
      // registered again too, and not started.
      page.hub.workspaces = [
        workspace("uatu", "Uatu", false),
        workspace("two", "Payments"),
        workspace("three", "New"),
        workspace("scratch", "Scratch", false),
      ];
      replacement.activity("uatu", stopped);
      replacement.activity("two", working);
      replacement.activity("three", awaiting);
      // "three" is not in the list the page holds, so the list is read again.
      expect(page.heldAnswers()).toBe(2);
      if (order === "after") {
        // The reconnect's answer lands only now. It does not list "three",
        // whose report is newer than the answer and is kept; Scratch's old
        // question, reported before the request, is dropped.
        page.release(0);
        await settle();
        expect(page.badge.className).toBe("hub-activity-badge is-working");
      }

      page.release(1);
      await waitFor(() => page.badge.className === "hub-activity-badge is-awaiting");
      // Only New's question counts: Scratch, listed again but not started,
      // carries nothing of its old one.
      expect(page.badge.className).toBe("hub-activity-badge is-awaiting");
      expect(page.badge.textContent).toBe("1");
      const items = page.openMenu();
      expect(hrefs(items)).toContain("/s/three/");
      const scratch = items.find(item => item.getAttribute("href") === "/s/scratch/");
      expect(scratch?.querySelector(".hub-menu-state")?.textContent).toBe("stopped");
    });
  }

  test("the page's first stream saying hello asks the hub for nothing beyond the boot probe", async () => {
    const page = await mountHubPage([workspace("uatu", "Uatu"), workspace("two", "Payments")]);
    await page.boot([["uatu", idle], ["two", working]]);
    await settle();
    expect(page.hub.stateFetches).toBe(1);
    expect(page.statuses).toEqual(["live"]);
    expect(page.badge.className).toBe("hub-activity-badge is-working");
  });

  test("an older list answer landing last does not bring back a workspace a newer one dropped", async () => {
    const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
    const { document, window } = parseHTML(html);
    const meta = document.createElement("meta");
    meta.setAttribute("name", "uatu-base-path");
    meta.setAttribute("content", "/s/uatu/");
    document.head.appendChild(meta);
    setGlobal("document", document);
    setGlobal("window", window);
    setGlobal("Node", (window as unknown as Record<string, unknown>).Node);
    resetAppBasePathForTests();

    let workspaces = [
      { id: "uatu", displayName: "Uatu", path: "/src/uatu", running: true },
      { id: "scratch", displayName: "Scratch", path: "/src/scratch", running: true },
    ];
    let hold: Promise<void> | null = null;
    setGlobal("fetch", async (url: string) => {
      if (url !== "/api/hub/state") return Response.json({ error: "unexpected" }, { status: 404 });
      // The hub answers with the list as it is now; delivery may be held.
      const answer = Response.json({ workspaces });
      const gate = hold;
      hold = null;
      if (gate) await gate;
      return answer;
    });
    let deliver: ((ws: string, activity: { running: boolean; working: boolean; awaiting: boolean }) => void) | null = null;
    installLiveChannelForTests({
      onActivity(listener: typeof deliver) { deliver = listener; return () => {}; },
      onStreamOpened() { return () => {}; },
      dispose() {},
    } as unknown as LiveChannel);

    initHubNav();
    const control = document.querySelector<HTMLElement>("#hub-control")!;
    const toggle = document.querySelector<HTMLButtonElement>("#hub-toggle")!;
    const badge = document.querySelector<HTMLElement>("#hub-activity-badge")!;
    const menu = document.querySelector<HTMLElement>("#hub-menu")!;
    for (let attempt = 0; attempt < 100 && control.hidden; attempt += 1) await Bun.sleep(1);
    deliver!("scratch", { running: true, working: true, awaiting: true });
    expect(badge.hidden).toBe(false);

    // Opening the menu asks for the list; that answer is slow to arrive.
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const click = () => toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
    click();
    // Scratch is forgotten; reopening the menu asks again and hears at once.
    workspaces = workspaces.filter(workspace => workspace.id !== "scratch");
    click();
    click();
    for (let attempt = 0; attempt < 100 && !badge.hidden; attempt += 1) await Bun.sleep(1);
    expect(badge.hidden).toBe(true);
    const entries = () => [...menu.querySelectorAll<HTMLAnchorElement>(".hub-menu-item")].map(item => item.getAttribute("href"));
    expect(entries()).not.toContain("/s/scratch/");

    // The first, older answer finally lands.
    release();
    await Bun.sleep(5);
    expect(menu.hidden).toBe(false);
    expect(entries()).not.toContain("/s/scratch/");
    expect(badge.hidden).toBe(true);
  });

  test("activity the stream delivered before the hub probe answered still badges the chip", async () => {
    const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
    const { document, window } = parseHTML(html);
    const meta = document.createElement("meta");
    meta.setAttribute("name", "uatu-base-path");
    meta.setAttribute("content", "/s/uatu/");
    document.head.appendChild(meta);
    setGlobal("document", document);
    setGlobal("window", window);
    setGlobal("Node", (window as unknown as Record<string, unknown>).Node);
    resetAppBasePathForTests();

    // The hub probe is held until the stream has already sent its snapshot.
    let answerState!: () => void;
    const stateHeld = new Promise<void>(resolve => { answerState = resolve; });
    setGlobal("fetch", async (url: string) => {
      if (url === "/api/hub/state") {
        await stateHeld;
        return Response.json({ workspaces: [
          { id: "uatu", displayName: "Uatu", path: "/src/uatu", running: true },
          { id: "two", displayName: "Payments", path: "/src/two", running: true },
        ] });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    });
    let live: ((data: string) => void) | null = null;
    const channel = createLiveChannel({
      ws: "uatu",
      activity: true,
      fetcher: async () => Response.json({ ok: true }),
      openSource: () => ({
        addEventListener(type, listener) {
          if (type === "live") live = data => listener({ type, data } as unknown as Event);
        },
        close() {},
      }),
    });
    installLiveChannelForTests(channel);
    channel.connect();

    initHubNav();
    // The per-workspace snapshot the hub sends once, as the stream opens.
    live!(JSON.stringify({ ws: "two", topic: "activity", cursor: "a1", event: { kind: "data", data: { running: true, working: true, awaiting: true } } }));
    answerState();

    const control = document.querySelector<HTMLElement>("#hub-control")!;
    const badge = document.querySelector<HTMLElement>("#hub-activity-badge")!;
    for (let attempt = 0; attempt < 100 && control.hidden; attempt += 1) await Bun.sleep(1);
    expect(control.hidden).toBe(false);
    expect(badge.hidden).toBe(false);
    expect(badge.className).toBe("hub-activity-badge is-awaiting");
    expect(badge.textContent).toBe("1");
    channel.dispose();
  });
});
