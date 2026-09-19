// The client worktree dialog against a stubbed published JSON family.
//
// Everything the retired server-rendered flow used to prove with rendered
// fragments and redirects is proved here instead: which action a row state
// earns, which copy a view shows, what a refusal keeps, and which requests
// each transition makes. The Hub's own safety lives behind the API and is
// covered by src/hub/worktree-api.integration.test.ts; nothing here can
// bypass it, because every mutation is one of those bounded operations.

import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { bindWorktreeBranches, openWorktreeDialog, openWorktreeFork, worktreeProvenanceLabel, type WorktreeDialogOptions } from "./worktree-dialog";

const API = "/api/hub/worktrees";

type Json = Record<string, unknown>;
type Handler = (body: Json | undefined) => unknown;

const savedGlobals = new Map<string, unknown>();
function setGlobal(key: string, value: unknown): void {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Reflect.get(globalThis, key));
  Reflect.set(globalThis, key, value);
}

afterEach(() => {
  for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
  savedGlobals.clear();
});

const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(0); };

function checkout(overrides: Json = {}): Json {
  return {
    checkoutId: "checkout-child",
    repositoryId: "repo",
    workspaceId: "atlas-child",
    parentWorkspaceId: "atlas",
    path: "/w/atlas.worktrees/feature-a",
    branch: "feature/a",
    detached: false,
    main: false,
    ownership: "uatu",
    availability: "present",
    registered: true,
    running: false,
    locked: false,
    sourceRef: "main",
    ...overrides,
  };
}

function mainCheckout(overrides: Json = {}): Json {
  return checkout({
    checkoutId: "checkout-main",
    workspaceId: "atlas",
    parentWorkspaceId: undefined,
    path: "/w/atlas",
    branch: "main",
    main: true,
    ownership: "main",
    running: true,
    sourceRef: undefined,
    ...overrides,
  });
}

function inventory(checkouts: Json[], refs: { local?: string[]; remote?: string[] } = {}, overrides: Json = {}): Json {
  return {
    inventory: {
      repositoryId: "repo",
      sourceWorkspaceId: "atlas",
      status: "ready",
      checkouts,
      refs: { local: refs.local ?? ["main", "release"], remote: refs.remote ?? ["origin/release"], fetchedAt: null },
      ...overrides,
    },
  };
}

type Harness = ReturnType<typeof harness>;

function harness(routes: Record<string, Handler>, options: { pathname?: string } = {}) {
  const { document, window } = parseHTML("<html><body><button id=\"anchor\">anchor</button></body></html>");
  const createElement = document.createElement.bind(document);
  // linkedom has no <dialog> behavior; the modal contract this module relies
  // on is exactly showModal/close/cancel, so it is stubbed here and nowhere
  // in the product code.
  (document as unknown as { createElement: (tag: string) => Element }).createElement = (tag: string) => {
    const node = createElement(tag) as Element & { showModal?: () => void; close?: () => void };
    if (tag === "dialog") {
      node.showModal = () => node.setAttribute("open", "");
      node.close = () => {
        if (!node.hasAttribute("open")) return;
        node.removeAttribute("open");
        node.dispatchEvent(new window.Event("close"));
      };
    }
    return node;
  };
  const navigations: string[] = [];
  setGlobal("document", document);
  setGlobal("window", window);
  setGlobal("Node", (window as unknown as Record<string, unknown>).Node);
  // linkedom rejects a native Event on its own targets; the DOM the module
  // dispatches into must own the constructor too.
  setGlobal("Event", (window as unknown as Record<string, unknown>).Event);
  setGlobal("innerWidth", 1200);
  setGlobal("innerHeight", 900);
  setGlobal("location", {
    pathname: options.pathname ?? "/s/atlas/",
    href: `http://hub.test${options.pathname ?? "/s/atlas/"}`,
    assign: (url: string) => navigations.push(url),
  });
  const requests: { path: string; method: string; body?: Json }[] = [];
  setGlobal("fetch", async (url: string, init?: RequestInit) => {
    const raw = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Json;
    const path = raw.split("?")[0]!;
    const key = path === API ? "/" : path.slice(API.length);
    requests.push({ path: key, method, ...(body === undefined ? {} : { body }) });
    const handler = routes[key];
    if (!handler) throw new Error(`no stub for ${key}`);
    const value = await handler(body);
    return value instanceof Response ? value : Response.json(value as Json);
  });

  const anchor = document.querySelector<HTMLElement>("#anchor")!;
  const changed: string[] = [];
  window.addEventListener("uatu:worktrees-changed", () => changed.push("changed"));

  const shadow = () => (document.querySelector("dialog")?.firstElementChild as unknown as { shadowRoot: ParentNode } | null)?.shadowRoot ?? null;
  const main = () => shadow()!.querySelector("main")!;
  const text = () => main().textContent ?? "";
  const dialog = () => document.querySelector("dialog");
  // Every view is compact and carries exactly one <h2>, which focuses it and
  // labels the dialog: there is no dialog chrome any more.
  const heading = () => main().querySelector<HTMLElement>("h2")!;
  const button = (label: string) => [...main().querySelectorAll("button")]
    .find(candidate => (candidate.textContent ?? "").trim() === label) as (HTMLButtonElement | undefined);
  const click = (node: Element | null | undefined) => {
    expect(node).toBeTruthy();
    node!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  };
  const submit = () => main().querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  return { document, window, anchor, requests, navigations, changed, shadow, main, text, dialog, heading, button, click, submit, routes };
}

async function open(h: Harness, options: Partial<WorktreeDialogOptions> = {}): Promise<void> {
  openWorktreeDialog({ api: API, source: { id: "atlas", name: "Atlas" }, view: "discover", ...options } as WorktreeDialogOptions, h.anchor);
  await settle();
}

describe("response contract boundary", () => {
  for (const confirmation of [false, true]) {
    test(`Open refuses wrong-kind success (${confirmation ? "confirmation" : "dialog"})`, async () => {
      const success = { ok: true, operationId: "op", kind: "create", phase: "complete", checkout: checkout(), registered: true, started: false };
      const h = harness({
        "/": () => inventory([mainCheckout(), checkout()]),
        "/create": () => success,
        "/open": () => ({ ...success, started: true, checkout: checkout({ running: true }) }),
      });
      if (confirmation) {
        await open(h, { view: "create", mode: "new" });
        h.main().querySelector<HTMLInputElement>('[name="branch"]')!.value = "draft";
        h.submit();
        await settle();
        h.changed.length = 0;
        h.click(h.document.querySelector("[data-worktree-confirmation] button"));
      } else {
        await open(h, { view: "result", id: "atlas-child", error: true, message: "Retry Open." });
        h.submit();
      }
      await settle();
      const text = confirmation ? h.document.querySelector("[data-worktree-confirmation]")!.textContent : h.text();
      expect(text).toContain("Invalid worktree response.");
      expect(h.navigations).toEqual([]);
      expect(h.changed).toEqual([]);
    });
  }
  for (const operation of ["create", "register"] as const) {
    for (const invalid of [
      { kind: "delete", registered: false, started: false },
      { registered: true, started: false },
      { registered: false, started: false, checkout: checkout() },
      { registered: true, started: true, checkout: checkout({ running: false }) },
    ]) {
      test(`${operation} refuses endpoint-mismatched success ${JSON.stringify(invalid)}`, async () => {
        const h = harness({
          "/": () => inventory([mainCheckout(), checkout({ registered: false, workspaceId: undefined })]),
          [`/${operation}`]: () => ({ ok: true, operationId: "op", kind: operation, phase: "complete", ...invalid }),
        });
        await open(h, { view: operation, mode: "new", id: "checkout-child" });
        const input = h.main().querySelector<HTMLInputElement>('[name="branch"]');
        if (input) input.value = "kept-draft";
        h.submit();
        await settle();
        expect(h.dialog()).toBeTruthy();
        expect(h.text()).toContain("Invalid worktree response.");
        if (input) expect(input.value).toBe("kept-draft");
        expect(h.changed).toEqual([]);
        expect(h.navigations).toEqual([]);
      });
    }
  }
  test("domain rules do not import the dialog", async () => {
    expect(await Bun.file(new URL("../shared/worktree-branches.ts", import.meta.url)).text()).not.toContain('../shell/worktree-dialog');
  });
  test("malformed inventory is an error, not an empty repository", async () => {
    const h = harness({ "/": () => ({ inventory: {} }) });
    await open(h);
    expect(h.text()).toContain("Invalid worktree response.");
    expect(h.text()).not.toContain("Every worktree Git lists is registered.");
  });
  test("malformed operation result never commits", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), checkout()]), "/create": () => ({ ok: true }) });
    await open(h, { view: "create", mode: "new" });
    const input = h.main().querySelector<HTMLInputElement>('[name="branch"]')!;
    input.value = "draft";
    h.submit();
    await settle();
    expect(h.dialog()).toBeTruthy();
    expect(h.text()).toContain("Invalid worktree response.");
    expect(input.value).toBe("draft");
    expect(h.changed).toEqual([]);
  });
  test("malformed refs preserve the draft", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()]), "/fetch": () => ({ ok: true, refs: { local: [], remote: [] } }) });
    await open(h, { view: "create", mode: "new" });
    const input = h.main().querySelector<HTMLInputElement>('[name="branch"]')!;
    input.value = "kept-draft";
    const selection = h.main().querySelector<HTMLInputElement>('[name="selection"]')!.value;
    h.click(h.main().querySelector('[data-fetch]'));
    await settle();
    expect(h.text()).toContain("Invalid worktree response.");
    expect(input.value).toBe("kept-draft");
    expect(h.main().querySelector<HTMLInputElement>('[name="selection"]')!.value).toBe(selection);
    expect(h.requests.filter(request => request.path === "/fetch")).toEqual([
      { path: "/fetch", method: "POST", body: { sourceWorkspaceId: "atlas" } },
    ]);
  });
  test("malformed preflight cannot authorize deletion", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), checkout()]), "/preflight-delete": () => ({ ok: true, requiresStop: false }) });
    await open(h, { view: "delete", id: "atlas-child" });
    expect(h.text()).toContain("Invalid worktree response.");
    expect(h.button("Delete")).toBeUndefined();
  });
  test("malformed JSON has a clean error and no automatic retry", async () => {
    const h = harness({ "/": () => new Response("{ not-json") });
    await open(h);
    expect(h.text()).toContain("Invalid worktree response. Close and retry. Nothing was retried automatically.");
    expect(h.text()).not.toContain("not-json");
    expect(h.requests).toHaveLength(1);
  });
  test("closing during a response read discards the later parse failure", async () => {
    let reject!: (error: Error) => void;
    const response = new Response();
    response.json = () => new Promise((_resolve, fail) => { reject = fail; });
    const h = harness({ "/": () => response });
    await open(h);
    h.click(h.button("Cancel"));
    reject(new Error("raw parser error"));
    await settle();
    expect(h.dialog()).toBeNull();
    expect(h.changed).toEqual([]);
    expect(h.requests).toHaveLength(1);
  });
});

// The fork menu's third item. It lists ONLY what the picker and the
// dashboard cannot show — the checkouts Git lists for this repository that
// Uatu has not registered — so there is no general inventory view, no
// Refresh/Create toolbar, no main row and no registered rows.
describe("the register list (Register worktree…)", () => {
  const retained = () => checkout({
    checkoutId: "c-retained", workspaceId: undefined, registered: false,
    ownership: "uatu", branch: "feature/retained", sourceRef: "main",
  });
  const external = () => checkout({
    checkoutId: "c-external", workspaceId: undefined, registered: false,
    ownership: "external", branch: "agent/outside", sourceRef: undefined,
  });

  test("announces loading before the first answer, then the empty state", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ "/": async () => { await gate; return inventory([mainCheckout(), checkout()]); } });
    openWorktreeDialog({ api: API, source: { id: "atlas", name: "Atlas" }, view: "discover" }, h.anchor);
    await settle();
    expect(h.text()).toContain("Loading worktree inventory…");
    expect(h.main().getAttribute("aria-busy")).toBe("true");
    // Even while loading there is a way out (W7).
    expect(h.button("Cancel")).toBeTruthy();
    release!();
    await settle();
    expect(h.text()).toContain("Every worktree Git lists is registered.");
    expect(h.text()).toContain("Worktrees of Atlas that Git lists and Uatu has not registered.");
    expect(h.main().hasAttribute("aria-busy")).toBe(false);
  });

  test("lists only unregistered checkouts, each with branch, ownership label, path and one action", async () => {
    const rows = [
      mainCheckout(),
      checkout({ checkoutId: "c-registered", workspaceId: "w-registered", branch: "feature/registered" }),
      external(),
      retained(),
    ];
    const h = harness({ "/": () => inventory(rows) });
    await open(h);
    const cards = [...h.main().querySelectorAll("[data-workspace]")];
    expect(cards.map(card => card.querySelector("h3")!.textContent)).toEqual(["agent/outside", "feature/retained"]);
    // Neither the repository's own main checkout nor any registered child.
    expect(h.text()).not.toContain("feature/registered");
    expect(h.text()).not.toContain("Atlas (main)");

    const labels = (index: number) => [...cards[index]!.querySelectorAll("button, a")].map(node => (node.textContent ?? "").trim());
    expect(cards[0]!.querySelector(".wt-muted")!.textContent).toBe("External worktree");
    expect(cards[0]!.querySelector(".wt-card-path")!.getAttribute("title")).toBe("/w/atlas.worktrees/feature-a");
    expect(labels(0)).toEqual(["Register workspace"]);
    // A Uatu-created checkout whose registration did not complete: the retry
    // acts on that same checkout, and its recorded origin is still truthful.
    expect(cards[1]!.querySelector(".wt-muted")!.textContent).toBe("from main");
    expect(labels(1)).toEqual(["Retry registration"]);

    // No general-inventory affordances survive.
    const buttons = [...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim());
    expect(buttons).not.toContain("Refresh inventory");
    expect(buttons).not.toContain("Create worktree");
    expect(buttons).toContain("Cancel");
    expect(h.main().querySelector('a[href="/clone"]')).toBeNull();
  });

  test("a row's Register workspace opens registration for that checkout", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), external()]) });
    await open(h);
    h.click(h.button("Register workspace"));
    await settle();
    expect(h.heading().textContent).toBe("Register workspace");
    expect(h.text()).toContain("Register as agent/outside at its existing path.");
  });

  // W4: a transport failure (not a non-2xx response — the fetch call itself
  // rejecting, e.g. offline, DNS, CORS) used to surface the browser's raw
  // "Failed to fetch"/whatever the rejection's message happened to be. It
  // must read as the same crafted, actionable sentence a refused response
  // gets.
  test("a transport failure is an in-dialog alert, never an empty repository", async () => {
    const h = harness({ "/": () => { throw new Error("offline"); } });
    await open(h);
    expect(h.main().querySelector("[role=alert]")!.textContent)
      .toBe("Request failed. Nothing was retried automatically.");
    expect(h.heading().textContent).toBe("Register worktree");
  });

  test("an errored inventory reports its own reason", async () => {
    const h = harness({
      "/": () => inventory([], {}, {
        status: "error",
        error: { code: "inventory-unavailable", message: "Inventory could not be refreshed. Retry refresh.", retry: "refresh" },
      }),
    });
    await open(h);
    expect(h.main().querySelector("[role=alert]")!.textContent).toContain("Inventory could not be refreshed.");
  });
});

describe("the fork menu", () => {
  // "Register worktree…" is the third item — the one entry point, from the
  // picker and (via the identical dashboard fork button) from the dashboard,
  // to the checkouts Git lists that Uatu has not registered.
  test("offers exactly the three creation/discovery items and opens the dialog in the chosen one", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()]) });
    openWorktreeFork({ api: API, source: { id: "atlas", name: "Atlas" } }, h.anchor);
    const menu = h.document.querySelector('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("Create worktree");
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent))
      .toEqual(["New branch / worktree", "Existing branch", "Register worktree…"]);
    h.click(menu.querySelectorAll('[role="menuitem"]')[1]);
    await settle();
    expect(h.document.querySelector('[role="menu"]')).toBeNull();
    expect(h.text()).toContain("Existing branch · Atlas");
    expect(h.main().querySelector("[name=branch]")).toBeNull();
  });

  test("Register worktree… opens straight into the register list, with no occupancy detour", async () => {
    const external = checkout({ checkoutId: "c-ext", workspaceId: undefined, registered: false, ownership: "external", branch: "agent/r6", sourceRef: undefined });
    const h = harness({ "/": () => inventory([mainCheckout(), external]) });
    openWorktreeFork({ api: API, source: { id: "atlas", name: "Atlas" } }, h.anchor);
    const menu = h.document.querySelector('[role="menu"]')!;
    h.click(menu.querySelectorAll('[role="menuitem"]')[2]);
    await settle();
    expect(h.document.querySelector('[role="menu"]')).toBeNull();
    expect(h.heading().textContent).toBe("Register worktree");
    // An unregistered external tree is listed there, offering registration —
    // never opened or registered by the entry point itself.
    expect(h.text()).toContain("agent/r6");
    expect(h.button("Register workspace")).toBeTruthy();
    expect(h.requests.some(request => request.path === "/create")).toBe(false);
  });

  // W12: ArrowUp used to advance exactly like ArrowDown (indistinguishable
  // with two items, wrong with three); Home/End must reach the first/last of
  // all three.
  test("W12 arrows move in the right direction across all three items, and Home/End are absolute", () => {
    const h = harness({ "/": () => inventory([mainCheckout()]) });
    openWorktreeFork({ api: API, source: { id: "atlas", name: "Atlas" } }, h.anchor);
    const menu = h.document.querySelector('[role="menu"]')!;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const focused: number[] = [];
    items.forEach((item, index) => { item.focus = () => { focused.push(index); }; });
    const key = (name: string) => menu.dispatchEvent(Object.assign(new h.window.Event("keydown", { cancelable: true }), { key: name }));
    // The stub DOM tracks no activeElement, so every press starts fresh:
    // ArrowDown always reaches the first item, ArrowUp the last — which is
    // exactly what makes this a regression test for the old bug (ArrowUp
    // used to compute the identical index as ArrowDown).
    key("ArrowDown"); key("ArrowUp"); key("End"); key("Home");
    expect(focused).toEqual([0, 2, 2, 0]);
  });

  test("Escape restores focus to the fork control", () => {
    const h = harness({ "/": () => inventory([mainCheckout()]) });
    let restored = 0;
    (h.anchor as unknown as { focus: () => void }).focus = () => { restored += 1; };
    openWorktreeFork({ api: API, source: { id: "atlas", name: "Atlas" } }, h.anchor);
    const menu = h.document.querySelector('[role="menu"]')!;
    expect(h.anchor.getAttribute("aria-expanded")).toBe("true");
    menu.dispatchEvent(Object.assign(new h.window.Event("keydown", { cancelable: true }), { key: "Escape" }));
    expect(h.document.querySelector('[role="menu"]')).toBeNull();
    expect(h.anchor.getAttribute("aria-expanded")).toBe("false");
    expect(restored).toBe(1);
  });

  // W12: Tab used to let the browser's default focus traversal run against
  // a menu item the handler had already removed from the document, dropping
  // focus into limbo (the body). It must close and return focus to the
  // anchor synchronously instead.
  test("W12 Tab closes the menu and returns focus to the anchor, never dropping it", () => {
    const h = harness({ "/": () => inventory([mainCheckout()]) });
    let restored = 0;
    (h.anchor as unknown as { focus: () => void }).focus = () => { restored += 1; };
    openWorktreeFork({ api: API, source: { id: "atlas", name: "Atlas" } }, h.anchor);
    const menu = h.document.querySelector('[role="menu"]')!;
    const event = Object.assign(new h.window.Event("keydown", { cancelable: true }), { key: "Tab" });
    menu.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(h.document.querySelector('[role="menu"]')).toBeNull();
    expect(h.anchor.getAttribute("aria-expanded")).toBe("false");
    expect(restored).toBe(1);
  });
});

describe("creation", () => {
  const refs = { local: ["main", "release", "feature/a"], remote: ["origin/main", "origin/release"] };

  test("the new dialog preselects local main and Create needs a valid name", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "new" });
    expect(h.text()).toContain("New branch / worktree · Atlas");
    const selection = h.main().querySelector<HTMLInputElement>("[name=selection]")!;
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    const create = h.button("Create")!;
    expect(selection.value).toBe("local:main");
    expect(create.disabled).toBe(true);
    name.value = "--force";
    name.dispatchEvent(new h.window.Event("input"));
    expect(create.disabled).toBe(true);
    name.value = "feature/new";
    name.dispatchEvent(new h.window.Event("input"));
    expect(create.disabled).toBe(false);
  });

  test("a sole remote main is the initial base; ambiguous or absent mains leave the choice empty", async () => {
    for (const [local, remote, expected] of [
      [["feature/current"], ["origin/main", "origin/release"], "remote:origin/main"],
      [["feature/current"], ["origin/main", "upstream/main"], ""],
      [["feature/current"], ["origin/release"], ""],
    ] as [string[], string[], string][]) {
      const h = harness({ "/": () => inventory([mainCheckout()], { local, remote }) });
      await open(h, { view: "create", mode: "new" });
      expect(h.main().querySelector<HTMLInputElement>("[name=selection]")!.value).toBe(expected);
      for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
      savedGlobals.clear();
    }
  });

  test("the existing-branch dialog commits no base by default", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "existing" });
    expect(h.main().querySelector<HTMLInputElement>("[name=selection]")!.value).toBe("");
    expect(h.button("Create")!.disabled).toBe(true);
    expect(h.main().querySelector("label")!.textContent).toContain("Branch");
  });

  test("a new branch is created from the committed selection, closes the dialog and offers explicit Open", async () => {
    const created = checkout({ checkoutId: "c-new", workspaceId: "w-new", branch: "feature/new" });
    const h = harness({
      "/": () => inventory([mainCheckout()], refs),
      "/create": () => ({ ok: true, operationId: "op", kind: "create", phase: "complete", checkout: created, registered: true, started: false }),
      "/open": () => ({ ok: true, operationId: "op", kind: "start", phase: "complete", checkout: { ...created, running: true }, registered: true, started: true }),
    });
    await open(h, { view: "create", mode: "new" });
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    name.value = "feature/new";
    name.dispatchEvent(new h.window.Event("input"));
    h.submit();
    await settle();
    expect(h.requests.find(request => request.path === "/create")!.body).toEqual({
      sourceWorkspaceId: "atlas", mode: "new-branch", branch: "feature/new", base: { kind: "local", ref: "main" },
    });
    expect(h.dialog()).toBeNull();
    expect(h.changed).toEqual(["changed"]);
    const toast = h.document.querySelector("[data-worktree-confirmation]")!;
    expect(toast.textContent).toContain("Created feature/new");
    expect(h.navigations).toEqual([]);
    h.click([...toast.querySelectorAll("button")].find(node => node.textContent === "Open"));
    await settle();
    expect(h.navigations).toEqual(["/s/w-new/"]);
  });

  test("an existing remote selection creates a tracking branch", async () => {
    const h = harness({
      // F7: `origin/release` is not offered while a local `release` exists,
      // so this journey uses a remote whose tracking name is free.
      "/": () => inventory([mainCheckout()], { local: ["main"], remote: ["origin/release"] }),
      "/create": () => ({ ok: true, operationId: "op", kind: "create", phase: "complete", checkout: checkout({ branch: "release" }), registered: true, started: false }),
    });
    await open(h, { view: "create", mode: "existing" });
    h.click([...h.main().querySelectorAll('[role="option"]')].find(node => node.getAttribute("data-value") === "remote:origin/release"));
    h.submit();
    await settle();
    expect(h.requests.find(request => request.path === "/create")!.body).toEqual({
      sourceWorkspaceId: "atlas", mode: "remote-tracking", base: { kind: "remote", ref: "origin/release" },
    });
  });

  test("an occupancy refusal keeps the draft and offers the existing checkout's own action", async () => {
    const occupied = checkout({ checkoutId: "c-occupied", workspaceId: "w-occupied", branch: "feature/a", running: false });
    const h = harness({
      "/": () => inventory([mainCheckout(), occupied], refs),
      "/create": () => ({
        ok: false, operationId: "op", kind: "create", phase: "validating",
        error: { code: "branch-in-use", message: "Branch already checked out. Open its existing checkout instead.", retry: "open-existing", conflictCheckoutId: "c-occupied" },
      }),
    });
    await open(h, { view: "create", mode: "new" });
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    name.value = "feature/a";
    name.dispatchEvent(new h.window.Event("input"));
    h.submit();
    await settle();
    expect(h.dialog()).not.toBeNull();
    const alert = h.main().querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("Branch already checked out.");
    expect([...alert.querySelectorAll("button, a")].map(node => (node.textContent ?? "").trim())).toEqual(["Start"]);
    // The draft survives: name, query and the committed selection.
    expect(h.main().querySelector<HTMLInputElement>("[name=branch]")!.value).toBe("feature/a");
    expect(h.main().querySelector<HTMLInputElement>("[name=selection]")!.value).toBe("local:main");
    expect(h.changed).toEqual([]);
  });

  test("a retained checkout moves to registration retry on that same checkout", async () => {
    const retained = checkout({ checkoutId: "c-retained", workspaceId: undefined, registered: false, branch: "feature/new" });
    let reads = 0;
    const h = harness({
      "/": () => { reads += 1; return inventory(reads === 1 ? [mainCheckout()] : [mainCheckout(), retained], refs); },
      "/create": () => ({
        ok: false, operationId: "op", kind: "create", phase: "registering",
        error: { code: "registration-failed", message: "Registration failed. The checkout and branch are retained. Retry registration.", retry: "retry-registration", retainedCheckoutId: "c-retained" },
        retainedCheckout: retained,
      }),
      "/register": () => ({ ok: true, operationId: "op", kind: "register", phase: "complete", checkout: checkout({ checkoutId: "c-retained", workspaceId: "w-retained", branch: "feature/new" }), registered: true, started: false }),
    });
    await open(h, { view: "create", mode: "new" });
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    name.value = "feature/new";
    name.dispatchEvent(new h.window.Event("input"));
    h.submit();
    await settle();
    expect(h.text()).toContain("Register workspace");
    expect(h.text()).toContain("Registration failed.");
    expect(h.text()).toContain("Atlas / feature/new");
    expect(h.button("Retry registration")).toBeTruthy();
    expect(h.button("Create")).toBeUndefined();
    h.submit();
    await settle();
    expect(h.requests.find(request => request.path === "/register")!.body)
      .toEqual({ sourceWorkspaceId: "atlas", reference: "c-retained", start: false });
    expect(h.document.querySelector("[data-worktree-confirmation]")!.textContent).toContain("Created feature/new");
  });
});

describe("fetch remote branches", () => {
  const refs = { local: ["main", "feature/a"], remote: ["origin/main"] };

  test("announces its pending state, then keeps name, query and a still-valid choice", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({
      "/": () => inventory([mainCheckout()], refs),
      "/fetch": async () => { await gate; return { ok: true, refs: { local: ["main", "feature/a"], remote: ["origin/main", "origin/new"], fetchedAt: 1 } }; },
    });
    await open(h, { view: "create", mode: "new" });
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    name.value = "feature/new";
    name.dispatchEvent(new h.window.Event("input"));
    h.click(h.main().querySelector("[data-fetch]"));
    await settle();
    const status = h.main().querySelector("#operation-status")!;
    expect(status.hasAttribute("hidden")).toBe(false);
    expect(status.textContent).toBe("Fetching remote branches…");
    expect([...h.main().querySelectorAll("button")].every(node => (node as HTMLButtonElement).disabled)).toBe(true);
    release!();
    await settle();
    expect(h.main().querySelector<HTMLInputElement>("[name=branch]")!.value).toBe("feature/new");
    expect(h.main().querySelector<HTMLInputElement>("[name=selection]")!.value).toBe("local:main");
    expect([...h.main().querySelectorAll('[role="option"]')].map(node => node.getAttribute("data-value")))
      .toContain("remote:origin/new");
  });

  test("a refused fetch keeps the draft and the cached refs", async () => {
    const h = harness({
      "/": () => inventory([mainCheckout()], refs),
      "/fetch": () => ({ ok: false, error: { code: "fetch-authentication", message: "Fetch authentication failed. Correct credentials on the parent and retry.", retry: "retry-fetch" } }),
    });
    await open(h, { view: "create", mode: "new" });
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    name.value = "feature/new";
    name.dispatchEvent(new h.window.Event("input"));
    h.click(h.main().querySelector("[data-fetch]"));
    await settle();
    expect(h.main().querySelector("[role=alert]")!.textContent).toContain("Fetch authentication failed.");
    expect(h.main().querySelector<HTMLInputElement>("[name=branch]")!.value).toBe("feature/new");
    expect(h.main().querySelector<HTMLInputElement>("[name=selection]")!.value).toBe("local:main");
    expect([...h.main().querySelectorAll('[role="option"]')].map(node => node.getAttribute("data-value")))
      .toEqual(["local:main", "local:feature/a", "remote:origin/main"]);
  });

  test("a choice that vanished from the refreshed listing is cleared, never substituted", async () => {
    const h = harness({
      "/": () => inventory([mainCheckout()], refs),
      "/fetch": () => ({ ok: true, refs: { local: ["feature/a"], remote: ["origin/main"], fetchedAt: 1 } }),
    });
    await open(h, { view: "create", mode: "new" });
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    name.value = "feature/new";
    name.dispatchEvent(new h.window.Event("input"));
    h.click(h.main().querySelector("[data-fetch]"));
    await settle();
    expect(h.main().querySelector("[role=alert]")!.textContent)
      .toContain("That branch is no longer available. Choose another branch.");
    expect(h.main().querySelector<HTMLInputElement>("[name=selection]")!.value).toBe("");
    // The initial base rule never reapplies to a submitted draft, even
    // though "main" is still gone and "feature/a" is now the only local ref.
    expect(h.main().querySelector<HTMLInputElement>("[name=branch]")!.value).toBe("feature/new");
    expect(h.button("Create")!.disabled).toBe(true);
  });
});

describe("guarded deletion", () => {
  const rows = [mainCheckout(), checkout()];

  test("a stopped tree keeps the branch and asks once", async () => {
    const h = harness({
      "/": () => inventory(rows),
      "/preflight-delete": () => ({ ok: true, checkout: checkout(), requiresStop: false }),
      "/delete": () => ({ ok: true, operationId: "op", kind: "delete", phase: "complete", registered: false, started: false }),
    });
    await open(h, { view: "delete", id: "atlas-child" });
    expect(h.text()).toContain("Delete worktree?");
    expect(h.text()).toContain("Atlas / feature/a");
    expect(h.text()).toContain("The worktree’s files will be removed. The Git branch will be kept.");
    expect(h.text()).not.toContain("/w/atlas.worktrees");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel", "Delete"]);
    expect(h.button("Delete")!.className).toBe("danger");
    expect(h.main().querySelector("input")).toBeNull();
    h.submit();
    await settle();
    expect(h.requests.find(request => request.path === "/delete")!.body)
      .toEqual({ sourceWorkspaceId: "atlas", reference: "atlas-child", confirm: true, stop: false });
    expect(h.dialog()).toBeNull();
    expect(h.document.querySelector("[data-worktree-confirmation]")!.textContent).toContain("Worktree deleted. Branch kept.");
    expect(h.changed).toEqual(["changed"]);
  });

  test("a running tree asks to stop first, with no extra checkbox", async () => {
    const h = harness({
      "/": () => inventory([mainCheckout(), checkout({ running: true })]),
      "/preflight-delete": () => ({ ok: true, checkout: checkout({ running: true }), requiresStop: true }),
      "/delete": () => ({ ok: true, operationId: "op", kind: "delete", phase: "complete", registered: false, started: false }),
    });
    await open(h, { view: "delete", id: "atlas-child" });
    expect(h.text()).toContain("Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept.");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel", "Stop and delete"]);
    h.submit();
    await settle();
    expect(h.requests.find(request => request.path === "/delete")!.body)
      .toEqual({ sourceWorkspaceId: "atlas", reference: "atlas-child", confirm: true, stop: true });
  });

  test("every preflight blocker replaces the consequences and offers only Cancel", async () => {
    const blockers = [
      ["local-data", "Save or discard tracked changes outside Uatu, then try again. Files and registration retained."],
      ["local-data", "Preserve or remove untracked files outside Uatu, then try again. Files and registration retained."],
      ["local-data", "Preserve or remove ignored files outside Uatu, then try again. Files and registration retained."],
      ["git-lock", "Resolve the Git lock outside Uatu, then try again. Files and registration retained."],
      ["external-activity", "External activity is using this checkout. Stop it outside Uatu, then try again."],
      ["nested-dependency", "Resolve the nested checkout dependency outside Uatu, then try again."],
      ["ownership-required", "Only a verified Uatu-created checkout can be deleted."],
    ];
    for (const [code, message] of blockers) {
      const h = harness({
        "/": () => inventory(rows),
        "/preflight-delete": () => ({ ok: false, error: { code, message, retry: "none" } }),
      });
      await open(h, { view: "delete", id: "atlas-child" });
      expect(`${code}:${h.main().querySelector("[role=alert]")!.textContent}`).toBe(`${code}:${message}`);
      expect(`${code}:${h.text().includes("The Git branch will be kept.")}`).toBe(`${code}:false`);
      expect(`${code}:${[...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim()).join()}`).toBe(`${code}:Cancel`);
      for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
      savedGlobals.clear();
    }
  });

  test("a checkout Uatu did not create is blocked before any preflight answer is trusted", async () => {
    const external = checkout({ checkoutId: "c-ext", workspaceId: "w-ext", ownership: "external", branch: "agent/ext", sourceRef: undefined });
    const h = harness({
      "/": () => inventory([mainCheckout(), external]),
      "/preflight-delete": () => ({ ok: true, checkout: external, requiresStop: false }),
    });
    await open(h, { view: "delete", id: "w-ext" });
    expect(h.main().querySelector("[role=alert]")!.textContent)
      .toBe("Only a verified Uatu-created checkout can be deleted. Restore or verify it outside Uatu.");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel"]);
  });

  test("a refused deletion reports its reason in place and retains files and registration", async () => {
    const h = harness({
      "/": () => inventory(rows),
      "/preflight-delete": () => ({ ok: true, checkout: checkout(), requiresStop: false }),
      "/delete": () => ({
        ok: false, operationId: "op", kind: "delete", phase: "stopping",
        error: { code: "stop-failed", message: "Could not stop the Uatu session. Checkout and registration retained; no removal occurred.", retry: "retry-delete" },
      }),
    });
    await open(h, { view: "delete", id: "atlas-child" });
    h.submit();
    await settle();
    expect(h.dialog()).not.toBeNull();
    expect(h.main().querySelector("[role=alert]")!.textContent).toContain("Could not stop the Uatu session.");
    expect(h.text()).not.toContain("The Git branch will be kept.");
    expect(h.changed).toEqual([]);
  });

  test("deleting the workspace this page is showing navigates back to its source", async () => {
    const h = harness({
      "/": () => inventory(rows),
      "/preflight-delete": () => ({ ok: true, checkout: checkout(), requiresStop: false }),
      "/delete": () => ({ ok: true, operationId: "op", kind: "delete", phase: "complete", registered: false, started: false }),
    }, { pathname: "/s/atlas-child/" });
    await open(h, { view: "delete", id: "atlas-child" });
    h.submit();
    await settle();
    expect(h.navigations).toEqual(["/s/atlas/"]);
    expect(h.document.querySelector("[data-worktree-confirmation]")).toBeNull();
  });
});

describe("registration and forgetting", () => {
  test("registration discloses the inherited parent policy and starts only when asked", async () => {
    const external = checkout({ checkoutId: "c-ext", workspaceId: undefined, registered: false, ownership: "external", branch: "agent/ext", sourceRef: undefined });
    const h = harness({
      "/": () => inventory([mainCheckout(), external]),
      "/register": () => ({ ok: true, operationId: "op", kind: "register", phase: "complete", checkout: checkout({ checkoutId: "c-ext", workspaceId: "w-ext", ownership: "external", branch: "agent/ext", running: true }), registered: true, started: true }),
    });
    openWorktreeDialog({
      api: API, source: { id: "atlas", name: "Atlas", authentication: "deploy key", signing: "release key" },
      view: "register", id: "c-ext",
    }, h.anchor);
    await settle();
    expect(h.text()).toContain("Register workspace");
    expect(h.text()).toContain("Authentication: deploy key; signing: release key");
    expect(h.text()).toContain("Registration does not move files, transfer cleanup ownership or copy conversations.");
    expect(h.text()).toContain("Start after registration");
    const start = h.main().querySelector<HTMLInputElement>("[name=start]")!;
    start.checked = true;
    h.submit();
    await settle();
    expect(h.requests.find(request => request.path === "/register")!.body)
      .toEqual({ sourceWorkspaceId: "atlas", reference: "c-ext", start: true });
    expect(h.document.querySelector("[data-worktree-confirmation]")!.textContent).toContain("Registered agent/ext");
  });

  test("a refused registration stays in the same flow on the same checkout", async () => {
    const external = checkout({ checkoutId: "c-ext", workspaceId: undefined, registered: false, ownership: "external", branch: "agent/ext", sourceRef: undefined });
    const h = harness({
      "/": () => inventory([mainCheckout(), external]),
      "/register": () => ({ ok: false, operationId: "op", kind: "register", error: { code: "registration-failed", message: "Registration failed. Retry registration.", retry: "retry-registration" } }),
    });
    await open(h, { view: "register", id: "c-ext" });
    h.submit();
    await settle();
    expect(h.main().querySelector("[role=alert]")!.textContent).toContain("Registration failed.");
    expect(h.button("Register workspace")).toBeTruthy();
  });

  // There is no general inventory to go back to any more: every view is the
  // one the fork menu (or a row action) opened, and ends in Cancel or its own
  // committed operation.
  test("no view links back to a general worktree inventory", async () => {
    for (const view of ["register", "forget", "result"] as const) {
      const h = harness({ "/": () => inventory([mainCheckout(), checkout()]) });
      await open(h, { view, id: "atlas-child" });
      expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim()))
        .not.toContain("Back to worktrees");
      for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
      savedGlobals.clear();
    }
  });

  test("forget is stop-then-unregister only, and needs its confirmation", async () => {
    const h = harness({
      "/": () => inventory([mainCheckout(), checkout()]),
      "/forget": () => ({ ok: true, operationId: "op", kind: "forget", phase: "complete", registered: false, started: false }),
    });
    await open(h, { view: "forget", id: "atlas-child" });
    expect(h.text()).toContain("Remove from Uatu");
    expect(h.text()).toContain("Checkout, branch, files and creation provenance remain.");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim()))
      .toEqual(["Remove from Uatu", "Keep registration"]);
    h.submit();
    await settle();
    expect(h.requests.some(request => request.path === "/forget")).toBe(false);
    expect(h.main().querySelector("[role=alert]")!.textContent).toContain("Confirm to continue. Nothing changed.");
    h.main().querySelector<HTMLInputElement>("[name=confirm]")!.checked = true;
    h.submit();
    await settle();
    expect(h.requests.find(request => request.path === "/forget")!.body)
      .toEqual({ sourceWorkspaceId: "atlas", reference: "atlas-child" });
    expect(h.document.querySelector("[data-worktree-confirmation]")!.textContent)
      .toContain("Removed from Uatu. Checkout, branch and files were kept.");
  });
});

// A failed start used to be reachable from the inventory's own Start
// action. The register list has no Start (nothing in it is registered yet),
// so the retry-open view is driven the way the picker and the dashboard
// reach it: a registration that asked to start and did not.
describe("starting and reopening", () => {
  test("a start that failed leaves the retry-open view, which navigates only when the start succeeds", async () => {
    const h = harness({
      "/": () => inventory([mainCheckout(), checkout()]),
      "/open": () => ({
        ok: true, operationId: "op", kind: "start", phase: "complete",
        checkout: checkout(), registered: true, started: false,
        startError: { code: "start-failed", message: "Start failed. The configured workspace remains stopped. Retry Start.", retry: "retry-start" },
      }),
    });
    await open(h, {
      view: "result", id: "atlas-child",
      message: "Start failed. The configured workspace remains stopped. Retry Start.", error: true,
    });
    expect(h.text()).toContain("Open worktree");
    expect(h.main().querySelector("[role=alert]")!.textContent).toContain("Start failed.");
    expect(h.button("Retry Open")).toBeTruthy();
    h.submit();
    await settle();
    expect(h.navigations).toEqual([]);
    expect(h.main().querySelector("[role=alert]")!.textContent).toContain("Start failed.");
    h.routes["/open"] = () => ({ ok: true, operationId: "op", kind: "start", phase: "complete", checkout: checkout({ running: true }), registered: true, started: true });
    h.submit();
    await settle();
    expect(h.navigations).toEqual(["/s/atlas-child/"]);
  });
});

describe("live invalidation", () => {
  test("reloads an idle register list and nothing else", async () => {
    let reads = 0;
    const unregistered = checkout({ checkoutId: "c-ext", workspaceId: undefined, registered: false, ownership: "external", branch: "agent/live", sourceRef: undefined });
    const h = harness({ "/": () => { reads += 1; return inventory([mainCheckout(), unregistered]); } });
    await open(h);
    expect(reads).toBe(1);
    h.window.dispatchEvent(new h.window.Event("uatu:worktrees-invalidated"));
    await settle();
    expect(reads).toBe(2);
    // A view the user is working in is left exactly as it is.
    h.click(h.button("Register workspace"));
    await settle();
    const before = reads;
    h.window.dispatchEvent(new h.window.Event("uatu:worktrees-invalidated"));
    await settle();
    expect(reads).toBe(before);
    expect(h.text()).toContain("Register as agent/live at its existing path.");
  });
});

describe("focus and dismissal", () => {
  test("Cancel closes the dialog and returns focus to the control that opened it", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], { local: ["main"], remote: [] }) });
    let focused = 0;
    (h.anchor as unknown as { focus: () => void }).focus = () => { focused += 1; };
    await open(h, { view: "create", mode: "new" });
    h.click(h.main().querySelector("[data-cancel]"));
    await settle();
    expect(h.dialog()).toBeNull();
    expect(focused).toBe(1);
  });
});

// The combobox is the one piece of the retired picker that moved across
// unchanged, so its contract moves with it.
describe("editable worktree branch combobox", () => {
  function fixture(selection = "", query = "") {
    const { document, window } = parseHTML(`<input data-branch-search><input name="selection"><button data-create>Create</button><div role="listbox"><div id="local" role="option" data-value="local:fix/navigation" data-search="fix/navigation"><span>fix/navigation</span><small>Local</small></div><div id="remote" role="option" data-value="remote:origin/fix/navigation" data-search="origin/fix/navigation"><span>origin/fix/navigation</span><small>Remote</small></div><p data-branch-empty hidden></p></div>`);
    const input = document.querySelector<HTMLInputElement>("[data-branch-search]")!;
    const value = document.querySelector<HTMLInputElement>('[name="selection"]')!;
    const button = document.querySelector<HTMLButtonElement>("button")!;
    const local = document.getElementById("local")!, remote = document.getElementById("remote")!;
    for (const node of [local, remote]) node.scrollIntoView = () => {};
    input.value = query; value.value = selection;
    bindWorktreeBranches(document);
    const edit = (text: string) => { input.value = text; input.dispatchEvent(new window.Event("input")); };
    const key = (key: string) => input.dispatchEvent(Object.assign(new window.Event("keydown", { cancelable: true }), { key }));
    return { input, value, button, local, remote, edit, key, document };
  }

  test("click fills exact local/remote ref; every edit invalidates even still-matching text", () => {
    const f = fixture();
    f.edit("fnav"); expect(f.local.hidden).toBe(false); expect(f.remote.hidden).toBe(false);
    f.remote.click(); expect(f.input.value).toBe("origin/fix/navigation");
    expect(f.value.value).toBe("remote:origin/fix/navigation"); expect(f.button.disabled).toBe(false);
    expect(f.input.getAttribute("aria-expanded")).toBe("false");
    f.edit("origin/fix/navigation"); expect(f.value.value).toBe(""); expect(f.button.disabled).toBe(true);
    f.local.click(); expect(f.input.value).toBe("fix/navigation"); expect(f.value.value).toBe("local:fix/navigation");
  });

  test("reopening a committed field reviews all options; Enter chooses and Escape closes", () => {
    const f = fixture(); f.edit("origin"); expect(f.local.hidden).toBe(true);
    f.key("Enter"); expect(f.input.value).toBe("origin/fix/navigation");
    f.input.click(); expect(f.local.hidden).toBe(false); expect(f.remote.hidden).toBe(false);
    expect(f.remote.getAttribute("aria-selected")).toBe("true");
    f.key("Escape"); expect(f.input.getAttribute("aria-expanded")).toBe("false");
    f.key("ArrowDown"); expect(f.input.getAttribute("aria-expanded")).toBe("true");
  });

  test("refreshed valid choice survives; missing choice is cleared while query remains", () => {
    const valid = fixture("remote:origin/fix/navigation", "origin/fix/navigation");
    expect(valid.button.disabled).toBe(false); expect(valid.remote.getAttribute("aria-selected")).toBe("true");
    const missing = fixture("remote:origin/gone", "origin/gone");
    expect(missing.input.value).toBe("origin/gone"); expect(missing.value.value).toBe(""); expect(missing.button.disabled).toBe(true);
    expect(missing.document.querySelector<HTMLElement>("[data-branch-empty]")!.hidden).toBe(false);
  });
});

// W2: a branch name over the shared 64-character ceiling would let Git
// create the checkout and branch, then fail registration with no way to
// ever retry successfully. Refuse it in the UI before Create is even
// reachable, and say why.
describe("W2 branch name length", () => {
  const refs = { local: ["main"], remote: [] };

  test("a name over 64 characters disables Create and names the reason inline; 64 is still fine", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "new" });
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    const hint = h.main().querySelector<HTMLElement>("[data-branch-name-hint]")!;
    expect(hint.hidden).toBe(true);
    name.value = "a".repeat(64);
    name.dispatchEvent(new h.window.Event("input"));
    expect(h.button("Create")!.disabled).toBe(false);
    expect(hint.hidden).toBe(true);
    name.value = "a".repeat(65);
    name.dispatchEvent(new h.window.Event("input"));
    expect(h.button("Create")!.disabled).toBe(true);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("Branch names are limited to 64 characters in Uatu.");
    // Shortening it back under the ceiling clears the reason again.
    name.value = "a".repeat(64);
    name.dispatchEvent(new h.window.Event("input"));
    expect(hint.hidden).toBe(true);
    expect(h.button("Create")!.disabled).toBe(false);
  });
});

// W5: with the inventory read failing, delete/register/forget used to still
// render the full form (identity line blank) with a destructive button that
// did nothing at all when pressed. The view must render the actionable
// reason and never offer the dead button in the first place.
describe("W5 a failed inventory read disables destructive compact views instead of a silent no-op", () => {
  test("register renders the alert and only Cancel — no dead 'Register workspace' button", async () => {
    const h = harness({ "/": () => { throw new Error("offline"); } });
    await open(h, { view: "register", id: "atlas-child" });
    expect(h.main().querySelector("[role=alert]")!.textContent)
      .toBe("Request failed. Nothing was retried automatically.");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel"]);
    expect(h.main().querySelector("form")).toBeNull();
  });

  test("forget renders the alert and only Cancel — no dead 'Remove from Uatu' button", async () => {
    const h = harness({ "/": () => { throw new Error("offline"); } });
    await open(h, { view: "forget", id: "atlas-child" });
    expect(h.main().querySelector("[role=alert]")!.textContent)
      .toBe("Request failed. Nothing was retried automatically.");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel"]);
    expect(h.main().querySelector("form")).toBeNull();
  });
});

// W6: <main aria-live="polite"> used to re-announce the ENTIRE dialog body —
// heading, every row, every button — on every transition, drowning the
// targeted role=status/alert regions underneath it.
describe("W6 aria-live stays on the targeted regions, never the whole dialog", () => {
  test("main carries no aria-live, and neither does any ancestor up to the shadow root", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()]) });
    await open(h);
    expect(h.main().getAttribute("aria-live")).toBeNull();
    expect(h.main().closest("[aria-live]")).toBeNull();
    expect(h.main().querySelector("#operation-status")!.getAttribute("role")).toBe("status");
  });
});

// W7: the delete view's loading state rendered no buttons at all — under a
// slow network, "Delete worktree?" sat over "Loading worktree inventory…"
// with nothing clickable. Every compact view now keeps Cancel reachable
// while loading, with a pending line naming what it is waiting for.
describe("W7 compact views keep Cancel reachable and name their own loading state", () => {
  function slow(routes: Record<string, Handler> = {}) {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ "/": async () => { await gate; return inventory([mainCheckout(), checkout()]); }, ...routes });
    return { h, release: () => release!() };
  }

  test("delete: 'Checking worktree…' with only Cancel, then the real form", async () => {
    const { h, release } = slow({ "/preflight-delete": () => ({ ok: true, checkout: checkout(), requiresStop: false }) });
    openWorktreeDialog({ api: API, source: { id: "atlas", name: "Atlas" }, view: "delete", id: "atlas-child" }, h.anchor);
    await settle();
    expect(h.text()).toContain("Checking worktree…");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel"]);
    release();
    await settle();
    expect(h.text()).toContain("Delete worktree?");
    expect(h.button("Delete")).toBeTruthy();
  });

  test("register: 'Loading checkout…' with only Cancel", async () => {
    const { h, release } = slow();
    openWorktreeDialog({ api: API, source: { id: "atlas", name: "Atlas" }, view: "register", id: "atlas-child" }, h.anchor);
    await settle();
    expect(h.text()).toContain("Loading checkout…");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel"]);
    release();
    await settle();
  });

  test("forget: 'Loading checkout…' with only Cancel", async () => {
    const { h, release } = slow();
    openWorktreeDialog({ api: API, source: { id: "atlas", name: "Atlas" }, view: "forget", id: "atlas-child" }, h.anchor);
    await settle();
    expect(h.text()).toContain("Loading checkout…");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel"]);
    release();
    await settle();
  });

  test("result (retry-open): 'Loading checkout…' with only Cancel", async () => {
    const { h, release } = slow();
    openWorktreeDialog({ api: API, source: { id: "atlas", name: "Atlas" }, view: "result", id: "atlas-child" }, h.anchor);
    await settle();
    expect(h.text()).toContain("Loading checkout…");
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim())).toEqual(["Cancel"]);
    release();
    await settle();
  });
});

// W9: the inventory used to offer a generic "Add workspace options" link out
// to /clone — navigation the proposal explicitly rules out for this surface.
describe("W9 the inventory offers no generic navigation out of the session", () => {
  test("no /clone link anywhere in the inventory toolbar", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()]) });
    await open(h);
    expect(h.main().querySelector('a[href="/clone"]')).toBeNull();
  });
});

// W11: selecting a remote ref under "Existing branch" silently committed
// mode:"remote-tracking" — a new local branch, named nowhere in the dialog.
// Decision F7 (2026-09-19 live test): "Existing branch" used to list every
// ref, so picking one another checkout already had produced nothing but the
// Hub's "That branch is already checked out…" refusal. The list now offers
// only branches a worktree could actually be created on. The server-side
// occupancy refusal stays as the backstop; it is simply unreachable from
// here.
describe("Existing branch offers only branches without a checkout", () => {
  const occupied = () => checkout({ checkoutId: "c-test", workspaceId: "w-test", branch: "Test", path: "/w/atlas.worktrees/test" });
  const refs = { local: ["main", "Test", "release", "spike"], remote: ["origin/release", "origin/fresh"] };
  const values = (h: Harness) => [...h.main().querySelectorAll('[role="option"]')].map(node => node.getAttribute("data-value"));

  test("(a) every branch a listed checkout holds is gone, the main checkout's included", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), occupied()], refs) });
    await open(h, { view: "create", mode: "existing" });
    expect(values(h)).not.toContain("local:main");
    expect(values(h)).not.toContain("local:Test");
    expect(values(h)).toContain("local:release");
    expect(values(h)).toContain("local:spike");
  });

  test("(b) a remote whose local tracking name already exists is gone; the rest stay", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), occupied()], refs) });
    await open(h, { view: "create", mode: "existing" });
    // `origin/release` would have to create a local `release` that exists —
    // the existing rule calls that a conflict, never a reset.
    expect(values(h)).not.toContain("remote:origin/release");
    expect(values(h)).toContain("remote:origin/fresh");
  });

  test("(c) what remains keeps its badges and its local-then-remote order", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), occupied()], refs) });
    await open(h, { view: "create", mode: "existing" });
    expect(values(h)).toEqual(["local:release", "local:spike", "remote:origin/fresh"]);
    const badges = [...h.main().querySelectorAll('[role="option"] small')].map(node => node.textContent);
    expect(badges).toEqual(["Local", "Local", "Remote"]);
  });

  test("(d) with nothing left, the list says so and Create stays disabled", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), occupied()], { local: ["main", "Test"], remote: ["origin/Test"] }) });
    await open(h, { view: "create", mode: "existing" });
    expect(values(h)).toEqual([]);
    const empty = h.main().querySelector<HTMLElement>("[data-branch-empty]")!;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe("Every branch is already checked out. Create a new branch instead.");
    expect(h.button("Create")!.disabled).toBe(true);
  });

  test("New branch / worktree still offers every ref as a base", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), occupied()], refs) });
    await open(h, { view: "create", mode: "new" });
    // Branching FROM a checked-out base is legal, so nothing is filtered.
    expect(values(h)).toEqual([
      "local:main", "local:Test", "local:release", "local:spike",
      "remote:origin/release", "remote:origin/fresh",
    ]);
  });

  test("the filter survives Fetch remote branches", async () => {
    const h = harness({
      "/": () => inventory([mainCheckout(), occupied()], refs),
      "/fetch": () => ({ ok: true, refs: { local: ["main", "Test", "release", "spike"], remote: ["origin/release", "origin/fresh", "origin/Test", "origin/later"], fetchedAt: 1 } }),
    });
    await open(h, { view: "create", mode: "existing" });
    h.click(h.main().querySelector("[data-fetch]"));
    await settle();
    // The refreshed listing is filtered by the same rule: `origin/Test`
    // tracks a local branch a checkout holds, `origin/later` is free.
    expect(values(h)).toEqual(["local:release", "local:spike", "remote:origin/fresh", "remote:origin/later"]);
  });
});

describe("W11 existing-branch remote selections name the local branch they create", () => {
  // `main` is the main checkout's own branch, so F7 keeps it out of the list;
  // `spike` is the local branch this describe can actually select.
  const refs = { local: ["main", "spike"], remote: ["origin/feature/login"] };

  test("selecting a remote ref shows the derived local name; editing clears it", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "existing" });
    const hint = h.main().querySelector<HTMLElement>("[data-remote-hint]")!;
    expect(hint.hidden).toBe(true);
    h.click([...h.main().querySelectorAll('[role="option"]')].find(node => node.getAttribute("data-value") === "remote:origin/feature/login"));
    expect(hint.hidden).toBe(false);
    // The exact same derivation the Hub uses server-side (localTrackingBranch).
    expect(hint.textContent).toBe("Creates local branch feature/login tracking origin/feature/login.");
    const input = h.main().querySelector<HTMLInputElement>("[data-branch-search]")!;
    input.value = "m";
    input.dispatchEvent(new h.window.Event("input"));
    expect(hint.hidden).toBe(true);
  });

  test("a local selection shows no hint", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "existing" });
    const hint = h.main().querySelector<HTMLElement>("[data-remote-hint]")!;
    h.click([...h.main().querySelectorAll('[role="option"]')].find(node => node.getAttribute("data-value") === "local:spike"));
    expect(hint.hidden).toBe(true);
  });

  test("the new-branch flow has no hint element — the local name is already explicit", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "new" });
    expect(h.main().querySelector("[data-remote-hint]")).toBeNull();
  });
});

// The wide inventory view was the only one with dialog chrome of its own, and
// its title duplicated the body's h2. With every view compact, the chrome is
// gone: each view's own single h2 is the focusable, labelling heading.
describe("every view has exactly one heading, which focuses it and labels the dialog", () => {
  test("the register list and each compact view carry one h2 and no dialog chrome", async () => {
    const h = harness({ "/": () => inventory([mainCheckout(), checkout({ checkoutId: "c-ext", workspaceId: undefined, registered: false, ownership: "external", branch: "agent/one", sourceRef: undefined })]) });
    openWorktreeDialog({ api: API, source: { id: "atlas", name: "Atlas" }, view: "discover" }, h.anchor);
    await settle();
    let focused = 0;
    (h.heading() as unknown as { focus: () => void }).focus = () => { focused += 1; };
    // Re-render (Retry refresh is a no-op here) so the focus stub is in place
    // for the render that focuses.
    expect(h.main().querySelectorAll("h2")).toHaveLength(1);
    expect(h.heading().tagName).toBe("H2");
    expect(h.heading().textContent).toBe("Register worktree");
    expect(h.dialog()!.getAttribute("aria-label")).toBe("Register worktree");
    // No chrome header, so no second heading and no separate Close button.
    expect(h.shadow()!.querySelector("header")).toBeNull();
    expect([...h.main().querySelectorAll("button")].map(node => (node.textContent ?? "").trim()))
      .not.toContain("Close");
    expect(focused).toBe(0);

    const compact = harness({ "/": () => inventory([mainCheckout(), checkout()]) });
    await open(compact, { view: "delete", id: "atlas-child" });
    expect(compact.main().querySelectorAll("h2")).toHaveLength(1);
    expect(compact.main().querySelector("h2")!.textContent).toBe("Delete worktree?");
    expect(compact.dialog()!.getAttribute("aria-label")).toBe("Delete worktree?");
  });
});

describe("long branch names wrap in prose instead of overflowing", () => {
  test("the register view's 'Register as' paragraph carries the wrap rule", async () => {
    const longBranch = `feature/${"x".repeat(60)}`;
    const external = checkout({ checkoutId: "c-ext", workspaceId: undefined, registered: false, ownership: "external", branch: longBranch, sourceRef: undefined });
    const h = harness({ "/": () => inventory([mainCheckout(), external]) });
    await open(h, { view: "register", id: "c-ext" });
    const style = h.main().querySelector("style")!.textContent ?? "";
    expect(style).toContain(".wt-form p{overflow-wrap:anywhere}");
    const paragraph = [...h.main().querySelectorAll("form p")].find(node => (node.textContent ?? "").startsWith("Register as"))!;
    expect(paragraph.closest(".wt-form")).not.toBeNull();
    expect(paragraph.textContent).toContain(longBranch);
  });
});

// Card layout: the list used to lead with a bare name and bury branch and
// ownership together on one line, with the path first and unbounded. A row is
// now branch, then its ownership label, then a truncated, titled monospace
// path.
describe("register-list card layout is branch-first with a truncated, titled path", () => {
  test("line 1 is the branch, line 2 is the ownership label, line 3 is the muted path with its full value in title", async () => {
    const rows = [
      mainCheckout(),
      checkout({
        checkoutId: "c-ext", workspaceId: undefined, registered: false, ownership: "external",
        branch: "agent/outside", path: "/w/atlas.worktrees/agent-outside", sourceRef: undefined,
      }),
    ];
    const h = harness({ "/": () => inventory(rows) });
    await open(h);

    const card = h.main().querySelector("[data-workspace]")!;
    expect(card.querySelector(".wt-card-top h3")!.textContent).toBe("agent/outside");
    const lines = [...card.querySelectorAll("p")];
    expect(lines[0]!.className).toBe("wt-muted");
    expect(lines[0]!.textContent).toBe("External worktree");
    expect(lines[1]!.className).toBe("wt-card-path");
    expect(lines[1]!.getAttribute("title")).toBe("/w/atlas.worktrees/agent-outside");
    expect(lines[1]!.textContent).toBe("/w/atlas.worktrees/agent-outside");

    // Truncation is CSS (ellipsis + nowrap), asserted at the class/style
    // level the way the rest of this suite verifies presentation rules.
    const style = h.main().querySelector("style")!.textContent ?? "";
    expect(style).toContain("text-overflow:ellipsis");
    expect(style).toContain(".wt-card-path{");
  });
});

// Item A (2026-09-19 live-test decision): a checkout Uatu did not create is
// labelled for what it is. "origin unknown" is reserved for a Uatu-owned
// branch with no recorded creation history, so an external tree can never be
// read as "a Uatu worktree whose origin we forgot".
describe("ownership labels name what Uatu did not create", () => {
  test("external, uncertain, recorded and unrecorded Uatu provenance each have their own label", () => {
    expect(worktreeProvenanceLabel({ ownership: "external" })).toBe("External worktree");
    // Even with a recorded ref on the branch, ownership outranks history.
    expect(worktreeProvenanceLabel({ ownership: "external", sourceRef: "main" })).toBe("External worktree");
    expect(worktreeProvenanceLabel({ ownership: "uncertain" })).toBe("Ownership uncertain");
    expect(worktreeProvenanceLabel({ ownership: "uatu", sourceRef: "origin/release" })).toBe("from origin/release");
    expect(worktreeProvenanceLabel({ ownership: "uatu" })).toBe("origin unknown");
    // An unstated ownership behaves like a Uatu-owned row, as the dashboard's
    // own child rows did before this field reached the picker.
    expect(worktreeProvenanceLabel({ sourceRef: "main" })).toBe("from main");
  });

  test("the register list uses the same wording for the rows it offers", async () => {
    const rows = [
      mainCheckout(),
      checkout({ checkoutId: "c-ext", workspaceId: undefined, registered: false, ownership: "external", branch: "agent/outside", sourceRef: undefined }),
      checkout({ checkoutId: "c-unc", workspaceId: undefined, registered: false, ownership: "uncertain", branch: "review/x", sourceRef: undefined }),
    ];
    const h = harness({ "/": () => inventory(rows) });
    await open(h);
    const labels = [...h.main().querySelectorAll(".wt-muted")].map(node => node.textContent);
    expect(labels).toEqual(["External worktree", "Ownership uncertain"]);
    expect(h.text()).not.toContain("no cleanup ownership");
  });
});

// Item C: on iOS Safari the branch list could not be used at all. WebKit
// treats a canceled `pointerdown` from a touch as "not a tap" and never
// synthesizes the compatibility `click`, so every option (and every footer
// button) in this dialog was inert: Create stayed disabled forever.
describe("the branch list opens expanded and commits on touch", () => {
  // Every ref here is one F7 still offers: `main` is the main checkout's own
  // branch and `origin/release` would collide with a local `release`, so the
  // list this describe exercises is release + spike + origin/detached.
  const refs = { local: ["main", "release", "spike"], remote: ["origin/detached"] };

  test("Existing branch opens with the full local+remote list expanded and Create disabled", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "existing" });
    const options = [...h.main().querySelectorAll('[role="option"]')];
    expect(options.length).toBe(3);
    expect(options.every(option => !(option as HTMLElement).hidden)).toBe(true);
    const listbox = h.main().querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox.hidden).toBe(false);
    expect(h.main().querySelector("[data-branch-search]")!.getAttribute("aria-expanded")).toBe("true");
    expect(h.main().querySelector<HTMLElement>("[data-branch-empty]")!.hidden).toBe(true);
    expect(h.button("Create")!.disabled).toBe(true);
  });

  test("a touch tap commits the option it started on and enables Create", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "existing" });
    const option = [...h.main().querySelectorAll('[role="option"]')]
      .find(node => node.getAttribute("data-value") === "local:release")!;
    const pointer = (type: string, pointerType: string) =>
      Object.assign(new h.window.Event(type, { bubbles: true, cancelable: true }), { pointerType });

    // A touch press must NOT be canceled, or WebKit never delivers the tap.
    const down = pointer("pointerdown", "touch");
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    // The press is what commits on touch — `click` may never arrive.
    option.dispatchEvent(pointer("pointerup", "touch"));
    expect(h.main().querySelector<HTMLInputElement>("[name=selection]")!.value).toBe("local:release");
    expect(h.main().querySelector<HTMLInputElement>("[data-branch-search]")!.value).toBe("release");
    expect(h.button("Create")!.disabled).toBe(false);
  });

  test("a mouse press still keeps focus in the field, and a drag off the list commits nothing", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "existing" });
    const options = [...h.main().querySelectorAll('[role="option"]')];
    const pointer = (type: string, pointerType: string) =>
      Object.assign(new h.window.Event(type, { bubbles: true, cancelable: true }), { pointerType });
    const down = pointer("pointerdown", "mouse");
    options[0]!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    // A drag that scrolls the list is canceled, and releasing commits nothing.
    options[0]!.dispatchEvent(pointer("pointercancel", "touch"));
    options[0]!.dispatchEvent(pointer("pointerup", "touch"));
    expect(h.main().querySelector<HTMLInputElement>("[name=selection]")!.value).toBe("");
    expect(h.button("Create")!.disabled).toBe(true);
  });

  test("the footer's own buttons stay tappable: Cancel is never canceled on touch", async () => {
    const h = harness({ "/": () => inventory([mainCheckout()], refs) });
    await open(h, { view: "create", mode: "existing" });
    const cancel = h.main().querySelector("[data-cancel]")!;
    const press = (pointerType: string) => {
      const event = Object.assign(new h.window.Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType });
      cancel.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press("touch")).toBe(false);
    expect(press("mouse")).toBe(true);
  });
});

// Item D: the confirmation moved from the bottom edge (where a phone's own
// chrome and the touch tab bar compete with it) to the top of the viewport,
// under the desktop titlebar inset, and gained the app's success colour so it
// is noticed at all.
describe("the committed-operation confirmation sits at the top, in success colour", () => {
  async function created(): Promise<Harness> {
    const madeCheckout = checkout({ checkoutId: "c-new", workspaceId: "w-new", branch: "feature/new" });
    const h = harness({
      "/": () => inventory([mainCheckout()], { local: ["main"], remote: [] }),
      "/create": () => ({ ok: true, operationId: "op", kind: "create", phase: "complete", checkout: madeCheckout, registered: true, started: false }),
    });
    await open(h, { view: "create", mode: "new" });
    const name = h.main().querySelector<HTMLInputElement>("[name=branch]")!;
    name.value = "feature/new";
    name.dispatchEvent(new h.window.Event("input"));
    h.submit();
    await settle();
    return h;
  }

  test("it renders at the top, offset by the titlebar inset, centered and above the app header", async () => {
    const h = await created();
    const toast = h.document.querySelector<HTMLElement>("[data-worktree-confirmation]")!;
    const style = toast.getAttribute("style") ?? "";
    expect(style).toContain("top:calc(16px + var(--titlebar-inset,0px))");
    expect(style).not.toContain("bottom:");
    expect(style).toContain("left:50%");
    expect(style).toContain("transform:translateX(-50%)");
    expect(style).toContain("z-index:2100");
  });

  test("it carries the success colour and a leading check, keeping its content and both buttons", async () => {
    const h = await created();
    const toast = h.document.querySelector<HTMLElement>("[data-worktree-confirmation]")!;
    expect(toast.dataset.tone).toBe("success");
    expect(toast.getAttribute("role")).toBe("status");
    const style = toast.getAttribute("style") ?? "";
    expect(style).toContain("border:1px solid var(--success,#2da44e)");
    // The tint is a token both stylesheets define, so it follows the used
    // colour scheme; the message keeps --text-strong on it, which is past AA
    // in both schemes.
    expect(style).toContain("background:var(--success-soft,#dafbe1)");
    expect(style).toContain("color:var(--text-strong,#1f2328)");
    const check = toast.querySelector("span")!;
    expect(check.textContent).toBe("✓");
    expect(check.getAttribute("aria-hidden")).toBe("true");
    expect(toast.textContent).toContain("Created feature/new");
    expect([...toast.querySelectorAll("button")].map(node => node.textContent))
      .toEqual(["Open", "×"]);
  });
});
