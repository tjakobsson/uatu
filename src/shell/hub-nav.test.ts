import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { resetAppBasePathForTests } from "../shared/app-url";
import { createLiveChannel, type LiveChannel } from "./live-channel";
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
      onStatus() { return () => {}; },
      isRecovering() { return false; },
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

  test("a workspace forgotten while the page was hidden leaves no badge and no menu entry once the page is shown", async () => {
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

    let stateFetches = 0;
    let workspaces = [
      { id: "uatu", displayName: "Uatu", path: "/src/uatu", running: true },
      { id: "two", displayName: "Payments", path: "/src/two", running: true },
      { id: "scratch", displayName: "Scratch", path: "/src/scratch", running: true },
    ];
    setGlobal("fetch", async (url: string) => {
      if (url === "/api/hub/state") {
        stateFetches += 1;
        return Response.json({ workspaces });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    });
    const sources: { live: (data: string) => void; closed: boolean }[] = [];
    const channel = createLiveChannel({
      ws: "uatu",
      activity: true,
      fetcher: async () => Response.json({ ok: true }),
      openSource: () => {
        const listeners = new Map<string, (event: Event) => void>();
        const source = {
          closed: false,
          live: (data: string) => listeners.get("live")?.({ type: "live", data } as unknown as Event),
          addEventListener(type: string, listener: (event: Event) => void) { listeners.set(type, listener); },
          close() { source.closed = true; },
        };
        sources.push(source);
        return source;
      },
    });
    installLiveChannelForTests(channel);
    const activityFrame = (ws: string, cursor: string, facts: { running: boolean; working: boolean; awaiting: boolean }) =>
      JSON.stringify({ ws, topic: "activity", cursor, event: { kind: "data", data: facts } });
    // What shell/events.ts does once a generation's document state lands.
    const documentStateApplied = () => channel.confirm(channel.currentGeneration());

    // Boot: the stream opens, the lifecycle watch is installed, the switcher probes.
    channel.connect();
    watchPageLifecycle();
    initHubNav();
    documentStateApplied();
    const control = document.querySelector<HTMLElement>("#hub-control")!;
    const toggle = document.querySelector<HTMLButtonElement>("#hub-toggle")!;
    const badge = document.querySelector<HTMLElement>("#hub-activity-badge")!;
    const menu = document.querySelector<HTMLElement>("#hub-menu")!;
    for (let attempt = 0; attempt < 100 && control.hidden; attempt += 1) await Bun.sleep(1);
    expect(control.hidden).toBe(false);

    // An agent in Scratch is waiting on the user.
    sources[0]!.live(activityFrame("uatu", "a1", { running: true, working: false, awaiting: false }));
    sources[0]!.live(activityFrame("two", "a2", { running: true, working: false, awaiting: false }));
    sources[0]!.live(activityFrame("scratch", "a3", { running: true, working: true, awaiting: true }));
    expect(badge.hidden).toBe(false);
    expect(badge.className).toBe("hub-activity-badge is-awaiting");

    // The page goes to the background and releases its stream; meanwhile
    // Scratch is stopped and forgotten from another device.
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
    expect(sources[0]!.closed).toBe(true);
    workspaces = workspaces.filter(workspace => workspace.id !== "scratch");

    // Shown again: a fresh stream, whose snapshot no longer mentions Scratch.
    const fetchesBefore = stateFetches;
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
    expect(sources).toHaveLength(2);
    sources[1]!.live(activityFrame("uatu", "b1", { running: true, working: false, awaiting: false }));
    sources[1]!.live(activityFrame("two", "b2", { running: true, working: false, awaiting: false }));
    documentStateApplied();

    for (let attempt = 0; attempt < 100 && !badge.hidden; attempt += 1) await Bun.sleep(1);
    expect(stateFetches).toBeGreaterThan(fetchesBefore);
    expect(badge.hidden).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe("Switch workspace or open the hub dashboard");

    toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(menu.hidden).toBe(false);
    const entries = () => [...menu.querySelectorAll<HTMLAnchorElement>(".hub-menu-item")].map(item => item.getAttribute("href"));
    expect(entries()).toContain("/s/two/");
    expect(entries()).not.toContain("/s/scratch/");
    expect(menu.textContent).not.toContain("Scratch");
    expect(menu.textContent).not.toContain("awaiting you");
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
      onStatus() { return () => {}; },
      isRecovering() { return false; },
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
