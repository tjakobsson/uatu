import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { LOCAL_CREDENTIAL_ASSIGNMENT_WARNING, parseCloneRemote } from "./credential-context";
import { createDashboardGroups, dashboardGroupsStyle } from "./dashboard-groups";
import { clonePage, dashboardPage, loginPage, settingsPage, stoppedSessionPage } from "./pages";

const htmlFor = {
  dashboard: () => dashboardPage("alice"),
  clone: () => clonePage("alice"),
  settings: () => settingsPage("alice"),
};

test("authenticated navigation wraps dynamic notifications without losing labelled actions", () => {
  for (const render of Object.values(htmlFor)) {
    const html = render();
    expect(html).toMatch(/\.hub-nav \{[^}]*flex-wrap: wrap/);
    expect(html).toContain('.hub-nav a, .hub-nav button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; }');
    expect(html).toContain('hosts: ".hub-nav"');
    const nav = parseHTML(html).document.querySelector(".hub-nav")!;
    expect([...nav.querySelectorAll("a, button")].map(node => node.textContent)).toEqual(["Dashboard", "Add workspace", "Settings", "Sign out"]);
  }
});

function documentFor(page: keyof typeof htmlFor) {
  return parseHTML(htmlFor[page]()).document;
}

test("dashboard child startup checks and unlocks parent policy but starts the child", async () => {
  const script = clientScript(htmlFor.dashboard());
  const source = script.slice(script.indexOf("async function prepareWorkspaceResume"), script.indexOf("// Rename workspace changes"));
  const parent = { id: "parent", credentialAssignments: { authentication: ["key"], signing: [] } };
  const child = { id: "child", parentId: "parent", credentialAssignments: { authentication: [], signing: [] } };
  const checked: string[] = [], started: string[] = [], opened: string[] = [];
  let confirmations = 0, unlocks = 0, allowUnlock = true;
  const start = new Function("dashboardWorkspaces", "loadDashboardCredentials", "lockedWorkspaceCredentials", "unlockForWorkspace", "hasCredentialAssignments", "confirm", "setLocalError", "api", "openSession", `let uiBusy = 0; ${source}; return startRegisteredWorkspace;`)(
    [parent, child], async () => {}, (id: string) => { checked.push(id); return id === "parent" ? [{}] : []; },
    async () => { unlocks++; return allowUnlock; }, (a: typeof parent.credentialAssignments) => a.authentication.length > 0,
    () => { confirmations++; return true; }, () => {}, async (url: string) => started.push(url), (id: string) => opened.push(id),
  );
  await start(child, { textContent: "Start" }, {});
  expect({ confirmations, checked, unlocks, started, opened }).toEqual({ confirmations: 0, checked: ["parent"], unlocks: 1, started: ["/api/hub/sessions/child/start"], opened: ["child"] });
  allowUnlock = false;
  await start(child, { textContent: "Start" }, {});
  expect(unlocks).toBe(2);
  expect(started).toHaveLength(1);
  expect(opened).toHaveLength(1);
});

// Runs the dashboard's real refresh() — with the row-summary helpers it
// calls — against a fetched workspace list, faking the page's DOM-building
// and networking seams. Rows render as `.row` nodes carrying their title,
// detail, and labelled action buttons; `overrides` replaces any binding a
// test needs to observe (api calls, dialog opens, ...).
function dashboardRefreshHarness(entries: unknown[], overrides: Record<string, unknown> = {}) {
  const script = clientScript(htmlFor.dashboard());
  // A moved or renamed marker would silently slice an empty string and make
  // every assertion below vacuous, so each one must still be found.
  const mark = (needle: string) => {
    const index = script.indexOf(needle);
    if (index < 0) throw new Error(`dashboard client script no longer contains: ${needle}`);
    return index;
  };
  const summaries = script.slice(mark("function shellSummary(shells)"), mark("function el(tag, className, text)"));
  const helpers = script.slice(mark("function workspaceLabel(w)"), mark("async function startRegisteredWorkspace"));
  const refreshSource = script.slice(mark("async function refresh(force)"), mark("// The device-session list"));
  const { document, window } = parseHTML('<html><body><div id="hub-version"></div><div id="sessions"></div><div id="workspaces"></div></body></html>');
  const row = (spec: any) => {
    const node = document.createElement("div"); node.className = "row";
    node.innerHTML = '<div class="row-main"><div class="row-title"></div><div class="row-detail"></div></div><div class="row-actions"></div>';
    node.querySelector(".row-title")!.textContent = spec.title;
    node.querySelector(".row-detail")!.textContent = spec.detail;
    for (const action of spec.buttons) { const button = document.createElement("button"); button.textContent = action.label; button.setAttribute("aria-label", action.ariaLabel || ""); button.onclick = () => action.onClick(button); node.querySelector(".row-actions")!.append(button); }
    return node;
  };
  const bindings: Record<string, unknown> = {
    document, HTMLElement: window.HTMLElement,
    fetch: async () => ({ ok: true, json: async () => ({ worktreeApi: "/api/hub/worktrees", workspaces: entries }) }),
    row, renderInto: (container: Element, rows: Element[]) => container.replaceChildren(...rows),
    actionErrorFor: () => ({}), setLocalError: () => {}, api: async () => {}, el: (tag: string) => document.createElement(tag),
    worktreeProvenanceLabel: () => "", worktreeForkIcon: "", renderDashboardGroups: () => {}, openWorktreeDialog: () => {},
    sessionUrl: (id: string) => "/s/" + id + "/",
    ...overrides,
  };
  const refresh = new Function(...Object.keys(bindings), `let uiBusy=0, dashboardWorkspaces=[]; ${summaries} ${helpers} ${refreshSource}; return refresh;`)(...Object.values(bindings)) as (force?: boolean) => Promise<void>;
  return { document, refresh };
}

// Renders the settings page's real credentialCard() — with the credential
// helpers and the policy-owner lookup it calls — against a given
// `dashboardWorkspaces` list, so the "Restart required" notice is asserted on
// the rendered card rather than on source text. Only the card's build path
// runs; its action handlers are never invoked.
function credentialCardHarness(workspaces: unknown[]) {
  const script = clientScript(htmlFor.settings());
  // As in dashboardRefreshHarness: a moved marker must fail loudly instead of
  // slicing an empty string and making every assertion vacuous.
  const mark = (needle: string) => {
    const index = script.indexOf(needle);
    if (index < 0) throw new Error(`settings client script no longer contains: ${needle}`);
    return index;
  };
  const elSource = script.slice(mark("function el(tag, className, text)"), mark("function row({ title"));
  const helpers = script.slice(mark("const capabilityLabels = {"), mark("function credentialCard(credential)"));
  const cardSource = script.slice(mark("function credentialCard(credential)"), mark("function workspaceAssignmentEntries(workspaceId)"));
  const ownerSource = script.slice(mark("function workspacePolicyOwner(workspace)"), mark("// Row summary of a workspace's effective credential policy"));
  const { document } = parseHTML("<html><body></body></html>");
  const bindings: Record<string, unknown> = {
    document,
    credentialAction: async () => {}, loadCredentials: async () => {}, withBusy: async () => {},
    api: async () => {}, confirm: () => false,
  };
  const prelude = `const credentialCatalog = []; const dashboardWorkspaces = ${JSON.stringify(workspaces)};`
    + ' const openCredentialIds = new Set(); const credentialPath = "/api/hub/credentials";';
  return new Function(...Object.keys(bindings), `${prelude} ${elSource} ${helpers} ${ownerSource} ${cardSource} return credentialCard;`)(
    ...Object.values(bindings),
  ) as (credential: unknown) => Element;
}

test("dashboard preserves ordinary-folder removal and routes repository removal safely", async () => {
  const calls: string[] = [];
  const { document, refresh } = dashboardRefreshHarness(
    [{ id: "docs" }, { id: "main", createWorktree: true }, { id: "child", parentId: "main" }],
    { api: async (url: string) => calls.push(url), openWorktreeDialog: (options: any) => calls.push(options.view + ":" + options.id) },
  );
  await refresh();
  for (const id of ["docs", "main", "child"]) await (document.querySelector(`[data-workspace="${id}"] [aria-label^="Remove "]`) as any).onclick();
  expect(calls).toEqual(["/api/hub/workspaces/docs/forget", "forget:main", "forget:child"]);
});

test("dashboard rows disclose a linked worktree's inherited parent credentials", async () => {
  const none = { authentication: [], signing: [] };
  const { document, refresh } = dashboardRefreshHarness([
    { id: "repo", displayName: "Repo", running: true, shells: [], credentialAssignments: { authentication: ["key-a"], signing: ["gpg-b"] } },
    { id: "repo-child", parentId: "repo", branch: "feature/x", credentialAssignments: none },
    { id: "repo-child-live", parentId: "repo", branch: "feature/live", running: true, shells: [], credentialAssignments: none },
    { id: "bare", displayName: "Bare", credentialAssignments: none },
    { id: "bare-child", parentId: "bare", branch: "feature/y", credentialAssignments: none },
    { id: "plain", credentialAssignments: none },
  ]);
  await refresh();
  const details = Object.fromEntries([...document.querySelectorAll(".row")].map(node => [node.querySelector(".row-title")!.textContent, node.querySelector(".row-detail")!.textContent]));
  expect(details).toEqual({
    "Repo": "🔑 Auth: key-a · ✎ Signing: gpg-b · no shells",
    "feature/x": "🔑 Auth: key-a · ✎ Signing: gpg-b · inherited from Repo",
    "feature/live": "🔑 Auth: key-a · ✎ Signing: gpg-b · inherited from Repo · no shells",
    "Bare": "⊘ No credentials assigned",
    "feature/y": "⊘ No credentials assigned · inherited from Bare",
    "plain": "⊘ No credentials assigned",
  });
});

test("dashboard worktree live subscription recovers on visibility-only return before and during a dialog", () => {
  const script = clientScript(htmlFor.dashboard());
  const start = script.indexOf("function initDashboardWorktreeLive()");
  expect(start).toBeGreaterThan(-1);
  const source = script.slice(start, script.indexOf("async function refresh(force)", start));
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const streams: FakeStream[] = [];
  class FakeStream extends EventTarget {
    closed = false;
    constructor(readonly url: string) { super(); streams.push(this); }
    close() { this.closed = true; }
    send(ws: string) { this.dispatchEvent(Object.assign(new Event("live"), { data: JSON.stringify({ ws, topic: "worktrees", event: { kind: "data" } }) })); }
  }
  let invalidations = 0;
  window.addEventListener("uatu:worktrees-invalidated", () => invalidations++);
  new Function("window", "document", "EventSource", `${source}; initDashboardWorktreeLive();`)(window, document, FakeStream);
  const open = (source: string) => {
    const controller = new AbortController();
    window.dispatchEvent(Object.assign(new Event("uatu:worktree-dialog-opened"), { detail: { source, signal: controller.signal } }));
    return controller;
  };
  // Standalone iOS can return from an unpersisted pagehide with only a
  // visibilitychange. It must not permanently disable dialogs opened later.
  document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: false }));
  document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
  const first = open("main");
  expect(streams).toHaveLength(1);
  expect(new URL(streams[0]!.url, "http://hub").searchParams.get("subs")).toBe('[{"topic":"worktrees"}]');
  streams[0]!.send("other"); streams[0]!.send("main");
  expect(invalidations).toBe(1);
  window.dispatchEvent(new Event("pageshow"));
  expect(streams).toHaveLength(1);
  document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  expect(streams[0]!.closed).toBe(true);
  window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: false }));
  document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
  expect(streams).toHaveLength(2);
  window.dispatchEvent(new Event("pageshow"));
  expect(streams).toHaveLength(2);
  const second = open("second");
  first.abort(); streams[1]!.send("main"); streams[2]!.send("second");
  expect(invalidations).toBe(2);
  expect(streams.filter(stream => !stream.closed)).toHaveLength(1);
  second.abort(); window.dispatchEvent(new Event("online"));
  expect(streams.filter(stream => !stream.closed)).toHaveLength(0);
  const reopened = open("main");
  streams[3]!.send("main");
  expect(invalidations).toBe(3);
  expect(streams.filter(stream => !stream.closed)).toHaveLength(1);
  reopened.abort();
});

function clientScript(html: string): string {
  const start = html.indexOf("<script>");
  const end = html.lastIndexOf("</script>");
  return start >= 0 && end > start ? html.slice(start + "<script>".length, end) : "";
}

test("dashboard retries failed live streams with capped backoff and cancels recovery on lifecycle teardown", () => {
  const script = clientScript(htmlFor.dashboard());
  const start = script.indexOf("function initDashboardWorktreeLive()");
  const source = script.slice(start, script.indexOf("async function refresh(force)", start));
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  const streams: FakeStream[] = [];
  class FakeStream extends EventTarget {
    readyState = 0;
    constructor(_url: string) { super(); streams.push(this); }
    close() { this.readyState = 2; }
    fail() { this.readyState = 2; this.dispatchEvent(new Event("error")); }
  }
  new Function("window", "document", "EventSource", "setTimeout", "clearTimeout", `${source}; initDashboardWorktreeLive();`)(
    window, document, FakeStream,
    (callback: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    (id: number) => timers.delete(id),
  );
  const controller = new AbortController();
  window.dispatchEvent(Object.assign(new Event("uatu:worktree-dialog-opened"), { detail: { source: "main", signal: controller.signal } }));
  const tick = (delay: number) => {
    expect(timers.size).toBe(1);
    const [id, timer] = [...timers][0]!;
    expect(timer.delay).toBe(delay);
    timers.delete(id); timer.callback();
    expect(streams.filter(stream => stream.readyState !== 2)).toHaveLength(1);
  };
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    streams.at(-1)!.fail(); streams.at(-1)!.dispatchEvent(new Event("error"));
    window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("pageshow"));
    tick(delay);
  }
  streams.at(-1)!.dispatchEvent(new Event("open"));
  streams.at(-1)!.fail(); tick(1000);
  streams.at(-1)!.fail();
  document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  expect(timers.size).toBe(0);
  expect(streams.every(stream => stream.readyState === 2)).toBe(true);
  document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
  streams.at(-1)!.fail(); window.dispatchEvent(new Event("pagehide"));
  expect(timers.size).toBe(0);
  const count = streams.length;
  window.dispatchEvent(new Event("online"));
  expect(streams).toHaveLength(count);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(streams).toHaveLength(count + 1);
  window.dispatchEvent(new Event("pageshow"));
  expect(streams).toHaveLength(count + 1);
  // A terminal CLOSED source without another error must not block wake-up.
  streams.at(-1)!.readyState = 2;
  window.dispatchEvent(new Event("online"));
  expect(streams).toHaveLength(count + 2);
  streams.at(-1)!.fail(); controller.abort();
  expect(timers.size).toBe(0);
  window.dispatchEvent(new Event("pageshow"));
  expect(streams.every(stream => stream.readyState === 2)).toBe(true);
});

function folderMutationFunction(html: string) {
  const script = clientScript(html);
  const start = script.indexOf("async function requestFolderMutation");
  const end = script.indexOf("async function refreshAfterFolderMutation", start);
  const source = script.slice(start, end);
  return (api: (path: string, body: Record<string, unknown>) => Promise<unknown>, confirm: (message: string) => boolean) =>
    new Function("api", "confirm", `${source}\nreturn requestFolderMutation;`)(api, confirm) as (
      path: string,
      body: Record<string, unknown>,
    ) => Promise<unknown>;
}

// Extracts the clone form's retained-host resolution (remoteHostFromUrl +
// retainedHostFor) with the clone-url input faked, so the client's parsing
// can be asserted against the server's for the same remote spelling.
function retainedHostFunction(html: string) {
  const script = clientScript(html);
  const start = script.indexOf("function normalizedUrlHost");
  const end = script.indexOf("function updateCloneCredentials", start);
  const source = script.slice(start, end);
  return (remote: string, credential: { type: string; metadata: Record<string, string> }) =>
    new Function("document", `${source}\nreturn retainedHostFor;`)({
      getElementById: () => ({ value: remote }),
    })(credential) as string | null;
}

function cloneCompatibleFunction(html: string) {
  const script = clientScript(html);
  const start = script.indexOf("function normalizedUrlHost");
  const end = script.indexOf("// Host a retained authentication selection applies", start);
  return new Function(`${script.slice(start, end)}\nreturn cloneCompatible;`)() as (
    credential: { enabled: boolean; type: string; capabilities: string[]; metadata: { host: string } },
    kind: string,
    remote: string,
  ) => boolean;
}

// Extracts the clone page's terminal-result handling (resetCloneForm +
// finishClone) with the form controls and the page's side effects faked, so
// what a given job result does to the submitted form can be exercised
// directly. Returns the fake controls alongside the handler.
function cloneFinishFunction(html: string) {
  const script = clientScript(html);
  const reset = script.slice(script.indexOf("function resetCloneForm"), script.indexOf("function parseCloneEvent"));
  const finish = script.slice(script.indexOf("async function finishClone"), script.indexOf("function connectCloneEvents"));
  expect(reset).toContain("cloneStartAfter.checked = false");
  expect(finish).toContain("const status = result.status || result.result");
  return () => {
    const form = {
      url: { value: "https://github.com/acme/docs.git" },
      folderName: { value: "docs" },
      displayName: { value: "Docs site" },
      credential: { value: "cred-token" },
      retainedAuth: { value: "cred-key" },
      signing: { value: "cred-sign" },
      startAfter: { checked: true },
    };
    const opened: string[] = [];
    const handler = new Function(
      "document",
      "cloneDisplayName",
      "cloneCredential",
      "cloneRetainedAuth",
      "cloneSigning",
      "cloneStartAfter",
      "updateCloneCredentialState",
      "clearCloneState",
      "setClonePhase",
      "appendCloneOutput",
      "cloneOutput",
      "cloneResponse",
      "cloneResponseLabel",
      "loadBrowser",
      "openSession",
      "refreshWorkspaceState",
      `let cloneNameTouched = true;\n${reset}\n${finish}\nreturn finishClone;`,
    )(
      { getElementById: (id: string) => (id === "clone-url" ? form.url : form.folderName) },
      form.displayName,
      form.credential,
      form.retainedAuth,
      form.signing,
      form.startAfter,
      () => {},
      () => {},
      () => {},
      () => {},
      { textContent: "" },
      { value: "" },
      { textContent: "" },
      async () => {},
      (id: string) => opened.push(id),
      async () => {},
    ) as (result: Record<string, unknown>) => Promise<void>;
    return { form, opened, finishClone: handler };
  };
}

describe("authenticated Hub pages", () => {
  test("share navigation and have syntactically valid page-scoped initialization", () => {
    for (const pageName of ["dashboard", "clone", "settings"] as const) {
      const html = htmlFor[pageName]();
      expect(html).toContain(`data-hub-page="${pageName}"`);
      expect(html).toContain('href="/"');
      expect(html).toContain("Dashboard</a>");
      expect(html).toContain('href="/clone"');
      expect(html).toContain('href="/settings"');
      expect(html).toContain('action="/logout"');
      expect(() => new Function(clientScript(html))).not.toThrow();
    }
    expect(htmlFor.dashboard()).toContain('href="/" aria-current="page"');
    expect(htmlFor.clone()).toContain('href="/clone" aria-current="page"');
    expect(htmlFor.settings()).toContain('href="/settings" aria-current="page"');
  });

  test("keeps moved sections out of the dashboard DOM", () => {
    const document = documentFor("dashboard");
    expect(document.getElementById("sessions")).not.toBeNull();
    expect(document.getElementById("workspaces")).not.toBeNull();
    for (const id of ["browser", "clone-form", "credentials-pane", "credential-tools", "devices"]) {
      expect(document.getElementById(id)).toBeNull();
    }
  });

  test("shows neutral credential summaries and confirms only an unassigned resume", () => {
    const html = htmlFor.dashboard();
    const refreshBody = html.slice(html.indexOf("async function refresh(force)"), html.indexOf("async function loadDevices()"));
    expect(html).toContain('return parts.join(" · ") || "⊘ No credentials assigned"');
    expect(html).toContain('parts.push("🔑 Auth: " + authentication.join(", "))');
    expect(html).toContain('parts.push("✎ Signing: " + signing.join(", "))');
    expect(html).toContain("if (!hasCredentialAssignments(workspacePolicyOwner(w).credentialAssignments) && !confirm(");
    expect(html).toContain("Git authentication and commit signing may be unavailable, but the workspace can still start. Continue?");
    const startFlow = html.indexOf("async function startRegisteredWorkspace");
    expect(startFlow).toBeGreaterThan(0);
    const confirmCheck = html.indexOf("if (!hasCredentialAssignments(workspacePolicyOwner(w).credentialAssignments)", startFlow);
    expect(confirmCheck).toBeGreaterThan(-1);
    expect(confirmCheck).toBeLessThan(html.indexOf("uiBusy += 1", startFlow));
    expect(html).toContain("prepareWorkspaceResume(w, target)");
    expect(html).toContain('label: "Start"');
    expect(html).toContain('label: "Rename workspace"');
    expect(html).toContain('label: "Remove from Hub"');
    expect(html).not.toContain('label: "Resume"');
    expect(html).not.toContain('label: "Forget"');
    // Rows title by mutable display name with the path as secondary detail.
    expect(html).toContain("title: workspaceLabel(w)");
    expect(html).toContain('"/display-name", { displayName: next }');
    expect(html).toContain("Unlock credentials for ");
    expect(html).toContain("Unlock and resume");
    expect(html).toContain('field.credential.id) + "/unlock"');
    expect(refreshBody).not.toContain("renderCredentialCatalog()");
  });
});

describe("worktree dashboard integration (Section 11 UX review)", () => {
  test("W3 the missing/replaced-checkout warning goes into .row-main, keeping the title/path column width", () => {
    const html = htmlFor.dashboard();
    // .row is a row-direction flexbox; .row-main is itself a column
    // flexbox with min-width:0. Appending the warning to .row directly (the
    // bug) makes it a flex item that squeezes .row-main to min-content,
    // breaking the title down to one character per line. Appending it
    // inside .row-main keeps the row's existing columns their size.
    expect(html).toContain('node.querySelector(".row-main").append(warning);');
    expect(html).not.toContain("node.append(warning);");
  });

  test("W9 the parent fork button opens the shared three-item menu (New branch, Existing branch, Register worktree…)", () => {
    const html = htmlFor.dashboard();
    // The dashboard's own fork button calls the exact same openWorktreeFork
    // the picker calls — inlined once as worktreeDialogScript, not
    // reimplemented — so the menu shape (including W1's third item) is
    // identical on both surfaces by construction.
    expect(html).toContain('fork.onclick = () => openWorktreeFork(target, fork); actions.append(fork);');
    // The trailing ellipsis survives bundling as either the literal
    // character or its \u escape, so match just the stable label prefix.
    expect(html).toMatch(/label: "Register worktree/);
    expect(html).not.toMatch(/label: "Repository worktrees/);
  });

  // Item A (2026-09-19 live-test decision): a dashboard child row labels a
  // tree Uatu did not create "External worktree" — the same rule the picker
  // and the register list apply, from the one inlined helper rather than a
  // second spelling of it here.
  test("child rows take their muted provenance label from the shared ownership rule", () => {
    const html = htmlFor.dashboard();
    expect(html).toContain('el("span", "worktree-provenance", worktreeProvenanceLabel(w))');
    expect(html).not.toContain('w.sourceRef ? "from " + w.sourceRef : "origin unknown"');
    // The helper it calls is part of the inlined module's public surface.
    expect(html).toContain("function worktreeProvenanceLabel(");
    expect(html).toContain("worktreeProvenanceLabel,");
  });

  // Decision F8 (2026-09-19, second round): the Active-groups heading and the
  // main checkout's own row already say which rows belong to which
  // repository, so a child shares the main row's left edge — exactly as the
  // picker's menu does since F4. No inset, no tree line.
  test("child rows are not indented under the repository heading", () => {
    const html = htmlFor.dashboard();
    // The parent link itself is what grouping reads; only the inset is gone.
    expect(html).toContain("node.dataset.parent = w.parentId;");
    expect(html).not.toContain("marginInlineStart");
    expect(html).not.toContain("paddingInlineStart");
    expect(html).not.toContain("padding-inline-start");
    expect(html).not.toContain("border-inline-start");
    // The dashboard's styles carry exactly one inline-start rule, and it is
    // F10's heading-actions alignment — nothing insets a workspace row.
    expect(html.match(/inline-start/g) ?? []).toHaveLength(1);
    expect(dashboardGroupsStyle).toContain(".dashboard-group-heading .row-actions{margin-inline-start:auto}");
  });

  // Decision F9 (2026-09-19, second round): the per-repository Configure
  // button only navigated to the global Settings page, which the Hub's own
  // navigation already reaches, so it is gone. Parent credentials and shared
  // policy are still managed there; the heading keeps Rename workspace and
  // the fork control.
  test("a repository heading carries no Configure button, and no state field points one at Settings", () => {
    const html = htmlFor.dashboard();
    expect(html).not.toContain("worktreeConfigureNavigation");
    expect(html).not.toContain('" credentials and shared settings"');
    expect(html).not.toContain('el("button", null, "Configure")');
    // The heading still collects what remains.
    expect(html).toContain('button.getAttribute("aria-label")?.startsWith("Rename workspace")');
    expect(html).toContain('button.getAttribute("aria-label")?.startsWith("Add worktree")');
  });

  // Decision F10 (2026-09-19): the repository heading's actions sit at the
  // row's right edge, where Open/Stop end on the rows beneath — the same
  // treatment F2 gave the picker's group header.
  test("the repository heading pushes its actions to the row's trailing edge", () => {
    expect(dashboardGroupsStyle).toContain(".dashboard-group-heading .row-actions{margin-inline-start:auto}");
    expect(dashboardGroupsStyle).toContain(".dashboard-group-heading .row-title{flex:1 1 auto;min-width:0}");
    // Narrow viewports wrap the actions under the name, still right-aligned.
    expect(dashboardGroupsStyle).toContain(".dashboard-group-heading .row-actions{flex:1 0 100%}");
    // The heading collects the name first, then its actions, fork last.
    const source = createDashboardGroups.toString();
    expect(source.indexOf('heading.append(make("h3"')).toBeLessThan(source.indexOf("heading.append(actions)"));
    expect(source.indexOf('startsWith("Rename workspace")')).toBeLessThan(source.indexOf('startsWith("Add worktree")'));
  });

  // Decision F11 (2026-09-19): one sideways fork glyph, defined once on the
  // dialog module's public surface so the SPA's picker and the dashboard's
  // inlined script cannot drift apart.
  test("both dashboard fork controls draw the one shared fork icon", () => {
    const html = htmlFor.dashboard();
    expect(html).toContain("fork.innerHTML = worktreeForkIcon;");
    expect(html).toContain("action.innerHTML = worktreeForkIcon;");
    // Exactly one definition of the glyph, inside the inlined module.
    expect(html.split('viewBox="0 0 32 20"').length - 1).toBe(1);
    expect(html).toContain("M6.4 6h19.2M6.4 6.8c7 1.5 8 8.2 15 8.2h4.2");
    // The old three-node glyph is gone from every surface.
    expect(html).not.toContain("M6 7.5v9M18 7.5v1a4 4 0 0 1-4 4H6");
  });

  test("the worktree dialog module is inlined once and the dashboard groups renderer is wired to it", () => {
    const html = htmlFor.dashboard();
    expect(html).toContain("function openWorktreeDialog(");
    expect(html).toContain("function openWorktreeFork(");
    expect(html).toContain("const renderDashboardGroups = (");
    expect(html).toContain("renderDashboardGroups(dashboardWorkspaces, nodes);");
  });

  // Bug 2: a running workspace (main checkout or worktree child) must offer
  // Open, not just Stop; a stopped one keeps Start. hub-dashboard/spec.md:
  // "A stopped registered directory SHALL offer Start rather than Open; a
  // running workspace SHALL offer Open."
  test("Bug 2 a running row gets an explicit Open action alongside the openSession() the folder browser already uses", () => {
    const html = htmlFor.dashboard();
    expect(html).toContain('if (w.running) {');
    expect(html).toContain('open.setAttribute("aria-label", "Open " + workspaceLabel(w));');
    expect(html).toContain("open.onclick = () => openSession(w.id);");
    expect(html).toContain("actions.prepend(open);");
    // The availability branch (missing/replaced checkout) removes both
    // Start and this same Open action — an unreachable checkout offers
    // neither.
    expect(html).toContain('const openAction = actions.querySelector(\'[aria-label^="Open "]\'); if (openAction) openAction.remove();');
  });

  // Drive-by fix alongside Bug 2: `a.row-title` never matched row()'s
  // actual markup (an unclassed <a> nested inside a *div* with that class),
  // so a missing/replaced checkout's title link was never actually
  // defused.
  test("the missing/replaced-checkout branch defuses the real title link selector, not the always-empty a.row-title", () => {
    const html = htmlFor.dashboard();
    expect(html).toContain('node.querySelector(".row-title a")');
    expect(html).not.toContain('node.querySelector("a.row-title")');
  });
});

describe("clone page", () => {
  test("renders folder registration and prompt-capable clone controls", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    for (const id of ["browser", "clone-form", "clone-panel", "clone-output", "clone-response", "clone-cancel", "clone-folder-name"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.querySelector('#clone-response[type="password"]')).not.toBeNull();
    expect(html).toContain("folderNameInput.value.trim()");
    expect(html).toContain("{ url, dest: browsePath, folderName, start: cloneStartAfter.checked }");
    // Start after clone is explicit and defaults off; stopped completion is the norm.
    expect(document.querySelector("#clone-start-after[type=checkbox]")?.hasAttribute("checked")).toBe(false);
    expect(html).toContain("Workspace added. Start it from its folder row or the dashboard.");
    expect(html).toContain("if (workspaceId && result.running !== false) {");
    expect(html).toContain("Available for any Git or SSH prompt");
  });

  test("fetches credentials independently and preserves clone reconnect behavior", () => {
    const html = htmlFor.clone();
    expect(html).toContain("async function loadCloneCredentials()");
    expect(html).toContain("const response = await fetch(credentialPath)");
    expect(html).not.toContain("updateCloneCredentials();\n}");
    expect(html).toContain('api("/api/hub/clone-jobs"');
    expect(html).toContain('new EventSource("/api/hub/clone-jobs/"');
    expect(html).toContain("sessionStorage.getItem(cloneJobStorageKey)");
    expect(html).toContain('{ method: "HEAD" }');
    expect(html).toContain('events.addEventListener("output"');
    expect(html).toContain('events.addEventListener("phase"');
    expect(html).toContain('events.addEventListener("result"');
    expect(html).toContain("cloneOutput.textContent += text");
    expect(html).toContain('window.addEventListener("pageshow"');
    expect(html).toContain("uiBusy = cloneJobId ? 1 : 0;");
    expect(html).toContain("if (cloneJobId) connectCloneEvents();");
  });

  test("preserves credential selection, masked unlock, retention, and shared-UID warning", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    const select = document.getElementById("clone-credential") as HTMLSelectElement;
    expect(select.options[0]?.value).toBe("");
    expect(select.options[0]?.textContent).toContain("answer prompts interactively");
    expect(document.querySelector('#clone-unlock-passphrase[type="password"]')).not.toBeNull();
    expect((document.getElementById("clone-retained-auth") as HTMLSelectElement).options[0]?.textContent).toBe("None");
    expect(document.querySelector("[data-shared-uid-warning] span")?.textContent).toBe(LOCAL_CREDENTIAL_ASSIGNMENT_WARNING);
    expect(document.querySelector("[data-dismiss-shared-uid]")).not.toBeNull();
    expect(html).toContain("uatu.hub.notice.shared-uid-v1:YWxpY2U");
    expect(html).toContain("cloneCompatible");
    expect(html).toContain("isCredentialLocked(selectedCredential)");
    expect(html).toContain("request.credentialId = selectedCredential.id");
    // A requested start must not be doomed by locked retained or signing
    // credentials: they go through the masked dialog before the job is
    // created, with the already-unlocked clone credential excluded.
    expect(html).toContain("Unlock credentials to start after clone");
    expect(html).toContain('"Unlock and clone"');
    expect(html).toContain("item.id !== selectedCredential.id");
    // The clone identity is never an implicit workspace grant: nothing
    // pre-fills the retained control, so an untouched form retains nothing.
    expect(html).toContain("The clone credential is never retained on its own");
    expect(html).toContain("NEVER pre-fills this control");
    expect(html).not.toContain("cloneRetainedAuth.value = selected");
    expect(html).toContain("request.retainedAuthentication = [{ credentialId: retainedCredential.id, host: retainedHostFor(retainedCredential) }]");
    expect(html).not.toContain("retainAssignment");
    expect(html).toContain('(?:[^@/:\\s]+@)?');
    expect(html).toContain('value.startsWith("git+ssh://")');
    // HTTPS hosts are normalized like the backend before token matching.
    expect(html).toContain('parsed.hostname.endsWith(".")');
    expect(html).not.toContain("at > 0");
  });

  test("resolves the retained SSH host from the same remote spellings the server parses", () => {
    const retainedHostFor = retainedHostFunction(htmlFor.clone());
    const sshKey = { type: "ssh", metadata: {} };
    const token = { type: "token", metadata: { host: "github.example.com" } };
    // A bracketed IPv6 literal survives whole — cutting it at the first
    // colon (or falling back to github.com) would commit the retained key
    // for a host the cloned origin never presents.
    for (const remote of [
      "https://GitHub.EXAMPLE.com.:443/owner/repo.git",
      "https://github.example.com:0443/owner/repo.git",
      "git@[2001:db8::1]:owner/repo.git",
      "ssh://git@[2001:db8::1]/owner/repo.git",
      "git@github.example.com:owner/repo.git",
      "ssh://git@github.example.com/owner/repo.git",
      "git@192.0.2.10:owner/repo.git",
      "git@[github.example.com]:owner/repo.git",
    ]) {
      expect(retainedHostFor(remote, sshKey)).toBe(parseCloneRemote(remote).host!);
    }
    expect(retainedHostFor("git@[2001:db8::1]:owner/repo.git", sshKey)).toBe("[2001:db8::1]");
    expect(retainedHostFor("https://github.example.com:443/owner/repo.git", sshKey)).toBe("github.example.com:443");
    // Tokens still pin their provider host, and an unusable remote keeps
    // the existing default.
    expect(retainedHostFor("git@[2001:db8::1]:owner/repo.git", token)).toBe("github.example.com");
    expect(retainedHostFor("not a remote", sshKey)).toBe("github.com");
  });

  test("matches HTTPS clone credentials without dropping explicit default ports", () => {
    const cloneCompatible = cloneCompatibleFunction(htmlFor.clone());
    const token = (host: string) => ({ enabled: true, type: "token", capabilities: ["https-git"], metadata: { host } });
    const remote = "https://GitHub.EXAMPLE.com.:0443/owner/repo.git";
    expect(cloneCompatible(token("github.example.com:443"), "https", remote)).toBe(true);
    expect(cloneCompatible(token("github.example.com"), "https", remote)).toBe(false);
    expect(cloneCompatible(token("github.example.com"), "https", "https://github.example.com/owner/repo.git")).toBe(true);
  });

  test("keeps the submitted clone form until the job succeeds", async () => {
    const html = htmlFor.clone();
    // Accepting the job must not clear the form: the same controls are what
    // finishClone re-enables for the retry after a failed job.
    const submit = html.slice(html.indexOf("cloneForm.onsubmit"), html.indexOf("cloneResponseForm.onsubmit"));
    expect(submit).toContain("sessionStorage.setItem(cloneJobStorageKey, cloneJobId)");
    for (const cleared of [
      'input.value = ""',
      'folderNameInput.value = ""',
      'cloneDisplayName.value = ""',
      'cloneRetainedAuth.value = ""',
      'cloneSigning.value = ""',
      "cloneStartAfter.checked = false",
    ]) {
      expect(submit).not.toContain(cleared);
    }
    const buildClone = cloneFinishFunction(html);
    for (const status of ["clone-failed", "register-failed", "cleanup-failed", "start-failed", "cancelled", "timed-out"]) {
      const { form, finishClone } = buildClone();
      await finishClone({ status, error: "remote hung up" });
      expect(form.url.value).toBe("https://github.com/acme/docs.git");
      expect(form.displayName.value).toBe("Docs site");
      expect(form.credential.value).toBe("cred-token");
      expect(form.retainedAuth.value).toBe("cred-key");
      expect(form.signing.value).toBe("cred-sign");
      expect(form.startAfter.checked).toBe(true);
    }
    // Only a successful terminal result clears it, including the run that
    // navigates straight into the started session.
    for (const result of [
      { status: "succeeded", workspaceId: "ws-1", running: false },
      { status: "succeeded", workspaceId: "ws-1" },
    ]) {
      const { form, opened, finishClone } = buildClone();
      await finishClone(result);
      expect([form.url.value, form.folderName.value, form.displayName.value, form.credential.value, form.retainedAuth.value, form.signing.value]).toEqual(["", "", "", "", "", ""]);
      expect(form.startAfter.checked).toBe(false);
      expect(opened).toEqual(result.running === false ? [] : ["ws-1"]);
    }
  });

  test("renders accessible folder management controls and a prefilled rename dialog", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    for (const id of [
      "new-folder-form",
      "new-folder-name",
      "new-folder-error",
      "browser-error",
      "rename-folder-dialog",
      "rename-folder-form",
      "rename-folder-name",
      "rename-folder-error",
      "rename-folder-cancel",
      "rename-folder-submit",
    ]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.querySelector('#new-folder-name[aria-label="New folder name"]')).not.toBeNull();
    expect(document.querySelector('#rename-folder-dialog[aria-labelledby="rename-folder-title"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="alert"]').length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('input.value = name;');
    expect(html).toContain('input.select();');
    expect(html).toContain('ariaLabel: "Rename folder " + dir.name');
    expect(html).toContain('ariaLabel: "Remove folder " + dir.name');
    expect(html).toContain('Only empty folders can be removed. This cannot be undone.');
  });

  test("posts closed folder payloads and refreshes browser and workspace state", () => {
    const html = htmlFor.clone();
    expect(html).toContain('api("/api/hub/folders/create", { parent: browsePath, name })');
    expect(html).toContain('requestFolderMutation("/api/hub/folders/rename", { path: rename.folder, name })');
    expect(html).toContain('requestFolderMutation("/api/hub/folders/remove", { path: folder })');
    expect(html).toContain('loadBrowser({ fallbackToParent: true })');
    expect(html).toContain('refreshWorkspaceState().catch(() => {})');
    expect(html).toContain('response.status === 404 && browseParent');
    expect(html).toContain("another client may have renamed or removed it");
    // A configured-but-unavailable default parent silently falls back to
    // home; the page must say so before the user onboards into home.
    expect(html).toContain('id="defaults-fallback-notice"');
    expect(html).toContain("updateDefaultsFallbackNotice(state.workspaceDefaults)");
    expect(html).toContain("is currently unavailable — showing ");
    // Folder names may legitimately carry whitespace (the rename field is
    // even pre-filled with the current basename); only emptiness is judged
    // trimmed and the submitted name keeps its whitespace.
    expect(html).toContain("const name = renameFolderName.value;");
    expect(html).toContain("const name = newFolderName.value;");
    expect(html).toContain("if (!name.trim()) return;");
    expect(html).not.toContain("renameFolderName.value.trim()");
    expect(html).not.toContain("newFolderName.value.trim()");
    // Create workspace follows the same FolderName contract: trim only the
    // display label, never the directory segment the user entered.
    expect(html).toContain("folderName: createWorkspaceFolder.value,");
    expect(html).not.toContain("folderName: createWorkspaceFolder.value.trim()");
  });

  test("retries needsStop with named workspace confirmation and stop authorization", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const confirmations: string[] = [];
    const conflict = Object.assign(new Error("workspaces are running"), {
      payload: { needsStop: true, workspaceIds: ["alpha", "nested-beta"] },
    });
    const api = async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      if (calls.length === 1) throw conflict;
      return { path: "/work/team" };
    };
    const mutate = folderMutationFunction(htmlFor.clone())(api, message => {
      confirmations.push(message);
      return true;
    });

    await expect(mutate("/api/hub/folders/rename", { path: "/work/group", name: "team" })).resolves.toEqual({ path: "/work/team" });
    expect(calls).toEqual([
      { path: "/api/hub/folders/rename", body: { path: "/work/group", name: "team" } },
      { path: "/api/hub/folders/rename", body: { path: "/work/group", name: "team", stop: true } },
    ]);
    expect(confirmations[0]).toContain('"alpha", "nested-beta"');
    expect(confirmations[0]).toContain("running sessions and shells will be terminated");
  });

  test("cancelling a needsStop prompt sends no mutation retry", async () => {
    const calls: Record<string, unknown>[] = [];
    const api = async (_path: string, body: Record<string, unknown>) => {
      calls.push(body);
      throw Object.assign(new Error("workspace is running"), {
        payload: { needsStop: true, workspaceIds: ["alpha"] },
      });
    };
    const mutate = folderMutationFunction(htmlFor.clone())(api, () => false);

    await expect(mutate("/api/hub/folders/remove", { path: "/work/alpha" })).resolves.toBeNull();
    expect(calls).toEqual([{ path: "/work/alpha" }]);
  });

  test("keeps folder controls busy through retry and exposes local actionable errors", () => {
    const html = htmlFor.clone();
    expect(html).toContain('await withBusy(button, "Creating…"');
    expect(html).toContain('await withBusy(rename.button, "Renaming…"');
    expect(html).toContain('await withBusy(button, "Removing…"');
    expect(html).toContain('Could not create "');
    expect(html).toContain('Could not rename "');
    expect(html).toContain('Could not remove "');
    expect(html).toContain('if (!result) return;');
    expect(html).toContain('renameFolderSubmit.disabled = true;');
    expect(html).toContain('if (renameFolderSubmit.disabled)');
    expect(html).toContain('event.preventDefault();');
    expect(html).toContain('.folder-browser .row { flex-wrap: wrap; }');
    expect(html).toContain('.folder-browser .row-actions { flex: 1 0 100%; justify-content: flex-end; }');
  });
});

describe("add workspace page", () => {
  test("labels the page Add workspace and organizes three entry modes", () => {
    const html = htmlFor.clone();
    expect(html).toContain("Add workspace</a>");
    expect(html).toContain("UatuCode Hub — Add workspace");
    expect(html).toContain("<h2>Add workspace</h2>");
    expect(html).toContain("Create a new workspace, pick an existing folder below, or clone a repository.");
    const document = documentFor("clone");
    expect(document.getElementById("create-workspace-open")).not.toBeNull();
    expect(document.getElementById("add-workspace-dialog")).not.toBeNull();
    expect(document.getElementById("clone-form")).not.toBeNull();
  });

  test("the existing-folder dialog carries name, path, credentials, and both add actions", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    for (const id of [
      "add-workspace-path", "add-workspace-name", "add-workspace-auth", "add-workspace-host",
      "add-workspace-signing", "add-workspace-error", "add-workspace-cancel", "add-workspace-start", "add-workspace-submit",
    ]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.querySelector('#add-workspace-dialog[aria-labelledby="add-workspace-title"]')).not.toBeNull();
    expect(document.getElementById("add-workspace-submit")?.textContent).toBe("Add workspace");
    expect(document.getElementById("add-workspace-start")?.textContent).toBe("Add and start");
    // The display name prefills from the folder basename and stays editable.
    expect(html).toContain("addWorkspaceName.value = name;");
    expect(html).toContain("addWorkspaceName.select();");
    // The commit is stopped-by-default; Add-and-start carries the explicit
    // start intent through the same lifecycle-protected request (after the
    // masked unlock for locked selected credentials) — a separate start
    // after the commit could target an entry another client already forgot.
    expect(html).toContain('api("/api/hub/workspaces/configure", request)');
    expect(html).toContain("if (start) request.start = true;");
    expect(html).toContain("submitAddWorkspace(true)");
    expect(html).toContain("Unlock credentials to start the workspace");
    expect(html).toContain("openSession(result.workspace.id)");
    expect(html).toContain("result.recoveryRequired");
    // Cancellation is mutation-free and errors preserve the form.
    expect(html).toContain("Cancellation is mutation-free: nothing was sent.");
    expect(html).toContain("setLocalError(addWorkspaceError, error.message)");
  });

  test("the create-workspace dialog links names until edited and reports retained folders", () => {
    const html = htmlFor.clone();
    const document = documentFor("clone");
    for (const id of [
      "create-workspace-parent", "create-workspace-folder", "create-workspace-name",
      "create-workspace-auth", "create-workspace-signing", "create-workspace-error", "create-workspace-submit",
    ]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(html).toContain("if (createNameLinked) createWorkspaceName.value = createWorkspaceFolder.value;");
    expect(html).toContain('api("/api/hub/workspaces/create"');
    expect(html).toContain("Creates the folder, runs git init, and adds the workspace stopped.");
    expect(html).toContain('Use "Add workspace" on the retained folder to finish adding it.');
    expect(html).toContain("setCreateWorkspaceBusy(true)");
  });

  test("browser rows are lifecycle-aware with display-name detail", () => {
    const html = htmlFor.clone();
    expect(html).toContain('label: "Open"');
    expect(html).toContain('label: "Start"');
    expect(html).toContain('label: "Add workspace"');
    expect(html).toContain('dir.running ? "running" : "stopped"');
    expect(html).toContain("'workspace \"' + dir.displayName + '\"'");
  });
});

describe("settings page", () => {
  test("manages the default workspace parent with fallback explanation", () => {
    const html = htmlFor.settings();
    const document = documentFor("settings");
    for (const id of ["workspace-defaults-form", "workspace-defaults-parent", "workspace-defaults-clear", "workspace-defaults-status", "workspace-defaults-error"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(html).toContain('api("/api/hub/settings/workspace-defaults", { defaultWorkspaceParent: value })');
    expect(html).toContain('api("/api/hub/settings/workspace-defaults", { defaultWorkspaceParent: null })');
    expect(html).toContain("const value = input.value;");
    expect(html).toContain("if (!value.trim())");
    expect(html).not.toContain("const value = input.value.trim()");
    expect(html).toContain("is currently unavailable; onboarding falls back to");
    expect(html).toContain("Workspaces can still be added from anywhere.");
  });

  test("shares the dismissible shared-UID advisory with clone", () => {
    const alice = htmlFor.settings();
    const bob = settingsPage("bob");
    expect(alice).toContain("uatu.hub.notice.shared-uid-v1:YWxpY2U");
    expect(htmlFor.clone()).toContain("uatu.hub.notice.shared-uid-v1:YWxpY2U");
    expect(bob).toContain("uatu.hub.notice.shared-uid-v1:Ym9i");
    expect(settingsPage('</script><script id="injected">')).not.toContain('<script id="injected">');
    expect(loginPage()).not.toContain("shared-uid-v1");
  });

  test("renders masked credential forms, tools, assignments, and devices", () => {
    const html = htmlFor.settings();
    const document = documentFor("settings");
    for (const id of ["ssh-generate-form", "ssh-import-form", "openpgp-generate-form", "openpgp-import-form", "token-form", "credentials-pane", "credential-tools", "devices"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    const secrets = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    expect(secrets.every(input => input.value === "" && !input.hasAttribute("value"))).toBe(true);
    expect([...document.querySelectorAll("textarea")].every(input => input.textContent === "")).toBe(true);
    expect(document.querySelector('#ssh-import-form input[type="file"][name="privateKeyFile"]')).not.toBeNull();
    expect(document.querySelector("#ssh-import-form .paste-option textarea[name=privateKey]")).not.toBeNull();
    for (const id of ["ssh-private-key", "openpgp-private-key"]) {
      expect(document.querySelector(`#${id}.secret-paste-masked`)).not.toBeNull();
      const reveal = document.querySelector(`[data-reveal-secret="${id}"]`);
      expect(reveal?.textContent).toBe("Reveal");
      expect(reveal?.getAttribute("aria-controls")).toBe(id);
      expect(reveal?.getAttribute("aria-pressed")).toBe("false");
    }
    expect(document.getElementById("workspace-credential-assignments")).not.toBeNull();
    expect(document.querySelector("details.workspace-credential-section")?.hasAttribute("open")).toBe(false);
    expect(document.querySelectorAll("[data-form-error][role=alert]").length).toBe(5);
    expect(html).toContain("Copy public key");
    expect(html).toContain('else if (credential.type === "ssh")');
    expect(document.querySelector("[data-shared-uid-warning] span")?.textContent).toBe(LOCAL_CREDENTIAL_ASSIGNMENT_WARNING);
  });

  test("credential card raises the restart notice on a running row whose policy owner the assignment names", () => {
    const parent = { id: "repo", displayName: "Repo", credentialAssignments: { authentication: [], signing: [] } };
    const child = {
      id: "child", parentId: "repo", branch: "feature/x", credentialRestartRequired: true,
      credentialAssignments: { authentication: [], signing: [] },
    };
    const credential = {
      id: "token-a", name: "Parent token", type: "token", enabled: true, capabilities: ["https-git"],
      metadata: { host: "github.com" },
      readiness: [{ layer: "credential", status: "ready", message: "The token credential is available." }],
      assignments: [{ workspaceId: "repo", credentialId: "token-a", role: "authentication", host: "github.com" }],
    };
    const notice = (workspaces: unknown[]) => {
      const card = credentialCardHarness(workspaces)(credential);
      return card.querySelector(".restart-required")?.textContent ?? null;
    };
    // The server flags the RUNNING child; the assignment names its parent.
    expect(notice([parent, child])).toContain("Restart required: assignment changes apply fully");
    // A flagged row governed by some other policy owner, and an unflagged
    // child, both leave the card quiet.
    expect(notice([parent, { ...child, parentId: "elsewhere" }])).toBeNull();
    expect(notice([parent, { ...child, credentialRestartRequired: false }])).toBeNull();
  });

  test("preserves lifecycle actions, tool probes, and responsive controls", () => {
    const html = htmlFor.settings();
    for (const action of ["unlock", "lock", "enable", "disable", "assign", "unassign", "test", "delete"]) {
      expect(html).toContain(action);
    }
    expect(html).toContain('confirm(\'Delete credential "\'');
    expect(html).toContain("{ confirm: true, unassign: assigned }");
    expect(html).toContain("Disabling this provider CLI token may stop running workspaces that still use it and terminate their shells.");
    expect(html).toContain("This may stop running workspaces that still use the token and terminate their shells.");
    expect(html).toContain('toolPath + "/" + encodeURIComponent(tool.tool) + "/test"');
    expect(html).toContain('const card = el("details", "credential-card")');
    expect(html).toContain("openCredentialIds.has(credential.id)");
    expect(html).toContain("Assign selected");
    expect(html).toContain("Selected credentials replace the current defaults");
    expect(html).toContain('"/credential-assignments"');
    expect(html).toContain("authentication: { credentialId: authentication.value");
    expect(html).not.toContain("authenticationAssigned");
    expect(html).not.toContain("previousAuthentication");
    expect(html).toContain('host.disabled = !selected');
    expect(html).toContain('value === "github-cli" || value === "gitlab-cli"');
    expect(html).toContain("Authentication host");
    expect(html).toContain("No workspace credentials assigned.");
    expect(html).toContain("workspaceAssignmentEntries");
    expect(html).toContain("removeWorkspaceAssignment(entry, workspace, remove, actionError)");
    expect(html).toContain('{ host: entry.assignment.host }');
    expect(html).toContain("Stop it and remove its");
    expect(html).toContain("Its shells will be terminated.");
    // Stop-and-remove is one request: the server runs the unassignment
    // inside the stop lifecycle instead of the page issuing two racy POSTs.
    expect(html).toContain('role: entry.assignment.role, stop: true');
    expect(html).not.toContain('/sessions/" + encodeURIComponent(workspace.id) + "/stop');
    expect(html).not.toContain("Continue with this assignment?");
    expect(html).toContain("Choose exactly one private key source");
    expect(html).toContain("file.size > 1024 * 1024");
    expect(html).toContain("const body = await buildBody(data, form)");
    expect(html).toContain('classList.toggle("secret-paste-masked")');
    expect(html).toContain('input[type="file"]');
    expect(html).toContain('toolError.setAttribute("role", "alert")');
    expect(html).not.toContain('showError("")');
    expect(html).toContain("@media (max-width: 520px)");
    expect(html).not.toMatch(/least[- ]privilege|credential isolation|isolated credential/i);
  });
});

describe("stopped session page", () => {
  test("titles by display name and offers Start and Configure for registered workspaces", () => {
    const html = stoppedSessionPage("payments-service", true, "Payments API");
    expect(html).toContain("<strong>Payments API</strong>");
    expect(html).toContain('id="stopped-start"');
    expect(html).toContain(">Configure</a>");
    expect(html).toContain('"/api/hub/sessions/payments-service/start"');
    expect(html).not.toContain("<strong>payments-service</strong>");
    // A locked-credential rejection routes to the dashboard's masked
    // unlock flow instead of dead-ending on this page.
    expect(html).toContain("/locked|unlock/i.test(error.message)");
    expect(html).toContain('location.href = "/"');
  });

  test("an unregistered id only links back to the dashboard", () => {
    const html = stoppedSessionPage("gone", false);
    expect(html).toContain("<strong>gone</strong>");
    expect(html).not.toContain('id="stopped-start"');
    expect(html).toContain('href="/"');
  });

  test("escapes display names and ids", () => {
    const html = stoppedSessionPage("x", true, "<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

// Item D: the worktree confirmation is rendered by the inlined dialog module
// on the dashboard exactly as in the SPA, so the Hub's own pages must define
// the success tint it uses — otherwise the dashboard falls back to a literal
// light green in dark mode.
describe("the Hub's shared style carries the success palette the confirmation uses", () => {
  test("--success-soft and --success-strong are defined for both colour schemes", () => {
    const html = htmlFor.dashboard();
    expect(html).toContain("--success-soft: light-dark(#dafbe1, #12261e);");
    expect(html).toContain("--success-strong: light-dark(#1a7f37, #3fb950);");
    expect(html).toContain("background:var(--success-soft,#dafbe1)");
  });
});
