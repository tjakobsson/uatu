import { afterAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { ChatApiClient } from "./client";
import type { RevealOptions } from "./coordinated-scroll";
import { resetUsagePaneForTests } from "./usage-pane";
import type { ChatCommand, ChatModel, ConversationSnapshot, ReversibleHistoryResult } from "./types";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
const savedGlobals = new Map<string, unknown>();
const CHILD_PROCESS_FLAG = "UATU_CHAT_UI_TEST_CHILD";

if (process.env[CHILD_PROCESS_FLAG] !== "1") {
  describe("chat reversible-history composer", () => {
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
      // The child runs this whole file, including a case that waits on the
      // surface's one-second clock and two that wait out the output view's
      // four-second retry; the default five seconds leaves it no room, and a
      // timeout here reports as the wrong test failing.
    }, 60_000);
  });
} else {
describe("chat reversible-history composer", () => {
  test("touch surface return consumes fresh work capacity before deciding physical overflow", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const surface = document.querySelector<HTMLElement>(".chat-surface")!;
    const dock = document.querySelector<HTMLElement>("#chat-work-dock")!;
    let visible = true, height = 788;
    Object.defineProperty(surface, "clientHeight", { configurable: true, get: () => visible ? height : 0 });
    Object.defineProperty(surface, "clientWidth", { configurable: true, value: 390 });
    for (const [selector, pixels] of [[".chat-header", 80], ["#chat-composer", 124]] as const) {
      document.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => ({ height: visible ? pixels : 0 }) as DOMRect;
    }
    const previousStyle = Reflect.get(globalThis, "getComputedStyle");
    const previousObserver = Reflect.get(globalThis, "ResizeObserver");
    const observers: Array<{ targets: Element[]; resize(): void }> = [];
    Reflect.set(globalThis, "getComputedStyle", (node: HTMLElement) => ({
      display: node.hidden ? "none" : "block", position: "static", fontSize: "16px",
      paddingTop: node === dock ? "2px" : "0px", paddingBottom: node === dock ? "2px" : "0px",
      getPropertyValue: () => "0px",
    }));
    Reflect.set(globalThis, "ResizeObserver", class {
      targets: Element[] = [];
      constructor(readonly resize: () => void) { observers.push(this); }
      observe(node: Element) { this.targets.push(node); }
      disconnect() {}
    });
    const { initChat } = await import(`./ui.ts?touch-capacity-return=${Date.now()}`);
    try {
      initChat(questionApi(document, { items: () => [] }));
      await waitUntil(() => document.querySelector('option[value="one"]') !== null);
      const layout = observers.find(observer => observer.targets.includes(dock))!;
      expect(layout).toBeDefined();
      layout.resize();
      expect(surface.hasAttribute("data-work-overflow")).toBe(false);
      visible = false;
      document.documentElement.setAttribute("data-active-tab", "preview");
      layout.resize();
      expect(dock.style.getPropertyValue("--chat-work-hard-available")).toBe("0px");
      visible = true;
      document.documentElement.setAttribute("data-active-tab", "chat");
      // No extra observer notification is guaranteed after these writes.
      layout.resize();
      expect(dock.style.getPropertyValue("--chat-work-hard-available")).toBe("584px");
      expect(surface.hasAttribute("data-work-overflow")).toBe(false);
      expect(dock.hasAttribute("data-work-cramped")).toBe(false);
      // Conversely, a genuinely too-small band must still enter native outer
      // scrolling on the first measurement, not retain the old large capacity.
      height = 100;
      layout.resize();
      expect(surface.hasAttribute("data-work-overflow")).toBe(true);
    } finally {
      window.dispatchEvent(new window.Event("pagehide"));
      Reflect.set(globalThis, "getComputedStyle", previousStyle);
      Reflect.set(globalThis, "ResizeObserver", previousObserver);
    }
  });
  for (const status of ["running", "idle"] as const) test(`held command paths retain ${status} steering controls while actual commands do not`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const entries = ["/build", "/build notes", "/build/notes.md", "/unknown", "/Build", "/provider:build notes"];
    const api = {
      status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["commands", "steering", "send-now"] } } }],
      conversations: async () => [conversation("one")],
      commands: async () => ["build", "provider:build"].map(name => ({ name, description: name, argumentHint: "", kind: "command" })),
      models: async () => [], modes: async () => [],
      snapshot: async () => ({ ...snapshot("one"), conversation: { ...conversation("one"), status }, queued: entries.map((text, index) => ({ id: `held-${index}`, text, queuedAt: 1, delivery: "queue" })) }),
      stream: () => ({ close() {} }), inventoryStream: () => ({ close() {} }), attachmentUrl: () => "",
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?command-path-controls=${Date.now()}`);
    initChat(api);
    try {
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      await waitUntil(() => select.querySelector('option[value="one"]') !== null);
      select.value = "one";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      const action = status === "running" ? "steer" : "send-now";
      await waitUntil(() => document.querySelector(`[data-queue-${action}="held-3"]`) !== null);
      await waitUntil(() => document.querySelector(`[data-queue-${action}="held-0"]`) === null);
      for (const [index, expected] of [false, false, true, true, true, false].entries()) {
        expect(!!document.querySelector(`[data-queue-${action}="held-${index}"]`), entries[index]).toBe(expected);
      }
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });
  for (const outcome of ["lost", "invalid-json", "missing-ack", "gateway", "unknown", "refused-400", "refused-409", "path-lost", "command-refused", "queue-500"] as const) test(`standalone busy input preserves ${outcome} without replay or draft loss`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const { ChatApiClient } = await import("./client");
    const response = deferred<Response>();
    let calls = 0, reads = 0, requestId = "", delivery: unknown;
    const transport = new ChatApiClient(async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      requestId = body.requestId; delivery = body.delivery;
      return response.promise;
    });
    const running = { ...conversation("one"), status: "running" as const };
    const api = {
      status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["commands", "steering", "background-blocking-work"] } } }],
      conversations: async () => [running], commands: async () => [{ name: "build", description: "Build", argumentHint: "", kind: "command" }], models: async () => [], modes: async () => [],
      snapshot: async () => { reads++; return { ...snapshot("one"), conversation: running }; },
      prompt: transport.prompt.bind(transport), stream: () => ({ close() {} }), inventoryStream: () => ({ close() {} }), attachmentUrl: () => "",
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?standalone-loss=${outcome}-${Date.now()}`);
    initChat(api);
    try {
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      await waitUntil(() => select.querySelector('option[value="one"]') !== null);
      select.value = "one";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      await waitUntil(() => !input.disabled && reads > 0);
      const text = outcome === "path-lost" ? "/build/notes.md" : outcome === "command-refused" ? "/build notes" : "Original steer A";
      input.value = text;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      if (outcome === "path-lost") expect(document.querySelector("#chat-send")!.getAttribute("aria-label")).toContain("steer");
      const before = reads;
      const event = new window.Event("submit", { bubbles: true, cancelable: true });
      // Exercise explicit Queue, not the retired stored keyboard default.
      if (outcome === "queue-500") {
        const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
        form.requestSubmit = () => { form.dispatchEvent(event); };
        input.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter", altKey: true }));
      } else document.querySelector("#chat-composer")!.dispatchEvent(event);
      await waitUntil(() => calls === 1);
      input.value = "New draft C";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      const refused = outcome.startsWith("refused") || outcome === "command-refused" || outcome === "queue-500";
      if (outcome === "lost" || outcome === "path-lost") response.reject(new TypeError("Failed to fetch"));
      else if (outcome === "invalid-json") response.resolve(new Response("not json", { status: 202 }));
      else if (outcome === "missing-ack") response.resolve(Response.json({}, { status: 202 }));
      else response.resolve(Response.json({ error: "Refused or unknown", ...(outcome === "unknown" ? { code: "operation_outcome_unknown" } : {}) }, { status: outcome === "gateway" ? 502 : outcome === "queue-500" ? 500 : outcome === "refused-400" ? 400 : 409 }));
      await waitUntil(() => refused ? document.querySelector("#chat-composer-error")!.textContent!.includes("Draft restored") : document.querySelector("#chat-action-feedback")!.textContent!.includes("Status checked"));
      expect(document.querySelector('meta[name="uatu-hub"]')).toBeNull();
      expect(delivery).toBe(outcome === "queue-500" ? "queue" : "steer");
      if (refused) {
        expect(input.value).toBe(`${text}\nNew draft C`);
        expect(reads).toBe(before);
        expect(document.querySelector("#chat-action-feedback")!.textContent).not.toContain("unconfirmed");
      } else {
        expect(input.value).toBe("New draft C");
        expect(document.querySelector("#chat-composer-error")!.textContent).not.toContain("Draft restored");
        const feedback = document.querySelector("#chat-action-feedback")!.textContent!;
        expect(feedback).toContain(text);
        expect(feedback).toContain(requestId);
        expect(feedback).toContain("acceptance still unconfirmed");
        expect(reads).toBe(before + 1);
        await waitUntil(() => document.querySelector("#chat-items")!.textContent!.includes("Acceptance unconfirmed"));
      }
      window.dispatchEvent(new window.Event("online"));
      await Promise.resolve();
      expect(calls).toBe(1);
    } finally {
      const { presentationLocalStorage } = await import("../shell/presentation-storage");
      presentationLocalStorage()?.removeItem("chat-delivery");
      window.dispatchEvent(new window.Event("pagehide"));
    }
  });
  for (const firstOutcome of ["steer", "rejected", "unknown", "forced-steer", "queue-with-new-stage"] as const) test(`staged model survives ${firstOutcome} and the next queue uses it`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    const { presentationLocalStorage } = await import("../shell/presentation-storage");
    const storage = presentationLocalStorage();
    storage?.setItem("chat-delivery", firstOutcome === "forced-steer" || firstOutcome === "queue-with-new-stage" ? "queue" : "steer");
    const model = (name: string): ChatModel => ({ selection: { providerId: "test", modelId: name }, provider: "Test", name });
    const a = model("A"), b = model("B"), c = model("C");
    const calls: Array<{ model: unknown; delivery: unknown }> = [];
    const first = deferred<Awaited<ReturnType<ChatApiClient["prompt"]>>>();
    let parent: Parameters<ChatApiClient["stream"]>[2] | undefined;
    const api = {
      status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["models", "steering"] } } }],
      conversations: async () => [{ ...conversation("one"), status: "running" }], commands: async () => [], models: async () => [a, b, c], modes: async () => [],
      snapshot: async () => ({ ...snapshot("one"), configuration: { model: a.selection }, conversation: { ...conversation("one"), status: "running" } }),
      prompt: async (_id: string, _request: string, _text: string, selection: unknown, _mode: unknown, _variant: unknown, _attachments: unknown, delivery: unknown) => {
        calls.push({ model: selection, delivery });
        return calls.length === 1 ? first.promise : { messageId: `queued-${calls.length}`, pending: true, delivery: "queue", configuration: { model: selection } };
      },
      stream: (_id: string, _cursor: string, handlers: Parameters<ChatApiClient["stream"]>[2]) => { parent = handlers; return { close() {} }; }, inventoryStream: () => ({ close() {} }), attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?staged-steer=${firstOutcome}-${Date.now()}`);
    initChat(api);
    try {
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      await waitUntil(() => !input.disabled && document.querySelector('[data-model-value="test/B"]') !== null);
      const stage = (name: string) => document.querySelector(`[data-model-value="test/${name}"]`)!.dispatchEvent(new window.Event("click", { bubbles: true }));
      const submit = (text: string, queue = false) => {
        input.value = text;
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
        const send = () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); };
        if (queue) {
          form.requestSubmit = send;
          input.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter", altKey: true }));
        } else send();
      };
      const scope = document.querySelector<HTMLElement>("#chat-configuration-scope")!;
      const trigger = document.querySelector<HTMLButtonElement>("#chat-configuration-trigger")!;
      expect(scope.hidden).toBe(true);
      stage("B");
      expect(scope.hidden).toBe(false);
      expect(scope.textContent).toBe("Steers keep the active turn’s settings. Changes apply to queued or new turns.");
      expect(trigger.getAttribute("aria-label")).toContain("Next turn. Model: B");
      expect(document.querySelector("#chat-send")!.getAttribute("aria-describedby")).toBe("chat-send-help chat-configuration-scope");
      submit("First");
      await waitUntil(() => calls.length === 1);
      expect(calls[0]!.model).toEqual(b.selection);
      if (firstOutcome === "queue-with-new-stage") stage("C");
      if (firstOutcome === "unknown") {
        const { ChatTransportError } = await import("./client");
        first.reject(new ChatTransportError("Operation outcome unknown", 409, "operation_outcome_unknown"));
      } else if (firstOutcome === "rejected") first.reject(new Error("Steer refused"));
      else first.resolve({ messageId: "first", pending: true, delivery: firstOutcome === "queue-with-new-stage" ? "queue" : "steer", configuration: { model: firstOutcome === "queue-with-new-stage" ? b.selection : a.selection } });
      await waitUntil(() => firstOutcome === "rejected"
        ? document.querySelector("#chat-composer-error")!.textContent!.includes("Draft restored")
        : firstOutcome === "unknown" ? document.querySelector("#chat-action-feedback")!.textContent!.includes("unconfirmed")
        : document.querySelector("#chat-queue")!.textContent!.includes("First"));
      const next = firstOutcome === "queue-with-new-stage" ? c : b;
      expect(document.querySelector(`[data-model-value="test/${next.name}"]`)!.getAttribute("aria-pressed")).toBe("true");
      expect(scope.hidden).toBe(false);
      storage?.setItem("chat-delivery", "queue");
      submit("Next queued work", true);
      await waitUntil(() => calls.length === 2);
      expect(calls[1]).toEqual({ model: next.selection, delivery: "queue" });
      await waitUntil(() => document.querySelector("#chat-queue")!.textContent!.includes("Next queued work"));
      // A queue consumes that stage once: a later authoritative config is
      // visible, not masked forever by the just-submitted staged selection.
      parent!.event({ type: "conversation.configuration", generation: "g", sequence: 1, conversationId: "one", configuration: { model: a.selection } }, "cursor-one-1");
      expect(document.querySelector('[data-model-value="test/A"]')!.getAttribute("aria-pressed")).toBe("true");
      expect(scope.hidden).toBe(true);
      expect(document.querySelector("#chat-send")!.getAttribute("aria-describedby")).toBe("chat-send-help");
      submit("Third queued work", true);
      await waitUntil(() => calls.length === 3);
      expect(calls[2]).toEqual({ model: a.selection, delivery: "queue" });
    } finally {
      storage?.removeItem("chat-delivery");
      window.dispatchEvent(new window.Event("pagehide"));
    }
  });

  for (const scenario of ["mode", "reasoning", "unknown", "idle", "unsupported"] as const) test(`configuration scope explains ${scenario} without inventing active settings`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const model: ChatModel = { selection: { providerId: "test", modelId: "model" }, provider: "Test", name: "Model", variants: ["low", "high"] };
    const configuration = scenario === "unknown" ? {} : { model: model.selection, mode: "build", variant: "low" };
    const status = scenario === "idle" ? "idle" : "running";
    let parent: Parameters<ChatApiClient["stream"]>[2] | undefined;
    const api = {
      status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["models", "modes", "variants", ...(scenario === "unsupported" ? [] : ["steering"])] } } }],
      conversations: async () => [{ ...conversation("one"), status }], commands: async () => [], models: async () => [model],
      modes: async () => [{ name: "build", description: "Build" }, { name: "plan", description: "Plan" }],
      snapshot: async () => ({ ...snapshot("one"), configuration, conversation: { ...conversation("one"), status } }),
      stream: (_id: string, _cursor: string, handlers: Parameters<ChatApiClient["stream"]>[2]) => { parent = handlers; return { close() {} }; },
      inventoryStream: () => ({ close() {} }), attachmentUrl: () => "",
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?configuration-scope=${scenario}-${Date.now()}`);
    initChat(api);
    try {
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      await waitUntil(() => !input.disabled && !!parent);
      const scope = document.querySelector<HTMLElement>("#chat-configuration-scope")!;
      const trigger = document.querySelector<HTMLButtonElement>("#chat-configuration-trigger")!;
      expect(scope.hidden).toBe(true);
      const control = document.querySelector<HTMLSelectElement>(scenario === "reasoning" ? "#chat-configuration-variant" : "#chat-configuration-mode")!;
      // Linkedom exposes select.value as read-only, unlike a browser.
      Object.defineProperty(control, "value", { configurable: true, value: scenario === "reasoning" ? "high" : "plan" });
      control.dispatchEvent(new window.Event("change", { bubbles: true }));
      const steering = scenario !== "idle" && scenario !== "unsupported";
      expect(scope.hidden).toBe(!steering);
      expect(trigger.getAttribute("aria-label")!.includes("Next turn")).toBe(steering);
      expect(trigger.getAttribute("aria-label")).toContain(scenario === "reasoning" ? "Reasoning: High" : "Mode: Plan");
      if (scenario === "unknown") {
        expect(trigger.getAttribute("aria-label")).toContain("Model: chosen by Test");
        expect(scope.textContent).not.toContain("Build");
      }
      // A remote equal configuration hides the extra explanation without
      // clearing the local choice or implying it retargeted a running turn.
      parent!.event({ type: "conversation.configuration", generation: "g", sequence: 1, conversationId: "one", configuration: { ...configuration, ...(scenario === "reasoning" ? { variant: "high" } : { mode: "plan" }) } }, "cursor-one-1");
      expect(scope.hidden).toBe(true);
      parent!.event({ type: "conversation.status", generation: "g", sequence: 2, conversationId: "one", status: "completed" }, "cursor-one-2");
      await waitUntil(() => !trigger.getAttribute("aria-label")!.includes("Next turn"));
      expect(trigger.getAttribute("aria-label")).not.toContain("Next turn");
      expect(trigger.getAttribute("aria-label")).toContain(scenario === "reasoning" ? "Reasoning: High" : "Mode: Plan");
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });

  for (const scenario of ["held", "absent", "failed-read", "incomplete-read", "edit", "steer", "queue", "delivered-code", "early-terminal", "read-terminal", "switched", "read-switched", "withdrawal-retry"] as const) {
    const name = `pending refusal reconciles ${scenario}`;
    test(name, async () => {
      if (process.env.UATU_PENDING_REFUSAL_CASE !== "1") {
        const child = Bun.spawn({ cmd: [process.execPath, "test", import.meta.path, "-t", `${name}$`], env: { ...process.env, UATU_PENDING_REFUSAL_CASE: "1" }, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        return;
      }
      const { document, window } = parseHTML(html);
      installDomGlobals(document, window);
      document.documentElement.setAttribute("data-ui-mode", "desktop");
      document.documentElement.setAttribute("data-chat-panel", "open");
      stubConversationSelect(document);
      const { ChatApiClient } = await import("./client");
      const response = deferred<Response>(), recovery = deferred<ConversationSnapshot>();
      const retry = scenario === "withdrawal-retry";
      const action = retry ? "remove" : ["edit", "steer", "queue"].includes(scenario) ? scenario : "send-now";
      const entry = { id: "native-original", text: "Still owned pending input", queuedAt: 1, delivery: scenario === "queue" || retry ? "steer" as const : "queue" as const, paused: true as const };
      let mutations = 0, reads = 0;
      const requests: string[] = [];
      const transport = new ChatApiClient(async (url) => {
        mutations++; requests.push(String(url));
        if (retry && mutations === 1) return Response.json({ error: "Withdrawal unknown", code: "steer-withdrawal-unconfirmed" }, { status: 409 });
        return response.promise;
      });
      let events: Parameters<ChatApiClient["stream"]>[2];
      const api = {
        status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["steering", "send-now"] } } }],
        conversations: async () => [conversation("one"), conversation("two")], commands: async () => [], models: async () => [], modes: async () => [],
        snapshot: async (id: string) => {
          reads++;
          if (id === "two") return { ...snapshot(id), queued: [{ ...entry, text: "Other pending input" }] };
          if (retry && mutations === 1) return { ...snapshot(id), queued: [] };
          return mutations ? recovery.promise : { ...snapshot(id), conversation: { ...conversation(id), status: scenario === "steer" ? "running" : "idle" }, queued: [entry] };
        },
        sendNow: transport.sendNow.bind(transport), removeQueued: transport.removeQueued.bind(transport), changeDelivery: transport.changeDelivery.bind(transport),
        stream: (_id: string, _cursor: string, handlers: typeof events) => { events = handlers; return { close() {} }; }, inventoryStream: () => ({ close() {} }), attachmentUrl: () => "",
      } as unknown as ChatApiClient;
      const { initChat } = await import(`./ui.ts?pending-refusal=${scenario}-${Date.now()}`);
      initChat(api);
      try {
        const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
        await waitUntil(() => !!document.querySelector(`[data-queue-${action}="native-original"]`));
        input.value = "Private draft";
        const click = () => {
          const target = document.querySelector<HTMLButtonElement>(`[data-queue-${action}="native-original"]`)!;
          target.dispatchEvent(new window.Event("click", { bubbles: true }));
          return target;
        };
        if (retry) {
          click();
          await waitUntil(() => document.querySelector('[data-queue-remove="native-original"]')?.textContent === "Retry withdrawal" && !document.querySelector<HTMLButtonElement>('[data-queue-remove="native-original"]')!.disabled);
        }
        const before = reads, expectedMutations = retry ? 2 : 1;
        const target = click();
        await waitUntil(() => mutations === expectedMutations);
        const terminal = () => events!.event({ type: "conversation.queue", generation: "g", sequence: 1, conversationId: "one", queued: [], change: { kind: "delivered", messageId: entry.id } }, "cursor-terminal");
        const switchConversation = async () => {
          const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
          select.value = "two"; select.dispatchEvent(new window.Event("change", { bubbles: true }));
          await waitUntil(() => !!document.querySelector('[data-chat-queued-id="native-original"]')?.textContent?.includes("Other pending input"));
          input.value = "Other draft";
        };
        if (scenario === "early-terminal") terminal();
        if (scenario === "switched") await switchConversation();
        response.resolve(Response.json({ error: "Send now is unavailable while a turn is running", ...(scenario === "delivered-code" ? { code: "steer-already-delivered" } : {}) }, { status: 409 }));
        const noRead = ["delivered-code", "early-terminal", "switched"].includes(scenario);
        if (!noRead) {
          await waitUntil(() => reads === before + 1);
          await flush();
          expect(target.disabled).toBe(true);
          document.querySelector(`[data-queue-${action}="native-original"]`)?.dispatchEvent(new window.Event("click", { bubbles: true }));
          expect(mutations).toBe(expectedMutations);
          if (scenario === "read-terminal") terminal();
          if (scenario === "read-switched") await switchConversation();
          if (scenario === "failed-read") recovery.reject(new Error("Read unavailable"));
          else recovery.resolve({ ...snapshot("one"), ...(scenario === "incomplete-read" ? {} : { queued: scenario === "absent" || retry ? [] : [entry] }) });
        }
        await waitUntil(() => !target.disabled);
        await flush();
        const switched = scenario === "switched" || scenario === "read-switched";
        const departed = ["absent", "delivered-code", "early-terminal", "read-terminal"].includes(scenario);
        const row = document.querySelector('[data-chat-queued-id="native-original"]');
        expect(!!row).toBe(!departed);
        expect(input.value).toBe(switched ? "Other draft" : "Private draft");
        expect(mutations).toBe(expectedMutations);
        if (switched) {
          expect(row!.textContent).toContain("Other pending input");
          expect(document.querySelector("#chat-composer-error")!.textContent).toBe("");
          expect(document.querySelector("#chat-state")!.textContent).not.toContain("unavailable");
        } else if (scenario !== "early-terminal") {
          expect(document.querySelector("#chat-composer-error")!.textContent).toContain(scenario === "delivered-code" ? "already delivered" : "unavailable");
          if (!departed) {
            expect(document.querySelector<HTMLButtonElement>('[data-queue-remove="native-original"]')!.disabled).toBe(false);
            if (retry) {
              expect(requests[1]).toBe(requests[0]);
              expect(document.querySelector('[data-queue-remove="native-original"]')!.textContent).toBe("Retry withdrawal");
              expect(document.querySelector('[data-queue-edit="native-original"]')).toBeNull();
            } else expect(document.querySelector<HTMLButtonElement>('[data-queue-edit="native-original"]')!.disabled).toBe(false);
          }
          if (scenario === "failed-read" || scenario === "incomplete-read") expect(document.querySelector("#chat-composer-error")!.textContent).toContain("could not be checked");
          // Routine stream/status paints must not erase the refusal.
          events!.event({ type: "conversation.status", generation: "g", sequence: scenario === "read-terminal" ? 2 : 1, conversationId: "one", status: "idle" }, "cursor-status");
          await flush();
          expect(document.querySelector("#chat-composer-error")!.textContent).toContain(scenario === "delivered-code" ? "already delivered" : "unavailable");
        }
      } finally { window.dispatchEvent(new window.Event("pagehide")); }
    });
  }

  for (const failure of ["typed", "network", "server", "missing-ack"] as const) for (const terminal of ["none", "removed", "delivered"] as const) for (const switched of [false, true]) for (const action of ["remove", "edit", "queue"] as const) {
    if (terminal !== "none" && action !== "remove") continue;
    const name = `unconfirmed withdrawal on ${action} ${switched ? "cannot affect a newly selected conversation" : "retains input and retries withdrawal only"}${terminal === "none" ? "" : ` after early ${terminal}`}${failure === "typed" ? "" : ` after ${failure} failure`}`;
    test(name, async () => {
    // Chat intentionally survives pagehide. Keep its pending renders and save
    // timers from writing through the next case's global DOM/storage fixture.
    if (process.env.UATU_WITHDRAWAL_UI_CASE !== "1") {
      const child = Bun.spawn({
        cmd: [process.execPath, "test", import.meta.path, "-t", `${name}$`],
        env: { ...process.env, UATU_WITHDRAWAL_UI_CASE: "1" },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      return;
    }
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const { ChatApiClient } = await import("./client");
    let mutations = 0, reads = 0;
    const response = deferred<Response>();
    const retryResponse = deferred<Response>();
    const requests: Array<{ url: string; method?: string }> = [];
    let parent: Parameters<ChatApiClient["stream"]>[2] | undefined;
    const transport = new ChatApiClient(async (url, init) => {
      mutations++;
      requests.push({ url: String(url), method: init?.method });
      return mutations === 1 ? response.promise : retryResponse.promise;
    });
    const api = {
      status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["steering", "send-now"] } } }],
      conversations: async () => [conversation("one"), conversation("two")], commands: async () => [], models: async () => [], modes: async () => [],
      snapshot: async (id: string) => { reads++; return { ...snapshot(id), queued: mutations === 1 && id === "one" ? [] : [{ id: "pending", text: id === "one" ? "Original pending input" : "Other conversation input", queuedAt: 1, delivery: "steer" }] }; },
      removeQueued: transport.removeQueued.bind(transport), changeDelivery: transport.changeDelivery.bind(transport),
      stream: (_id: string, _cursor: string, handlers: Parameters<ChatApiClient["stream"]>[2]) => { parent = handlers; return { close() {} }; }, inventoryStream: () => ({ close() {} }), attachmentUrl: () => "",
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?withdrawal=${action}-${switched}-${Date.now()}`);
    initChat(api);
    try {
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      await waitUntil(() => !input.disabled && !!document.querySelector(`[data-queue-${action}="pending"]`));
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      if (select.value !== "one") {
        select.value = "one";
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
        await waitUntil(() => !!document.querySelector('[data-chat-queued-id="pending"]')?.textContent?.includes("Original pending input"));
      }
      input.value = "Draft typed meanwhile";
      const before = reads;
      const target = document.querySelector<HTMLButtonElement>(`[data-queue-${action}="pending"]`)!;
      target.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => mutations === 1);
      if (terminal !== "none") {
        parent!.event({ type: "conversation.queue", generation: "g", sequence: 1, conversationId: "one", queued: [], change: { kind: terminal, messageId: "pending" } }, "cursor-one-1");
        if (terminal === "delivered") parent!.event({ type: "item.upsert", generation: "g", sequence: 2, conversationId: "one", item: { id: "message:pending", type: "user_message", text: "Original pending input", createdAt: 2 } }, "cursor-one-2");
        await waitUntil(() => !document.querySelector('[data-chat-queued-id="pending"]'));
      }
      if (switched) {
        const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
        select.value = "two";
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
        await waitUntil(() => !!document.querySelector('[data-chat-queued-id="pending"]')?.textContent?.includes("Other conversation input"));
        input.value = "Other conversation draft";
      }
      if (failure === "network") response.reject(new TypeError("Failed to fetch"));
      else if (failure === "missing-ack") response.resolve(Response.json({}));
      else if (failure === "server") response.resolve(Response.json({ error: "Bad gateway" }, { status: 502 }));
      else response.resolve(Response.json({ error: "the agent has not confirmed the withdrawal", code: "steer-withdrawal-unconfirmed" }, { status: 409 }));
      if (terminal !== "none") {
        await waitUntil(() => !target.disabled);
        // Flush the response and any follow-on snapshot render, not a fixed
        // elapsed-time guess, before checking for a resurrected dock entry.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(!!document.querySelector('[data-chat-queued-id="pending"]')).toBe(switched);
        expect(document.querySelector("#chat-action-feedback")!.textContent).not.toContain("withdrawal");
        expect(reads).toBe(before + (switched ? 1 : 0));
        expect(input.value).toBe(switched ? "Other conversation draft" : "Draft typed meanwhile");
        if (terminal === "delivered" && !switched) expect(document.querySelector("#chat-items")!.textContent).toContain("Original pending input");
        expect(mutations).toBe(1);
        expect(requests.map(request => request.method)).toEqual(["DELETE"]);
        return;
      }
      if (switched) {
        await waitUntil(() => !target.disabled);
        expect(document.querySelector('[data-chat-queued-id="pending"]')!.textContent).toContain("Other conversation input");
        expect(!!document.querySelector('[data-queue-remove="pending"]')).toBe(true);
        expect(input.value).toBe("Other conversation draft");
        expect(document.querySelector("#chat-action-feedback")!.textContent).not.toContain("withdrawal");
        expect(mutations).toBe(1);
        return;
      }
      await waitUntil(() => document.querySelector("#chat-action-feedback")!.textContent!.includes("withdrawal still unconfirmed"));
      await waitUntil(() => document.querySelector('[data-queue-remove="pending"]')?.textContent === "Retry withdrawal");
      expect(reads).toBe(before + 1);
      expect(document.querySelector('[data-chat-queued-id="pending"]')!.textContent).toContain("Original pending input");
      expect(input.value).toBe("Draft typed meanwhile");
      expect(!!document.querySelector('[data-queue-remove="pending"]')).toBe(true);
      expect(!!document.querySelector('[data-queue-edit="pending"]')).toBe(false);
      expect(!!document.querySelector('[data-queue-queue="pending"]')).toBe(false);
      expect(mutations).toBe(1);
      const retry = document.querySelector<HTMLButtonElement>('[data-queue-remove="pending"]')!;
      expect(retry.disabled).toBe(false);
      retry.dispatchEvent(new window.Event("click", { bubbles: true }));
      retry.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => mutations === 2);
      expect(requests.map(request => request.method)).toEqual([action === "queue" ? "PATCH" : "DELETE", "DELETE"]);
      expect(requests[1]!.url).toBe(requests[0]!.url);
      expect(input.value).toBe("Draft typed meanwhile");
      if (action === "queue") {
        retryResponse.resolve(Response.json({ error: "the message was already delivered", code: "steer-already-delivered" }, { status: 409 }));
        await waitUntil(() => document.querySelector("#chat-composer-error")!.textContent!.includes("already delivered"));
        parent!.event({ type: "item.upsert", generation: "g", sequence: 1, conversationId: "one", item: { id: "message:pending", type: "user_message", text: "Original pending input", createdAt: 2 } }, "cursor-one-1");
      } else {
        retryResponse.resolve(Response.json({ removed: true }));
        parent!.event({ type: "conversation.queue", generation: "g", sequence: 1, conversationId: "one", queued: [], change: { kind: "removed", messageId: "pending" } }, "cursor-one-1");
      }
      await waitUntil(() => !document.querySelector('[data-chat-queued-id="pending"]'));
      expect(input.value).toBe("Draft typed meanwhile");
      expect(mutations).toBe(2);
      await waitUntil(() => !document.querySelector("#chat-action-feedback")!.textContent!.includes("withdrawal still unconfirmed"));
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
    });
  }

  for (const outcome of ["read-unavailable", "converted", "same-text-other-submission", "legacy-no-submission", "converted-unconfirmed", "refused-400", "refused-409", "programmer-error", "admission-unknown"] as const) {
    const name = `lost withdrawal recovery distinguishes ${outcome}`;
    test(name, async () => {
      if (process.env.UATU_WITHDRAWAL_UI_CASE !== "1") {
        const child = Bun.spawn({ cmd: [process.execPath, "test", import.meta.path, "-t", `${name}$`], env: { ...process.env, UATU_WITHDRAWAL_UI_CASE: "1" }, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        return;
      }
      const { document, window } = parseHTML(html);
      installDomGlobals(document, window);
      document.documentElement.setAttribute("data-ui-mode", "desktop");
      document.documentElement.setAttribute("data-chat-panel", "open");
      stubConversationSelect(document);
      const { ChatApiClient } = await import("./client");
      const admission = outcome === "admission-unknown";
      const original = { id: "native-original", submissionId: outcome === "legacy-no-submission" ? undefined : "logical-original", text: "Original pending input", queuedAt: 1, delivery: admission ? "queue" as const : "steer" as const };
      const replacement = { ...original, id: "held-new", delivery: "queue" as const,
        submissionId: outcome === "same-text-other-submission" ? "logical-other" : original.submissionId,
        ...(outcome === "converted-unconfirmed" ? { unconfirmed: true as const } : {}) };
      let mutations = 0, reads = 0;
      const response = deferred<Response>();
      const recovery = deferred<ConversationSnapshot>();
      const transport = new ChatApiClient(async () => { mutations++; return response.promise; });
      const models: ChatModel[] = ["A", "B"].map(name => ({ selection: { providerId: "test", modelId: name }, provider: "Test", name, imageInput: true }));
      const api = {
        status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["steering", "send-now", "models", "attachments"] } } }],
        conversations: async () => [{ ...conversation("one"), status: "running" }], commands: async () => [], models: async () => models, modes: async () => [],
        snapshot: async () => { reads++; return mutations ? recovery.promise : { ...snapshot("one"), conversation: { ...conversation("one"), status: "running" }, queued: [original] }; },
        removeQueued: outcome === "programmer-error" ? async () => { throw new Error("Local programmer failure"); } : transport.removeQueued.bind(transport),
        changeDelivery: transport.changeDelivery.bind(transport), stream: () => ({ close() {} }), inventoryStream: () => ({ close() {} }), attachmentUrl: () => "",
        uploadAttachment: async () => ({ id: "private-attachment", mimeType: "image/png", sizeBytes: 3 }),
      } as unknown as ChatApiClient;
      const { initChat } = await import(`./ui.ts?withdrawal-recovery=${outcome}-${Date.now()}`);
      initChat(api);
      try {
        const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
        const action = admission ? "steer" : "remove";
        await waitUntil(() => !!document.querySelector(`[data-queue-${action}="native-original"]`));
        input.value = "New private draft";
        const before = reads;
        const target = document.querySelector<HTMLButtonElement>(`[data-queue-${action}="native-original"]`)!;
        target.dispatchEvent(new window.Event("click", { bubbles: true }));
        await waitUntil(() => !!document.querySelector('[data-model-value="test/B"]'));
        document.querySelector('[data-model-value="test/B"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
        chooseFiles(document.querySelector<HTMLInputElement>("#chat-attach-input")!, [new File(["new"], "private-new.png", { type: "image/png" })]);
        await waitUntil(() => document.querySelector("#chat-attachments")!.textContent!.includes("private-new.png"));
        if (outcome === "programmer-error") {
          await waitUntil(() => document.querySelector("#chat-state")!.textContent!.includes("Local programmer failure"));
          expect(reads).toBe(before);
          expect(mutations).toBe(0);
        } else if (outcome.startsWith("refused")) {
          response.resolve(Response.json({ error: "Definite refusal" }, { status: outcome === "refused-400" ? 400 : 409 }));
          if (outcome === "refused-409") {
            await waitUntil(() => reads === before + 1);
            recovery.resolve({ ...snapshot("one"), queued: [original] });
            await waitUntil(() => document.querySelector("#chat-composer-error")!.textContent!.includes("Definite refusal"));
            expect(document.querySelector('[data-chat-queued-id="native-original"]')).not.toBeNull();
          } else await waitUntil(() => document.querySelector("#chat-state")!.textContent!.includes("Definite refusal"));
          expect(reads).toBe(before + (outcome === "refused-409" ? 1 : 0));
        } else {
          response.reject(new TypeError("Failed to fetch"));
          await waitUntil(() => reads === before + 1);
          await flush();
          // The read is still pending: both the original target and any fresh
          // Retry button must remain fenced, including synthetic double clicks.
          target.dispatchEvent(new window.Event("click", { bubbles: true }));
          const retry = document.querySelector<HTMLButtonElement>('[data-queue-remove="native-original"]');
          if (retry) { expect(retry.disabled).toBe(true); retry.dispatchEvent(new window.Event("click", { bubbles: true })); }
          expect(mutations).toBe(1);
          if (outcome === "read-unavailable") recovery.reject(new Error("Read unavailable"));
          else recovery.resolve({ ...snapshot("one"), queued: admission ? [{ ...original, unconfirmed: true }] : [replacement] });
          await waitUntil(() => !target.disabled);
          await flush();
          if (outcome === "converted") {
            expect(document.querySelector('[data-chat-queued-id="native-original"]')).toBeNull();
            expect(document.querySelector('[data-queue-remove="held-new"]')?.textContent).toBe("Remove");
            expect(document.querySelector("#chat-action-feedback")!.textContent).not.toContain("withdrawal still unconfirmed");
          } else if (admission) {
            expect(document.querySelectorAll('[data-chat-queued-id="native-original"] button')).toHaveLength(0);
            expect(document.querySelector("#chat-action-feedback")!.textContent).not.toContain("withdrawal");
          } else {
            expect(document.querySelector('[data-queue-remove="native-original"]')?.textContent).toBe("Retry withdrawal");
            expect(document.querySelector('[data-queue-edit="native-original"]')).toBeNull();
            expect(document.querySelector('[data-queue-queue="native-original"]')).toBeNull();
            if (outcome === "read-unavailable") expect(document.querySelector("#chat-action-feedback")!.textContent).toContain("Status check unavailable");
          }
          expect(reads).toBe(before + 1);
        }
        expect(document.querySelector("#chat-action-feedback")!.textContent).not.toContain("Draft restored");
        expect(input.value).toBe("New private draft");
        expect(document.querySelector("#chat-attachments")!.textContent).toContain("private-new.png");
        expect(document.querySelector('[data-model-value="test/B"]')!.getAttribute("aria-pressed")).toBe("true");
        if (outcome.startsWith("refused") || outcome === "programmer-error") expect(document.querySelector("#chat-action-feedback")!.textContent).not.toContain("withdrawal");
      } finally { window.dispatchEvent(new window.Event("pagehide")); }
    });
  }

  test("unrelated Remove and a later accepted steer cannot resolve an earlier unknown background operation", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    let prompts = 0, removes = 0;
    let parent: { event(event: unknown, cursor: string): void } | undefined;
    const api = {
      status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["steering", "send-now", "background-blocking-work"] } } }],
      conversations: async () => [{ ...conversation("one"), status: "running" }], commands: async () => [], models: async () => [], modes: async () => [],
      snapshot: async () => ({ ...snapshot("one"), conversation: { ...conversation("one"), status: "running" }, queued: [{ id: "unrelated", requestId: "held", text: "Unrelated held work", queuedAt: 1, delivery: "queue" }] }),
      prompt: async () => ({ messageId: `accepted-${++prompts}`, pending: true, delivery: "steer", configuration: {}, automaticBackground: prompts === 1 ? "unknown" : "accepted" }),
      removeQueued: async () => { removes++; return { removed: true }; },
      stream: (_id: string, _cursor: string, handlers: { event(event: unknown, cursor: string): void }) => { parent = handlers; return { close() {} }; },
      inventoryStream: () => ({ close() {} }), attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?unrelated-outcome-ui=${Date.now()}`);
    initChat(api);
    try {
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      await waitUntil(() => !input.disabled && document.querySelector("[data-queue-remove]") !== null);
      const submit = (text: string) => {
        input.value = text;
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        document.querySelector("#chat-composer")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      };
      const feedback = document.querySelector<HTMLElement>("#chat-action-feedback")!;
      submit("First steer");
      await waitUntil(() => feedback.textContent!.includes("Status checked; automatic backgrounding still unconfirmed"));
      expect(feedback.textContent).toContain('Steer “First steer”');
      const remove = document.querySelector<HTMLButtonElement>('[data-queue-remove="unrelated"]')!;
      remove.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => removes === 1 && !remove.disabled);
      expect(feedback.hidden).toBe(false);
      expect(feedback.textContent).toContain("automatic backgrounding still unconfirmed");
      submit("Another steer");
      await waitUntil(() => prompts === 2 && document.querySelector("#chat-queue")!.textContent!.includes("Another steer"));
      expect(feedback.textContent).not.toContain("acknowledged");
      parent!.event({ type: "conversation.status", generation: "g", sequence: 1, conversationId: "one", status: "completed" }, "cursor-one-1");
      await waitUntil(() => document.querySelector<HTMLButtonElement>("#chat-stop")!.disabled);
      expect(feedback.textContent).toContain("automatic backgrounding still unconfirmed");
      expect(feedback.textContent).toContain('Steer “First steer”');
      expect(removes).toBe(1);
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });

  test("primary-unknown input reconciles read-only without restoring a resubmittable failed draft", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selected = "";
    Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
    let calls = 0, pendingRequest: string | undefined, readsAfterUnknown = 0;
    const { ChatTransportError } = await import("./client");
    const api = {
      status: async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["steering", "send-now", "background-blocking-work"] } } }],
      conversations: async () => [conversation("one"), conversation("two")], commands: async () => [], models: async () => [], modes: async () => [],
      snapshot: async (id: string) => {
        if (pendingRequest) readsAfterUnknown++;
        return { ...snapshot(id), queued: id === "one" && pendingRequest ? [{ id: "native", requestId: pendingRequest, text: "Keep this input", queuedAt: 1, delivery: "steer", paused: true, unconfirmed: true }] : [] };
      },
      prompt: async (_id: string, requestId: string) => { calls++; pendingRequest = requestId; throw new ChatTransportError("Operation outcome unknown", 409, "operation_outcome_unknown"); },
      stream: () => ({ close() {} }), inventoryStream: () => ({ close() {} }), attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?unknown-input-ui=${Date.now()}`);
    initChat(api);
    try {
      await waitUntil(() => select.querySelector('option[value="one"]') !== null);
      select.value = "one"; select.dispatchEvent(new window.Event("change", { bubbles: true }));
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      await waitUntil(() => !input.disabled);
      input.value = "Keep this input";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      document.querySelector("#chat-composer")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await waitUntil(() => calls === 1 && readsAfterUnknown > 0, () => `calls=${calls}, recovery reads=${readsAfterUnknown}`);
      expect(input.value).toBe("");
      expect(document.querySelector("#chat-action-feedback")?.textContent).toContain("unconfirmed");
      expect(document.querySelector("#chat-composer-error")?.textContent).not.toContain("Draft restored");
      await waitUntil(() => document.querySelector("#chat-queue")?.textContent?.includes("Keep this input") === true);
      expect(document.querySelectorAll('#chat-queue [data-chat-queued-id="native"] button')).toHaveLength(0);
      window.dispatchEvent(new window.Event("online"));
      await Promise.resolve();
      expect(calls).toBe(1);
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });

  test("dispatches local history operations and keeps composer state private and recoverable", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    const conversationSelect = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selectedConversation = "";
    Object.defineProperty(conversationSelect, "value", {
      configurable: true,
      get: () => selectedConversation,
      set: value => { selectedConversation = String(value); },
    });

    const undoResults: Array<Promise<ReversibleHistoryResult>> = [];
    const redoResults: Array<Promise<ReversibleHistoryResult>> = [];
    const revertResults: Array<Promise<ReversibleHistoryResult>> = [];
    const restoreResults: Array<Promise<ReversibleHistoryResult>> = [];
    const commandResults: Array<() => Promise<ChatCommand[]>> = [async () => { throw new Error("inventory unavailable"); }];
    const snapshotResults: Array<() => Promise<ConversationSnapshot>> = [];
    const prompts: Array<{ conversationId: string; text: string; attachments?: unknown[] }> = [];
    const snapshotDrafts: string[] = [];
    const undoRequestIds: string[] = [];
    const targetedCalls: Array<{ operation: "revert" | "restore"; conversationId: string; messageId: string; requestId: string }> = [];
    const streamFailures: Error[] = [];
    const uploadResults: Array<Promise<{ id: string; mimeType: string; sizeBytes: number }>> = [];
    const streams: Array<{
      conversationId: string;
      closed: boolean;
      resync(): void;
    }> = [];
    const localCommands: ChatCommand[] = [
      { name: "undo", description: "Undo", argumentHint: "", kind: "local-operation" },
      { name: "redo", description: "Redo", argumentHint: "", kind: "local-operation" },
    ];
    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: {
          state: "ready",
          version: "test",
          agent: { id: "test", name: "Test", capabilities: ["reversible-history", "attachments"] },
        },
      }]),
      conversations: async () => [conversation("one"), conversation("two")],
      commands: async () => await (commandResults.shift() ?? (async () => localCommands))(),
      snapshot: async (id: string) => {
        snapshotDrafts.push(document.querySelector<HTMLTextAreaElement>("#chat-input")?.value ?? "");
        return await (snapshotResults.shift() ?? (async () => snapshot(id)))();
      },
      stream: (conversationId: string, _cursor: string, handlers: Parameters<ChatApiClient["stream"]>[2]) => {
        const failure = streamFailures.shift();
        if (failure) throw failure;
        const entry = {
          conversationId,
          closed: false,
          resync() {
            entry.closed = true;
            handlers.resync();
          },
        };
        streams.push(entry);
        return { close() { entry.closed = true; } };
      },
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      uploadAttachment: async () => await uploadResults.shift()!,
      undo: async (_conversationId: string, requestId: string) => {
        undoRequestIds.push(requestId);
        return await undoResults.shift()!;
      },
      redo: async () => await redoResults.shift()!,
      revert: async (conversationId: string, messageId: string, requestId: string) => {
        targetedCalls.push({ operation: "revert", conversationId, messageId, requestId });
        return await revertResults.shift()!;
      },
      restore: async (conversationId: string, messageId: string, requestId: string) => {
        targetedCalls.push({ operation: "restore", conversationId, messageId, requestId });
        return await restoreResults.shift()!;
      },
      prompt: async (conversationId: string, _requestId: string, text: string, _model: unknown, _mode: unknown, _variant: unknown, attachments?: unknown[]) => {
        prompts.push({ conversationId, text, attachments });
        return { messageId: `message-${prompts.length}`, pending: false, delivery: "queue", configuration: {} };
      },
    } as unknown as ChatApiClient;

    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
    try {
      const { initChat } = await import(`./ui.ts?reversible-history-ui-test=${Date.now()}`);
      initChat(api);
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
      const select = conversationSelect;
      const attachInput = document.querySelector<HTMLInputElement>("#chat-attach-input")!;
      const live = document.querySelector<HTMLElement>("#chat-composer-status-live")!;
      await waitUntil(
        () => select.value === "one" && !form.hidden,
        () => document.querySelector("#chat-state")?.textContent ?? "no chat state",
      );

      const visibleTurns = historySnapshot("one", false);
      snapshotResults.push(async () => visibleTurns);
      streams.at(-1)!.resync();
      await waitUntil(() => document.querySelectorAll("[data-history-revert]").length === 2);
      const revertedState = {
        staged: true,
        canUndo: true,
        canRedo: true,
        revertedMessages: [{ id: "message:second", text: "second prompt" }],
      };
      const reverted = deferred<ReversibleHistoryResult>();
      revertResults.push(reverted.promise);
      snapshotResults.push(async () => historySnapshot("one", true));
      document.querySelector<HTMLButtonElement>('[data-history-revert="message:second"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-history-revert="message:first"]')!.click();
      expect(targetedCalls).toHaveLength(1);
      reverted.resolve({
        outcome: "changed",
        state: revertedState,
        restoredDraft: { text: "second prompt" },
      });
      await waitUntil(() => input.value === "second prompt" && document.querySelector("[data-history-restore]") !== null);
      expect(targetedCalls[0]).toEqual(expect.objectContaining({
        operation: "revert",
        conversationId: "one",
        messageId: "message:second",
      }));
      expect(document.querySelector("#chat-reverted")?.hasAttribute("hidden")).toBe(false);
      expect(document.querySelector("#chat-reverted-items")?.textContent).toContain("second prompt");

      const restored = deferred<ReversibleHistoryResult>();
      restoreResults.push(restored.promise);
      snapshotResults.push(async () => visibleTurns);
      document.querySelector<HTMLButtonElement>('[data-history-restore="message:second"]')!.click();
      await waitUntil(() => live.textContent === "Restoring...");
      restored.resolve({
        outcome: "changed",
        state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
      });
      await waitUntil(() => input.value === "" && document.querySelector("#chat-reverted")?.hasAttribute("hidden") === true);
      expect(targetedCalls[1]).toEqual(expect.objectContaining({
        operation: "restore",
        conversationId: "one",
        messageId: "message:second",
      }));

      uploadResults.push(Promise.resolve({ id: "existing", mimeType: "image/png", sizeBytes: 3 }));
      chooseFiles(attachInput, [new File(["old"], "existing.png", { type: "image/png" })]);
      await waitUntil(() => document.querySelector("#chat-attachments")?.textContent?.includes("existing.png") === true);

      type(input, "private passive draft");
      const passiveStream = streams.at(-1)!;
      const passiveSnapshotCalls = snapshotDrafts.length;
      snapshotResults.push(async () => { throw new Error("transient passive snapshot failure"); });
      passiveStream.resync();
      passiveStream.resync();
      await waitUntil(() => streams.at(-1) !== passiveStream && streams.at(-1)?.closed === false);
      expect(snapshotDrafts).toHaveLength(passiveSnapshotCalls + 2);
      expect(input.value).toBe("private passive draft");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      const streamRetrySource = streams.at(-1)!;
      const callsBeforePassiveStreamFailure = snapshotDrafts.length;
      streamFailures.push(new Error("transient passive stream failure"));
      streamRetrySource.resync();
      await waitUntil(() => streams.at(-1) !== streamRetrySource && streams.at(-1)?.closed === false);
      expect(snapshotDrafts).toHaveLength(callsBeforePassiveStreamFailure + 2);
      const callsAfterPassiveStreamRecovery = snapshotDrafts.length;
      await Bun.sleep(250);
      expect(snapshotDrafts).toHaveLength(callsAfterPassiveStreamRecovery);
      expect(input.value).toBe("private passive draft");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      const pendingPassiveSnapshot = deferred<ConversationSnapshot>();
      snapshotResults.push(async () => await pendingPassiveSnapshot.promise);
      const recoveredPassiveStream = streams.at(-1)!;
      const callsBeforeSelectionChange = snapshotDrafts.length;
      recoveredPassiveStream.resync();
      await waitUntil(() => snapshotDrafts.length === callsBeforeSelectionChange + 1);
      select.value = "two";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => streams.at(-1)?.conversationId === "two");
      const callsAfterSelectionChange = snapshotDrafts.length;
      pendingPassiveSnapshot.resolve(snapshot("one"));
      await Bun.sleep(150);
      expect(snapshotDrafts).toHaveLength(callsAfterSelectionChange);
      expect(streams.at(-1)?.conversationId).toBe("two");
      select.value = "one";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => streams.at(-1)?.conversationId === "one" && input.value === "private passive draft");

      commandResults.push(async () => { throw new Error("inventory still unavailable"); });
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent?.includes("Chat commands could not be loaded") === true);
      expect(document.querySelector("#chat-composer-error")?.textContent).toContain("Submit /undo again to retry");
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");
      expect(prompts).toHaveLength(0);
      expect(undoRequestIds).toHaveLength(0);

      commandResults.push(async () => localCommands);
      const failedUndo = deferred<ReversibleHistoryResult>();
      undoResults.push(failedUndo.promise);
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent === "Undoing...");
      streams.at(-1)!.resync();
      failedUndo.reject(new Error("provider unavailable"));
      await waitUntil(() => live.textContent?.includes("Undo failed") === true);
      expect(streams.at(-1)?.closed).toBe(false);
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");
      expect(prompts).toHaveLength(0);

      const noOpUndo = deferred<ReversibleHistoryResult>();
      undoResults.push(noOpUndo.promise);
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent === "Undoing...");
      streams.at(-1)!.resync();
      noOpUndo.resolve({ outcome: "nothing-to-undo", state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } });
      await waitUntil(() => live.textContent === "Nothing more to undo");
      expect(streams.at(-1)?.closed).toBe(false);
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      redoResults.push(Promise.resolve({ outcome: "nothing-to-redo", state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] } }));
      submit(form, input, "/redo");
      await waitUntil(() => live.textContent === "Nothing to redo");
      expect(input.value).toBe("/redo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      const reloadFailure = deferred<ReversibleHistoryResult>();
      undoResults.push(reloadFailure.promise);
      snapshotResults.push(async () => { throw new Error("snapshot unavailable"); });
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent === "Undoing...");
      streams.at(-1)!.resync();
      reloadFailure.resolve(changed("latest draft", [
        { id: "available", name: "available.png", mimeType: "image/png" },
        { name: "missing.png", mimeType: "image/png" },
      ]));
      await waitUntil(() => live.textContent?.includes("Submit /undo again to reconnect") === true);
      const undoCallsBeforeReloadRetry = undoRequestIds.length;
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      submit(form, input, "/undo");
      await waitUntil(() => input.value === "latest draft");
      expect(undoRequestIds).toHaveLength(undoCallsBeforeReloadRetry);
      expect(streams.at(-1)?.closed).toBe(false);
      expect(snapshotDrafts.at(-1)).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("available.png");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("missing.png");

      const slowUpload = deferred<{ id: string; mimeType: string; sizeBytes: number }>();
      uploadResults.push(slowUpload.promise);
      chooseFiles(attachInput, [new File(["slow"], "slow.png", { type: "image/png" })]);
      undoResults.push(Promise.resolve(changed("latest draft", [
        { id: "available", name: "available.png", mimeType: "image/png" },
        { name: "missing.png", mimeType: "image/png" },
      ])));
      streamFailures.push(new Error("stream unavailable"));
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent?.includes("Submit /undo again to reconnect") === true);
      const undoCallsBeforeStreamRetry = undoRequestIds.length;
      expect(input.value).toBe("/undo");
      submit(form, input, "/undo");
      await waitUntil(() => input.value === "latest draft");
      expect(undoRequestIds).toHaveLength(undoCallsBeforeStreamRetry);
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("available.png");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("missing.png");
      expect(document.querySelector<HTMLImageElement>("#chat-attachments img")?.src).toContain("/api/chat/attachments/available");
      expect(live.textContent).toContain("unavailable and will not be sent");
      expect(revoked.some(url => url.startsWith("blob:"))).toBe(true);
      slowUpload.resolve({ id: "stale", mimeType: "image/png", sizeBytes: 4 });
      await Bun.sleep(0);
      expect(document.querySelector("#chat-attachments")?.textContent).not.toContain("slow.png");

      select.value = "two";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => select.value === "two" && streams.at(-1)?.conversationId === "two");
      type(input, "private second draft");
      select.value = "one";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => select.value === "one" && streams.at(-1)?.conversationId === "one" && input.value === "latest draft");

      const pendingUndo = deferred<ReversibleHistoryResult>();
      undoResults.push(pendingUndo.promise);
      submit(form, input, "/undo");
      select.value = "two";
      select.dispatchEvent(new Event("change"));
      await waitUntil(
        () => streams.at(-1)?.conversationId === "two" && input.value === "private second draft",
        () => `input=${JSON.stringify(input.value)} select=${select.value} live=${JSON.stringify(live.textContent)}`,
      );
      pendingUndo.resolve(changed("earlier draft", [{ id: "earlier", name: "earlier.png", mimeType: "image/png" }]));
      await Bun.sleep(0);
      expect(select.value).toBe("two");
      expect(input.value).toBe("private second draft");

      select.value = "one";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => streams.at(-1)?.conversationId === "one" && input.value === "earlier draft");
      expect(eventSourceConstructions).toBe(0);
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("earlier.png");

      redoResults.push(Promise.resolve(changed("redo draft", [{ id: "redo", name: "redo.png", mimeType: "image/png" }])));
      submit(form, input, "/redo");
      await waitUntil(() => input.value === "redo draft");
      type(input, "redo draft, edited");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitUntil(() => prompts.length === 1);
      expect(prompts).toEqual([{
        conversationId: "one",
        text: "redo draft, edited",
        attachments: [{ id: "redo", name: "redo.png", mimeType: "image/png" }],
      }]);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

describe("chat permission confirmation", () => {
  test("Allow always asks first; only Confirm replies, Cancel and Escape reply nothing", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selectedConversation = "";
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => selectedConversation,
      set: value => { selectedConversation = String(value); },
    });
    const permissionCalls: Array<{ conversationId: string; requestId: string; outcome: string }> = [];
    const pending = {
      id: "permission:p1", type: "permission" as const, createdAt: 2, requestId: "p1",
      action: "bash", resources: ["git status --short"], alwaysPatterns: ["git status *"], status: "pending" as const,
    };
    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: {
          state: "ready",
          version: "test",
          agent: { id: "test", name: "Test", capabilities: ["permissions"], permissionScopeNote: "“Allow always” lasts until the test ends." },
        },
      }]),
      conversations: async () => [conversation("one")],
      commands: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), items: [{ id: "message:u", type: "user_message", createdAt: 1, text: "status?" }, pending] }),
      stream: () => ({ close() {} }),
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      permission: async (conversationId: string, requestId: string, _clientRequestId: string, outcome: string) => {
        permissionCalls.push({ conversationId, requestId, outcome });
        return { outcome };
      },
    } as unknown as ChatApiClient;

    try {
      const { initChat } = await import(`./ui.ts?permission-confirmation-ui-test=${Date.now()}`);
      initChat(api);
      const card = () => document.querySelector<HTMLElement>('[data-chat-item-id="permission:p1"]');
      const always = () => card()?.querySelector<HTMLButtonElement>('[data-permission-outcome="approved-session"]') ?? null;
      const stageOf = () => card()?.querySelector<HTMLElement>("[data-permission-confirming]") ?? null;
      const click = (element: Element | null) => { element!.dispatchEvent(new Event("click", { bubbles: true })); };
      await waitUntil(() => always() !== null, () => document.querySelector("#chat-state")?.textContent ?? "no card");

      // Allow always opens the stage and sends nothing.
      click(always());
      await waitUntil(() => stageOf() !== null);
      expect(permissionCalls).toEqual([]);
      expect(always()).toBeNull();
      expect([...stageOf()!.querySelectorAll(".chat-request-always code")].map(code => code.textContent)).toEqual(["git status *"]);
      expect(stageOf()!.textContent).toContain("until the test ends");

      // Cancel returns to the pending choices, still without a reply.
      click(stageOf()!.querySelector("[data-permission-cancel]"));
      await waitUntil(() => stageOf() === null && always() !== null);
      expect(permissionCalls).toEqual([]);

      // Escape inside the stage is Cancel.
      click(always());
      await waitUntil(() => stageOf() !== null);
      stageOf()!.querySelector("[data-permission-cancel]")!.dispatchEvent(Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" }));
      await waitUntil(() => stageOf() === null && always() !== null);
      expect(permissionCalls).toEqual([]);

      // Confirm sends the persistent reply, exactly once.
      click(always());
      await waitUntil(() => stageOf() !== null);
      click(stageOf()!.querySelector("[data-permission-confirm]"));
      await waitUntil(() => permissionCalls.length === 1);
      await Bun.sleep(5);
      expect(permissionCalls).toEqual([{ conversationId: "one", requestId: "p1", outcome: "approved-session" }]);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("agent logins", () => {
  test("a login change re-reads the catalog, believes an empty list, and the composer says the agent is not logged in", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const model = (name: string) => ({ selection: { providerId: "groq", modelId: name }, provider: "Groq", name });
    let login: "ok" | "missing" = "ok";
    let revision = 0;
    let catalog = [model("llama")];
    let modelReads = 0;
    let statusReads = 0;
    let inventory: { invalidation(event: unknown): void } | undefined;
    const api = {
      status: async () => {
        statusReads += 1;
        return [{
          agent: { id: "opencode", name: "OpenCode" },
          availability: { state: "ready", version: "1.18.34", agent: { id: "opencode", name: "OpenCode", capabilities: ["models"] }, login, ...(revision ? { accountsRevision: revision } : {}) },
        }];
      },
      conversations: async () => [{ ...conversation("one"), agent: { id: "opencode", name: "OpenCode" } }],
      commands: async () => [],
      models: async () => { modelReads += 1; return catalog; },
      snapshot: async (id: string) => snapshot(id),
      stream: () => ({ close() {} }),
      inventoryStream: (handlers: { invalidation(event: unknown): void }) => { inventory = handlers; return { close() {} }; },
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;

    const { initChat } = await import(`./ui.ts?agent-logins-ui-test=${Date.now()}`);
    initChat(api);
    const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
    const notice = document.querySelector<HTMLElement>("#chat-login-notice")!;
    const empty = document.querySelector<HTMLElement>("#chat-configuration-empty")!;
    await waitUntil(() => !form.hidden && modelReads === 1 && inventory !== undefined, () => document.querySelector("#chat-state")?.textContent ?? "no chat state");
    expect(notice.hidden).toBe(true);

    // The last provider is logged out through Agent accounts: the workspace
    // bumps the revision and ticks the inventory.
    login = "missing";
    revision = 1;
    catalog = [];
    inventory!.invalidation({ type: "conversation.inventory" });
    await waitUntil(() => modelReads === 2 && !notice.hidden, () => `model reads ${modelReads}, notice hidden ${notice.hidden}`);
    expect(notice.textContent).toBe("OpenCode is not logged in. Run opencode auth login where UatuCode runs.");
    await waitUntil(() => !empty.hidden && (empty.textContent ?? "").startsWith("No provider is logged in."), () => `picker empty: ${empty.hidden} ${empty.textContent}`);

    // Logging in again clears the notice and the models come back.
    login = "ok";
    revision = 2;
    catalog = [model("llama")];
    const before = statusReads;
    inventory!.invalidation({ type: "conversation.inventory" });
    await waitUntil(() => statusReads > before && modelReads === 3 && notice.hidden === true, () => `model reads ${modelReads}, notice hidden ${notice.hidden}`);
    await waitUntil(() => empty.hidden === true, () => `picker empty: ${empty.hidden} ${empty.textContent}`);

    // A tick that changes nothing re-reads status but not the catalog.
    const settled = statusReads;
    inventory!.invalidation({ type: "conversation.inventory" });
    await waitUntil(() => statusReads > settled);
    expect(modelReads).toBe(3);
  });
});

describe("catalog revisions", () => {
  const model = (limit: number): ChatModel => ({ selection: { providerId: "anthropic", modelId: "opus" }, provider: "Anthropic", name: "Opus", contextLimit: limit, contextWindow: { source: "catalog", freshness: "current" } });

  async function fixture(withOther = false) {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    } });
    const { presentationLocalStorage } = await import("../shell/presentation-storage");
    presentationLocalStorage()!.setItem("uatu:chat-presentation", JSON.stringify({ selectedId: "claude:one", lastAgentId: "claude", drafts: {} }));
    const reads: Array<ReturnType<typeof deferred<ChatModel[]>>> = [];
    const readAgents: string[] = [];
    let inventory: Parameters<ChatApiClient["inventoryStream"]>[0] | undefined;
    let statusReads = 0;
    const agent = { id: "claude", name: "Claude Code", capabilities: ["models", "context"] };
    const other = { id: "other", name: "Other", capabilities: ["context"] };
    const summary = { ...conversation("claude:one"), agent: { id: agent.id, name: agent.name } };
    const summaries = [summary, ...(withOther ? [{ ...conversation("other:one"), agent: { id: other.id, name: other.name } }] : [])];
    const api = {
      status: async () => { statusReads += 1; return [agent, ...(withOther ? [other] : [])].map(agent => ({ agent, availability: { state: "ready", version: "test", agent } })); },
      conversations: async () => summaries,
      models: (agentId: string) => { readAgents.push(agentId); const read = deferred<ChatModel[]>(); reads.push(read); return read.promise; },
      commands: async () => [],
      modes: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), conversation: summaries.find(summary => summary.id === id)!, items: [{ id: "usage:one", type: "assistant_message", createdAt: 2, markdown: "", model: model(200_000).selection, usage: { input: 150_000 } }] }),
      stream: () => ({ close() {} }),
      inventoryStream: (handlers: Parameters<ChatApiClient["inventoryStream"]>[0]) => { inventory = handlers; return { close() {} }; },
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?catalog-revisions=${Math.random()}`);
    initChat(api);
    await waitUntil(() => reads.length === 1 && inventory !== undefined);
    const selectionSettled = () => !document.querySelector("#chat-timeline")!.hasAttribute("aria-busy");
    return {
      reads,
      readAgents,
      label: () => document.querySelector("#chat-context-usage-label")?.textContent,
      context: () => document.querySelector("#chat-context")?.textContent,
      select: (id: string) => { const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!; select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); },
      statusReads: () => statusReads,
      selectionSettled,
      invalidate: (revision: string) => inventory!.invalidation({ type: "conversation.inventory", catalogs: { claude: revision } }),
      recover: () => inventory!.recovered?.(),
      finish: async () => {
        for (const read of reads) read.resolve([]);
        // The context label can update before the selected snapshot's paint
        // settles. Finish that read before flushing presentation on pagehide,
        // so its late completion cannot save through the next fake window.
        await waitUntil(selectionSettled, () => "catalog fixture selection to settle");
        window.dispatchEvent(new Event("pagehide"));
      },
    };
  }

  test("a revision received during initial loading is applied after the catalog is banked", async () => {
    const f = await fixture();
    try {
      f.invalidate("g:1");
      f.invalidate("g:2");
      f.invalidate("g:2");
      f.reads[0]!.resolve([model(200_000)]);
      await waitUntil(() => f.reads.length === 2, () => `${f.reads.length} model reads after bootstrap invalidation`);
      f.invalidate("g:2");
      expect(f.reads).toHaveLength(2);
      f.reads[1]!.resolve([model(1_000_000)]);
      await waitUntil(() => f.label() === "15%", () => `context label ${f.label()}`);
      const before = f.statusReads();
      f.invalidate("g:2");
      await waitUntil(() => f.statusReads() > before);
      expect(f.reads).toHaveLength(2);
    } finally { await f.finish(); }
  });

  test("a failed refresh leaves the same revision eligible for a later tick", async () => {
    const f = await fixture();
    try {
      f.reads[0]!.resolve([model(200_000)]);
      await waitUntil(() => f.label() === "75%");
      f.invalidate("g:2");
      await waitUntil(() => f.reads.length === 2);
      f.reads[1]!.reject(new Error("temporary transport failure"));
      await waitUntil(() => { f.invalidate("g:2"); return f.reads.length === 3; }, () => "retry of unacknowledged revision");
      f.reads[2]!.resolve([model(1_000_000)]);
      await waitUntil(() => f.label() === "15%");
      expect(f.reads).toHaveLength(3);
    } finally { await f.finish(); }
  });

  test("matching ticks received before failure coalesce into one automatic retry", async () => {
    const f = await fixture();
    try {
      f.reads[0]!.resolve([model(200_000)]);
      await waitUntil(() => f.label() === "75%");
      f.invalidate("g:2");
      await waitUntil(() => f.reads.length === 2);
      for (let tick = 0; tick < 4; tick += 1) f.invalidate("g:2");
      expect(f.reads).toHaveLength(2);
      f.reads[1]!.reject(new Error("temporary transport failure"));
      await waitUntil(() => f.reads.length === 3, () => "retry from the already-received invalidation");
      f.reads[2]!.resolve([model(1_000_000)]);
      await waitUntil(() => f.label() === "15%");
      expect(f.reads).toHaveLength(3);
    } finally { await f.finish(); }
  });

  test("a queued retry does not loop on failure without another invalidation", async () => {
    const f = await fixture();
    try {
      f.reads[0]!.resolve([model(200_000)]);
      await waitUntil(() => f.label() === "75%");
      f.invalidate("g:2");
      await waitUntil(() => f.reads.length === 2);
      f.invalidate("g:2");
      f.reads[1]!.reject(new Error("first failure"));
      await waitUntil(() => f.reads.length === 3);
      f.reads[2]!.reject(new Error("retry failure"));
      // Drain completion jobs; the failed retry has no queued demand to run.
      await Bun.sleep(0);
      expect(f.reads).toHaveLength(3);
      expect(f.label()).toBe("75%");
      f.invalidate("g:2");
      await waitUntil(() => f.reads.length === 4);
      f.reads[3]!.resolve([model(1_000_000)]);
      await waitUntil(() => f.label() === "15%");
    } finally { await f.finish(); }
  });

  test("an old queued retry cannot supersede the reconnect's newer refresh", async () => {
    const f = await fixture();
    try {
      f.reads[0]!.resolve([model(200_000)]);
      await waitUntil(() => f.label() === "75%");
      f.invalidate("g:2");
      await waitUntil(() => f.reads.length === 2);
      f.invalidate("g:2");
      f.recover();
      await waitUntil(() => f.reads.length === 3);
      f.reads[1]!.reject(new Error("old request failed"));
      await Bun.sleep(0);
      expect(f.reads).toHaveLength(3);
      f.reads[2]!.resolve([model(1_000_000)]);
      await waitUntil(() => f.label() === "15%");
    } finally { await f.finish(); }
  });

  test("a matching tick during a reconnect refresh retries that request if it fails", async () => {
    const f = await fixture();
    try {
      f.reads[0]!.resolve([model(200_000)]);
      await waitUntil(() => f.label() === "75%");
      f.invalidate("g:2");
      await waitUntil(() => f.reads.length === 2);
      f.recover();
      await waitUntil(() => f.reads.length === 3);
      f.invalidate("g:2");
      f.reads[1]!.reject(new Error("superseded request failed"));
      f.reads[2]!.reject(new Error("reconnect request failed"));
      await waitUntil(() => f.reads.length === 4, () => "retry owned by the reconnect refresh");
      f.reads[3]!.resolve([model(1_000_000)]);
      await waitUntil(() => f.label() === "15%");
      expect(f.reads).toHaveLength(4);
    } finally { await f.finish(); }
  });

  test("a newer revision can finish first without an older refresh overwriting it", async () => {
    const f = await fixture();
    try {
      f.reads[0]!.resolve([model(200_000)]);
      await waitUntil(() => f.label() === "75%");
      f.invalidate("g:2");
      await waitUntil(() => f.reads.length === 2);
      f.invalidate("g:2");
      f.invalidate("g:3");
      await waitUntil(() => f.reads.length === 3);
      f.reads[2]!.resolve([model(1_000_000)]);
      await waitUntil(() => f.label() === "15%");
      f.reads[1]!.resolve([model(500_000)]);
      const before = f.statusReads();
      f.invalidate("g:3");
      await waitUntil(() => f.statusReads() > before);
      expect(f.label()).toBe("15%");
      expect(f.reads).toHaveLength(3);
    } finally { await f.finish(); }
  });

  test("an inactive agent's revision uses its own catalog capabilities", async () => {
    const f = await fixture(true);
    try {
      f.reads[0]!.resolve([model(200_000)]);
      await waitUntil(() => f.label() === "75%");
      f.select("other:one");
      await waitUntil(() => f.context()?.includes("Other") === true);
      const before = f.reads.length;
      f.invalidate("g:2");
      await waitUntil(() => f.reads.length > before, () => "inactive Claude catalog refresh");
      expect(f.readAgents.at(-1)).toBe("claude");
      f.reads.at(-1)!.resolve([model(1_000_000)]);
      await f.reads.at(-1)!.promise;
      expect(f.context()).toContain("Other");
      f.select("claude:one");
      await waitUntil(() => f.label() === "15%");
    } finally { await f.finish(); }
    expect(f.selectionSettled()).toBe(true);
  });
});

describe("chat scheduled wakeups", () => {
  test("the composer lists pending wakeups and Release calls the control once, then the state clears", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const fireAt = new Date(2026, 8, 24, 20, 3).getTime();
    const oneShot = { id: "wakeup:w1", type: "scheduled_wakeup" as const, createdAt: 2, wakeupId: "w1", prompt: "check the build", recurring: false, schedule: "3 20 * * *", nextFireAt: fireAt, status: "pending" as const };
    const recurring = { id: "wakeup:c1", type: "scheduled_wakeup" as const, createdAt: 3, wakeupId: "c1", prompt: "poll the queue", recurring: true, schedule: "*/5 * * * *", nextFireAt: fireAt + 60_000, status: "pending" as const };
    const releases: Array<{ conversationId: string; requestId: string }> = [];
    const released = deferred<unknown>();
    let emit: ((event: unknown) => void) | undefined;
    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["scheduled-wakeups"] } },
      }]),
      conversations: async () => [{ ...conversation("one"), status: "scheduled" }],
      commands: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), conversation: { ...conversation(id), status: "scheduled" }, items: [{ id: "message:u", type: "user_message", createdAt: 1, text: "wake me later" }, oneShot, recurring] }),
      stream: (_id: string, _cursor: string, handlers: { event(event: unknown, cursor: string): void }) => {
        emit = event => handlers.event(event, "cursor-next");
        return { close() {} };
      },
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      release: async (conversationId: string, requestId: string) => {
        releases.push({ conversationId, requestId });
        return released.promise;
      },
    } as unknown as ChatApiClient;

    try {
      const { initChat } = await import(`./ui.ts?scheduled-wakeups-ui-test=${Date.now()}`);
      initChat(api);
      const panel = () => document.querySelector<HTMLElement>("#chat-scheduled-wakeups")!;
      const button = () => document.querySelector<HTMLButtonElement>("#chat-wakeups-release")!;
      await waitUntil(() => !panel().hidden, () => document.querySelector("#chat-state")?.textContent ?? "no panel");
      const time = "20:03";
      expect(document.querySelector("#chat-scheduled-wakeups-label")?.textContent).toBe(`2 wakeups scheduled · next about ${time}`);
      const rows = [...document.querySelectorAll("#chat-scheduled-wakeups-items li")];
      expect(rows.map(row => row.querySelector(".chat-wakeup-prompt")?.textContent)).toEqual(["check the build", "poll the queue"]);
      expect(rows.map(row => row.querySelector(".chat-wakeup-recurring")?.textContent ?? null)).toEqual([null, "Repeats"]);
      expect(rows[0]!.querySelector(".chat-wakeup-when")?.textContent).toBe(`about ${time}`);
      expect(document.querySelector("#chat-wakeups-release-note")?.textContent).toBe("Releasing cancels every wakeup and ends the agent's session.");
      // Each wakeup has its own Cancel.
      expect(rows.map(row => row.querySelector("[data-cancel-wakeup]")?.getAttribute("data-cancel-wakeup"))).toEqual(["w1", "c1"]);
      expect(document.querySelector(".chat-composer-status")?.getAttribute("data-state")).toBe("scheduled");
      // Pending rows are in the timeline too.
      expect(document.querySelector('#chat-timeline [data-chat-item-id="wakeup:w1"]')?.className).toContain("is-pending");

      button().dispatchEvent(new Event("click", { bubbles: true }));
      await waitUntil(() => releases.length === 1);
      expect(releases[0]!.conversationId).toBe("one");
      // Inert until the agent answers: a second press sends nothing.
      expect(button().disabled).toBe(true);
      expect(button().textContent).toBe("Releasing…");
      button().dispatchEvent(new Event("click", { bubbles: true }));
      await Bun.sleep(5);
      expect(releases).toHaveLength(1);

      // The agent reports the wakeups cancelled and the conversation idle.
      let sequence = 1;
      const frame = (body: Record<string, unknown>) => emit!({ generation: "g", sequence: sequence++, conversationId: "one", ...body });
      frame({ type: "item.upsert", item: { ...oneShot, nextFireAt: undefined, status: "cancelled" } });
      frame({ type: "item.upsert", item: { ...recurring, nextFireAt: undefined, status: "cancelled" } });
      frame({ type: "conversation.status", status: "idle" });
      released.resolve({ released: true });
      await waitUntil(() => panel().hidden === true, () => `panel still shown: ${document.querySelector("#chat-scheduled-wakeups-label")?.textContent}`);
      expect(document.querySelector(".chat-composer-status")?.getAttribute("data-state")).toBe("ready");
      expect(document.querySelector('#chat-timeline [data-chat-item-id="wakeup:w1"] .chat-wakeup-label')?.textContent).toBe("Wakeup cancelled");
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat paused crons", () => {
  test("a reopened conversation lists its paused cron with a Cancel and no release; Cancel calls the control once", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const paused = { id: "wakeup:c1", type: "scheduled_wakeup" as const, createdAt: 2, wakeupId: "c1", prompt: "poll the queue", recurring: true, schedule: "*/5 * * * *", status: "paused" as const, message: "Paused: the agent's session ended." };
    const cancels: Array<{ conversationId: string; wakeupId: string }> = [];
    const cancelled = deferred<unknown>();
    let emit: ((event: unknown) => void) | undefined;
    const api = {
      status: async () => ([{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["scheduled-wakeups"] } } }]),
      conversations: async () => [conversation("one")],
      commands: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), items: [{ id: "message:u", type: "user_message", createdAt: 1, text: "poll every five minutes" }, paused] }),
      stream: (_id: string, _cursor: string, handlers: { event(event: unknown, cursor: string): void }) => {
        emit = event => handlers.event(event, "cursor-next");
        return { close() {} };
      },
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      cancelWakeup: async (conversationId: string, wakeupId: string) => { cancels.push({ conversationId, wakeupId }); return cancelled.promise; },
    } as unknown as ChatApiClient;
    try {
      const { initChat } = await import(`./ui.ts?paused-crons-ui-test=${Date.now()}`);
      initChat(api);
      const panel = () => document.querySelector<HTMLElement>("#chat-scheduled-wakeups")!;
      await waitUntil(() => !panel().hidden, () => document.querySelector("#chat-state")?.textContent ?? "no panel");
      expect(document.querySelector("#chat-scheduled-wakeups-label")?.textContent).toBe("1 schedule paused · fires again when this conversation runs");
      expect(document.querySelector("#chat-scheduled-wakeups-items li")?.className).toBe("is-paused");
      expect(document.querySelector("#chat-scheduled-wakeups-items .chat-wakeup-when")?.textContent).toBe("Paused");
      // No session to release: only the per-row Cancel.
      expect(document.querySelector<HTMLElement>(".chat-wakeups-release")?.hidden).toBe(true);
      expect(document.querySelector(".chat-composer-status")?.getAttribute("data-state")).toBe("ready");
      const cancel = () => document.querySelector<HTMLButtonElement>('[data-cancel-wakeup="c1"]')!;
      cancel().dispatchEvent(new Event("click", { bubbles: true }));
      await waitUntil(() => cancels.length === 1);
      expect(cancels[0]).toEqual({ conversationId: "one", wakeupId: "c1" });
      expect(cancel().disabled).toBe(true);
      cancel().dispatchEvent(new Event("click", { bubbles: true }));
      await Bun.sleep(5);
      expect(cancels).toHaveLength(1);
      const { message: _message, ...row } = paused;
      emit!({ generation: "g", sequence: 1, conversationId: "one", type: "item.upsert", item: { ...row, status: "cancelled" } });
      cancelled.resolve({ cancelled: true });
      await waitUntil(() => panel().hidden === true, () => "panel still shown");
      expect(document.querySelector('#chat-timeline [data-chat-item-id="wakeup:c1"] .chat-wakeup-label')?.textContent).toBe("Recurring wakeup cancelled");
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat cost receipt", () => {
  for (const pendingPriorSnapshot of [false, true]) test(`itemizes three ways, remembers the choice across conversations and a reload, and leaves an agent's own totals alone${pendingPriorSnapshot ? " with a prior page's snapshot still pending" : ""}`, async () => {
    // One storage across two boots: the second boot is the reload.
    const priorSnapshot = deferred<void>();
    let priorSnapshotRequested = false;
    let priorSnapshotReleased = false;
    let priorSaveCompleted = false;
    const makeStorage = () => {
      const stored = new Map<string, string>();
      return {
        get length() { return stored.size; },
        clear() { stored.clear(); },
        getItem: (key: string) => stored.get(key) ?? null,
        key: (index: number) => [...stored.keys()][index] ?? null,
        removeItem: (key: string) => { stored.delete(key); },
        setItem: (key: string, value: string) => {
          stored.set(key, String(value));
          // Observe the old callback's real save regardless of which fixture it
          // targets. The reload assertion below detects cross-page corruption.
          if (priorSnapshotReleased && key.endsWith(":uatu:chat-presentation") && JSON.parse(value).receiptView === undefined) priorSaveCompleted = true;
        },
      };
    };
    const storage = makeStorage();
    const priorStorage = makeStorage();
    const Q = { providerId: "berget", modelId: "qwen" };
    const carrier = (id: string, costUsd: number, agent: string) => ({ id: `usage:${id}`, type: "assistant_message" as const, createdAt: 1, markdown: "", usage: { input: 1_000, output: 10, costUsd }, model: Q, agent });
    const task = (id: string, description: string, kind: string, conversationId: string, costUsd: number, descendants?: unknown[]) => ({
      id, type: "tool" as const, createdAt: 2, name: "task", status: "completed" as const, input: JSON.stringify({ description, subagent_type: kind }),
      childConversationId: conversationId, model: "qwen", usage: { input: 500, output: 5, costUsd }, ...(descendants ? { descendants } : {}),
    });
    const itemsOf: Record<string, unknown[]> = {
      one: [
        { id: "message:u", type: "user_message", createdAt: 0, text: "review the docs" },
        carrier("b", 0.5, "build"),
        task("tool:a", "Summarise README", "general", "ses_a", 0.2),
        task("tool:c", "Audit docs", "general", "ses_c", 0.1, [{ id: "tool:g", parentId: "tool:c", description: "Find files", subagent: "explore", conversationId: "ses_g", model: "qwen", usage: { input: 100, output: 1, costUsd: 0.05 } }]),
        task("tool:a2", "Shorten summary", "general", "ses_a", 0.15),
      ],
      two: [{ id: "message:u", type: "user_message", createdAt: 0, text: "hi" }, carrier("p", 2, "plan")],
      // An agent that tallies the session itself: totals on its report, per model, no receipt.
      tallied: [
        { id: "message:u", type: "user_message", createdAt: 0, text: "hi" },
        { id: "report", type: "context_report", createdAt: 3, total: 10, session: { costUsd: 9, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0, models: [
          { id: "opus", input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 9 }, { id: "haiku", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
        ] } },
      ],
    };
    const boot = async (tag: string) => {
      const { document, window } = parseHTML(html);
      installDomGlobals(document, window);
      Object.defineProperty(window, "localStorage", { configurable: true, value: tag === "prior" ? priorStorage : storage });
      document.documentElement.setAttribute("data-ui-mode", "desktop");
      document.documentElement.setAttribute("data-chat-panel", "open");
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      let selected = "";
      Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
      const api = {
        status: async () => ([{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["context", "subagents"] } } }]),
        conversations: async () => [conversation("one"), conversation("two"), conversation("tallied")],
        commands: async () => [],
        snapshot: async (id: string) => {
          if (tag === "prior") {
            priorSnapshotRequested = true;
            await priorSnapshot.promise;
          }
          return { ...snapshot(id), items: itemsOf[id] ?? [] };
        },
        stream: () => ({ close() {} }),
        inventoryStream: () => ({ close() {} }),
        attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      } as unknown as ChatApiClient;
      const { initChat } = await import(`./ui.ts?receipt-ui-test-${tag}=${Date.now()}`);
      initChat(api);
      const open = async (id: string, cost: string) => {
        if (selected !== id) { select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); }
        await waitUntil(() => document.querySelector("#chat-plan-session-cost")?.textContent === cost, () => `cost ${document.querySelector("#chat-plan-session-cost")?.textContent} for ${id}`);
      };
      const views = document.querySelector<HTMLElement>("#chat-plan-session-views")!;
      return {
        document, window, open, views,
        heading: () => document.querySelector("#chat-plan-session-heading")!.textContent,
        rows: () => [...document.querySelectorAll("#chat-plan-session-models tr")].map(row => [row.querySelector("td")!.firstChild!.textContent === null ? "" : row.querySelector("td")!.textContent, row.querySelector("td:last-child")!.textContent]),
        total: () => document.querySelector<HTMLElement>("#chat-plan-session-total")!,
        checked: () => [...views.querySelectorAll<HTMLElement>("[data-receipt-view]")].filter(button => button.getAttribute("aria-checked") === "true").map(button => button.dataset.receiptView),
        choose: (view: string) => views.querySelector(`[data-receipt-view="${view}"]`)!.dispatchEvent(new Event("click", { bubbles: true })),
      };
    };

    // Browser windows have separate realms. This harness replaces Bun's one
    // global window; a pending callback must still save to its own page's store.
    let priorOpened: Promise<void> | undefined;
    if (pendingPriorSnapshot) {
      const prior = await boot("prior");
      priorOpened = prior.open("one", "$1.00");
      await waitUntil(() => priorSnapshotRequested);
      prior.window.dispatchEvent(new Event("pagehide"));
    }
    const first = await boot("first");
    try {
      await first.open("one", "$1.00");
      // By agent, to begin with: the named main agent, a line per task each
      // with its own cost, the nested subagent under its launcher.
      expect(first.heading()).toBe("Agent");
      expect(first.views.hidden).toBe(false);
      expect(first.checked()).toEqual(["agents"]);
      expect(first.rows()).toEqual([
        ["buildqwen · main agent", "$0.50"],
        ["general · Summarise READMEqwen", "$0.20"],
        ["general · Audit docsqwen", "$0.10"],
        ["explore · Find filesqwen", "$0.05"],
        ["general · Shorten summaryqwen · same agent as “Summarise README”", "$0.15"],
      ]);
      expect(first.total().hidden).toBe(false);
      expect(first.total().textContent).toContain("Total");
      expect(first.total().querySelector("td:last-child")!.textContent).toBe("$1.00");

      // By type: two generals (one given two tasks) and one explore.
      first.choose("types");
      expect(first.heading()).toBe("Type");
      expect(first.checked()).toEqual(["types"]);
      expect(first.rows()).toEqual([["buildqwen · main agent", "$0.50"], ["2 × generalqwen · 3 tasks", "$0.45"], ["1 × exploreqwen", "$0.05"]]);
      // The arrow keys move the choice, as a radiogroup's do.
      first.views.dispatchEvent(Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowRight" }));
      expect(first.heading()).toBe("Model");
      expect(first.rows()).toEqual([["qwenbuild · 2 × general · explore", "$1.00"]]);
      expect(first.total().querySelector("td:last-child")!.textContent).toBe("$1.00");

      // The choice is the reader's, not the conversation's.
      await first.open("two", "$2.00");
      expect(first.heading()).toBe("Model");
      expect(first.checked()).toEqual(["models"]);

      // An agent that tallies the session itself reports per model only:
      // nothing to switch between, no total line, its rows as reported.
      await first.open("tallied", "$9.00");
      expect(first.views.hidden).toBe(true);
      expect(first.total().hidden).toBe(true);
      expect(first.heading()).toBe("Model");
      expect(first.rows()).toEqual([["opus", "$9.00"], ["haiku", "$0.00"]]);
      // Back on an itemizable conversation the control returns, still on the reader's choice.
      await first.open("one", "$1.00");
      expect(first.views.hidden).toBe(false);
      expect(first.checked()).toEqual(["models"]);
      first.choose("types");
      expect(first.checked()).toEqual(["types"]);
    } finally {
      await Bun.sleep(20);
      first.window.dispatchEvent(new Event("pagehide"));
    }

    if (pendingPriorSnapshot) {
      // Release an actual in-flight read after pagehide, not another lifecycle
      // event. Wait for its normal queued save, not an arbitrary drain sleep.
      priorSnapshotReleased = true;
      priorSnapshot.resolve();
      await priorOpened;
      await waitUntil(() => priorSaveCompleted, () => "prior page's queued presentation save");
    }
    // Reload: a fresh page over the same storage opens on the remembered choice.
    const second = await boot("second");
    try {
      await second.open("one", "$1.00");
      expect(second.checked()).toEqual(["types"]);
      expect(second.heading()).toBe("Type");
    } finally {
      await Bun.sleep(20);
      second.window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("plan usage on demand", () => {
  const boot = async (tag: string, capabilities: string[]) => {
    // One usage-pane module serves every boot in this process: its held
    // report and read handler must not leak from one test into the next.
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    // The sidebar (not booted here) hides the Usage pane by default.
    document.querySelector<HTMLElement>('[data-pane-id="usage"]')!.hidden = true;
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selected = "";
    Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
    const reads: string[] = [];
    let usageAsks = 0;
    const stored = { plan: { subscription: "pro", fiveHour: { utilization: 9 }, sevenDay: { utilization: 25 } }, readAt: Date.now() - 12 * 60_000, conversationId: "elsewhere" };
    const itemsOf: Record<string, unknown[]> = {
      standing: [
        { id: "message:u", type: "user_message", createdAt: 0, text: "hi" },
        { id: "notice:limit", type: "notice", createdAt: 1, level: "warning", message: "Approaching the 5-hour limit", code: "rate-limit-warning" },
      ],
      // A report of its own, older than the workspace's last-known one.
      older: [
        { id: "message:u", type: "user_message", createdAt: 0, text: "hi" },
        { id: "context:report:1", type: "context_report", createdAt: Date.now() - 30 * 60_000, total: 10, plan: { subscription: "pro", fiveHour: { utilization: 3 }, sevenDay: { utilization: 25 } } },
      ],
    };
    const api = {
      status: async () => ([{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities } } }]),
      conversations: async () => [conversation("standing"), conversation("older")],
      commands: async () => [],
      usage: async () => { usageAsks += 1; return stored; },
      readUsage: async (_agentId: string, _requestId: string, mode: string) => { reads.push(mode); return { report: { plan: { ...stored.plan, fiveHour: { utilization: 14 } }, readAt: Date.now() } }; },
      snapshot: async (id: string) => ({ ...snapshot(id), items: itemsOf[id] ?? [] }),
      stream: () => ({ close() {} }),
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?usage-ui-test-${tag}=${Date.now()}`);
    initChat(api);
    select.value = "standing";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { document, window, select, reads, usageAsks: () => usageAsks };
  };

  test("a conversation's own older report yields to a newer workspace one, so a read answered through another session still lands here", async () => {
    const { document, window, select, reads } = await boot("older", ["context", "usage"]);
    try {
      const summary = document.querySelector<HTMLElement>("#chat-plan-usage-summary")!;
      select.value = "older";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      // The workspace's 12-minute-old report is newer than this conversation's own 30-minute-old one.
      await waitUntil(() => summary.textContent === "Session 9% · Week 25%", () => `summary ${summary.textContent}`);
      document.querySelector<HTMLButtonElement>("#chat-plan-read")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => reads.length === 1, () => `reads ${reads.join(",")}`);
      // The read went through "elsewhere"; the conversation that asked still shows its answer.
      await waitUntil(() => summary.textContent === "Session 14% · Week 25%", () => `summary ${summary.textContent}`);
      expect(document.querySelector("#chat-plan-readout-age")?.textContent).toMatch(/· just now$/);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a conversation with only a standing shows it beside the workspace's last-known plan, refreshes it when opened, and reads on demand", async () => {
    const { document, window, reads } = await boot("with", ["context", "usage"]);
    try {
      const summary = document.querySelector<HTMLElement>("#chat-plan-usage-summary")!;
      await waitUntil(() => summary.textContent === "Session 9% · Week 25%", () => `summary ${summary.textContent}`);
      const details = document.querySelector<HTMLElement>("#chat-plan-usage")!;
      expect(details.dataset.level).toBe("warning");
      expect(details.dataset.stale).toBe("true");
      expect(document.querySelector<HTMLElement>("#chat-plan-readout-standing")!.hidden).toBe(false);
      expect(document.querySelector("#chat-plan-readout-standing")?.textContent).toContain("Approaching the 5-hour limit");
      expect(document.querySelector<HTMLElement>("#chat-plan-readout-head")!.hidden).toBe(false);
      expect(document.querySelector("#chat-plan-readout-name")?.textContent).toBe("Pro plan");
      expect(document.querySelector("#chat-plan-readout-age")?.textContent).toMatch(/· 12 min ago$/);
      expect([...document.querySelectorAll("#chat-plan-readout-rows .plan-row-label")].map(node => node.textContent)).toEqual(["Session", "Week"]);
      const read = document.querySelector<HTMLButtonElement>("#chat-plan-read")!;
      expect(read.hidden).toBe(false);
      // Opening the stale readout refreshes through a live session, unasked.
      details.setAttribute("open", "");
      Object.defineProperty(details, "open", { configurable: true, value: true });
      details.dispatchEvent(new window.Event("toggle"));
      await waitUntil(() => reads.length === 1, () => `reads ${reads.join(",")}`);
      expect(reads).toEqual(["live-only"]);
      await waitUntil(() => summary.textContent === "Session 14% · Week 25%", () => `summary ${summary.textContent}`);
      expect(details.dataset.stale).toBeUndefined();
      // The button reads now, starting a session if it must.
      read.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => reads.length === 2, () => `reads ${reads.join(",")}`);
      expect(reads[1]).toBe("start");
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("an agent idle at load is asked once the inventory has started it; a failed ask is retried and a 409 is final", async () => {
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    document.querySelector<HTMLElement>('[data-pane-id="usage"]')!.hidden = true;
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selected = "";
    Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
    const asks: string[] = [];
    const readAgents: string[] = [];
    let failFirst = true;
    let statusCalls = 0;
    const { ChatTransportError } = await import("./client");
    const claude = { id: "claude", name: "Claude Code" };
    const api = {
      // Idle at first: nothing declared yet, as on a fresh workspace process.
      // The poll for a selected not-ready agent then finds it ready.
      status: async () => {
        statusCalls += 1;
        return [
          { agent: claude, availability: statusCalls === 1 ? { state: "idle" } : { state: "ready", version: "test", agent: { ...claude, capabilities: ["context", "usage"] } } },
          { agent: { id: "opencode", name: "OpenCode" }, availability: { state: "idle" } },
        ];
      },
      conversations: async () => [{ id: "claude:c", title: "c", createdAt: 1, updatedAt: 1, status: "idle", agent: claude }],
      models: async () => [],
      modes: async () => [],
      commands: async () => [],
      usage: async (agentId: string) => {
        asks.push(agentId);
        if (agentId === "opencode") throw new ChatTransportError("this agent does not report plan usage", 409);
        if (failFirst) { failFirst = false; throw new ChatTransportError("Chat request failed (502)", 502); }
        return { plan: { subscription: "pro", fiveHour: { utilization: 9 }, sevenDay: { utilization: 25 } }, readAt: Date.now() };
      },
      readUsage: async (agentId: string) => { readAgents.push(agentId); return { report: null, reason: "no-live-session" }; },
      snapshot: async (id: string) => ({ ...snapshot(id), conversation: { id, title: "c", createdAt: 1, updatedAt: 1, status: "idle", agent: claude } }),
      stream: () => ({ close() {} }),
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?usage-ui-test-idle=${Date.now()}`);
    initChat(api);
    try {
      // Both idle agents are asked after the inventory read; OpenCode's 409 is final, Claude's 502 is not.
      await waitUntil(() => asks.length === 2, () => `asks ${asks.join(",")}`);
      expect([...asks].sort()).toEqual(["claude", "opencode"]);
      expect(document.querySelector("#usage-pane .pane-empty")?.textContent).toBe("No usage read yet.");
      // Selecting a conversation under the not-yet-ready agent polls its
      // status; once it reports ready and declaring usage, Claude is asked
      // again — OpenCode, having said 409, is not.
      select.value = "claude:c";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Bun.sleep(1_700);
      await waitUntil(() => asks.length === 3, () => `asks ${asks.join(",")}`);
      expect(asks.filter(id => id === "opencode")).toHaveLength(1);
      await waitUntil(() => document.querySelector("#usage-pane .usage-pane-head")?.textContent?.startsWith("Pro plan") === true, () => `pane ${document.querySelector("#usage-pane")?.textContent}`);
      // The reads go to the agent that answered with a report.
      document.querySelector<HTMLButtonElement>('[data-pane-id="usage"] .pane-action[data-usage-read]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => readAgents.length === 1, () => `reads ${readAgents.join(",")}`);
      expect(readAgents).toEqual(["claude"]);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("an agent that does not report plan usage gets no read control and is never asked", async () => {
    const { document, window, reads, usageAsks } = await boot("without", ["context"]);
    try {
      const summary = document.querySelector<HTMLElement>("#chat-plan-usage-summary")!;
      await waitUntil(() => summary.textContent === "Near rate limit", () => `summary ${summary.textContent}`);
      expect(document.querySelector<HTMLElement>("#chat-plan-readout-head")!.hidden).toBe(true);
      expect(document.querySelector<HTMLButtonElement>("#chat-plan-read")!.hidden).toBe(true);
      expect(usageAsks()).toBe(0);
      expect(reads).toEqual([]);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat question anchoring", () => {
  test("revealing a free-form answer hands its timeline's anchor to the question card", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selectedConversation = "";
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => selectedConversation,
      set: value => { selectedConversation = String(value); },
    });
    const pending = {
      id: "question:q1", type: "question" as const, createdAt: 2, requestId: "q1", status: "pending" as const,
      questions: [{
        prompt: "Which branch?", header: "Branch", multiple: false, allowFreeForm: true,
        options: [{ label: "main", description: "" }],
      }],
    };
    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["questions"] } },
      }]),
      conversations: async () => [conversation("one")],
      commands: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), items: [{ id: "message:u", type: "user_message", createdAt: 1, text: "which branch?" }, pending] }),
      stream: () => ({ close() {} }),
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      question: async () => ({ outcome: "answered" }),
    } as unknown as ChatApiClient;

    // The seam under test is the hand-off itself: which owner is asked to
    // hold which item. linkedom has no layout, so the owner's own pinned/
    // unpinned decision cannot be exercised here — the e2e suite does that.
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const handoffs: Array<{ scroller: string; preferredItemId: string | undefined }> = [];
    const beforeMutation = CoordinatedScrollOwner.prototype.beforeMutation;
    CoordinatedScrollOwner.prototype.beforeMutation = function (this: InstanceType<typeof CoordinatedScrollOwner>, preferredItemId?: string) {
      handoffs.push({ scroller: this.scroller.id, preferredItemId });
      beforeMutation.call(this, preferredItemId);
    };

    try {
      const { initChat } = await import(`./ui.ts?question-anchor-ui-test=${Date.now()}`);
      initChat(api);
      const card = () => document.querySelector<HTMLElement>('[data-chat-item-id="question:q1"]');
      await waitUntil(
        () => card()?.querySelector("[data-question-custom-toggle]") != null,
        () => document.querySelector("#chat-state")?.textContent ?? "no question card",
      );
      const toggle = card()!.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      const editor = card()!.querySelector<HTMLElement>("[data-question-custom-editor]")!;
      expect(editor.hidden).toBe(true);

      // linkedom implements no `form` IDL attribute; the handler reads it.
      Object.defineProperty(toggle, "form", { configurable: true, value: card()!.querySelector("form[data-question-form]") });
      toggle.checked = true;
      handoffs.length = 0;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));

      expect(handoffs).toEqual([{ scroller: "chat-timeline", preferredItemId: "question:q1" }]);
      expect(editor.hidden).toBe(false);

      // No resolvable card: today's behavior, which is no hand-off at all.
      const stray = document.createElement("form");
      stray.setAttribute("data-question-form", "");
      stray.innerHTML = '<fieldset data-question-panel="0"><input type="radio" data-question-custom-toggle></fieldset>';
      document.querySelector<HTMLElement>("#chat-items")!.append(stray);
      const strayToggle = stray.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      Object.defineProperty(strayToggle, "form", { configurable: true, value: stray });
      handoffs.length = 0;
      strayToggle.dispatchEvent(new Event("change", { bubbles: true }));
      expect(handoffs).toEqual([]);
    } finally {
      CoordinatedScrollOwner.prototype.beforeMutation = beforeMutation;
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat answering state", () => {
  test("explicit selection cannot carry an outgoing answer hold into an incoming paused conversation", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const { presentationLocalStorage } = await import("../shell/presentation-storage");
    const paused = { itemId: "message:b", offset: -20 };
    presentationLocalStorage()!.setItem("uatu:chat-presentation", JSON.stringify({ selectedId: "one", anchors: { two: paused } }));
    let opened = "";
    const api = questionApi(document);
    Object.assign(api, {
      conversations: async () => [conversation("one"), conversation("two")],
      snapshot: async (id: string) => ({ ...snapshot(id), items: id === "one" ? [pendingQuestion("q1", 1)] : [
        { id: "message:b", type: "user_message", createdAt: 1, text: "Incoming paused conversation" },
      ] }),
      stream: (id: string) => { opened = id; return { close() {} }; },
    });
    const { TimelineAnchorController } = await import("./anchor");
    const restore = TimelineAnchorController.prototype.restore;
    let parentAnchor: InstanceType<typeof TimelineAnchorController> | null = null;
    TimelineAnchorController.prototype.restore = function (value) { parentAnchor = this; restore.call(this, value); };
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const hold = CoordinatedScrollOwner.prototype.hold;
    let holds = 0;
    CoordinatedScrollOwner.prototype.hold = function (element, options) { holds += 1; hold.call(this, element, options); };
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 100_000;
    try {
      const { initChat } = await import(`./ui.ts?answer-selection=${Date.now()}`);
      initChat(api);
      const card = await waitForQuestionCard(document);
      card.querySelector<HTMLElement>("[data-question-custom-toggle]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      const field = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
      expect(parentAnchor!.isPinned()).toBe(true);
      active = field;
      field.dispatchEvent(new window.Event("focusin", { bubbles: true }));
      await Bun.sleep(20);
      expect(holds).toBe(1);
      holds = 0;
      // A notification/selection can arrive without blurring A. Let B's fast
      // snapshot complete while A's clearing paint is still queued in rAF.
      globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
      globalThis.cancelAnimationFrame = id => { if (!frames.delete(id)) cancelFrame(id); };
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      select.value = "two";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitUntil(() => opened === "two");
      expect(field.isConnected).toBe(true);
      expect(parentAnchor!.currentAnchor()).toEqual(paused);
      expect(parentAnchor!.isPinned()).toBe(false);
      // Run the real render and post-paint focus cleanup, then its coordinated
      // scroll work. An outgoing hold must not repin B when A is removed.
      for (let pass = 0; pass < 10 && frames.size > 0; pass += 1) {
        const pending = [...frames];
        for (const [id, callback] of pending) if (frames.delete(id)) callback(performance.now() + pass * 16);
        await Promise.resolve();
      }
      expect(field.isConnected).toBe(false);
      expect(parentAnchor!.isPinned()).toBe(false);
      expect(parentAnchor!.currentAnchor()).toEqual(paused);
      expect(holds).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = requestFrame;
      globalThis.cancelAnimationFrame = cancelFrame;
      TimelineAnchorController.prototype.restore = restore;
      CoordinatedScrollOwner.prototype.hold = hold;
      frames.clear();
      window.dispatchEvent(new Event("pagehide"));
      delete (window as unknown as { localStorage?: Storage }).localStorage;
    }
  });

  for (const change of ["remove", "refresh", "released-refresh"] as const) test(`focused answer reconciles after snapshot ${change} without focusout`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    let items: unknown[] = [{ id: "message:u", type: "user_message", createdAt: 1, text: "which branch?" }, pendingQuestion("q1", 2)];
    let handlers: { resync(): void } | null = null;
    const api = questionApi(document, { items: () => items, stream: value => { handlers = value; } });
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const hold = CoordinatedScrollOwner.prototype.hold;
    const release = CoordinatedScrollOwner.prototype.release;
    const holds: Element[] = [];
    const releases: string[] = [];
    let answerOwner: InstanceType<typeof CoordinatedScrollOwner> | null = null;
    CoordinatedScrollOwner.prototype.hold = function (element, options) { answerOwner = this; holds.push(element); hold.call(this, element, options); };
    CoordinatedScrollOwner.prototype.release = function () { releases.push(this.scroller.id); release.call(this); };
    try {
      const { initChat } = await import(`./ui.ts?answer-snapshot=${change}-${Date.now()}`);
      initChat(api);
      const card = await waitForQuestionCard(document);
      card.querySelector<HTMLElement>("[data-question-custom-toggle]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      const field = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
      active = field;
      field.dispatchEvent(new window.Event("focusin", { bubbles: true }));
      expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(true);
      if (change === "released-refresh") answerOwner!.pause();
      holds.length = 0;
      releases.length = 0;
      if (change === "remove") items = items.slice(0, 1);
      handlers!.resync();
      await Bun.sleep(80);
      if (change === "remove") {
        expect(field.isConnected).toBe(false);
        expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(false);
        expect(document.documentElement.hasAttribute("data-chat-editing")).toBe(false);
        expect(releases).toContain("chat-timeline");
      } else {
        expect(field.isConnected).toBe(true);
        expect(holds.length).toBe(change === "refresh" ? 1 : 0);
        if (change === "refresh") expect(holds[0] === field).toBe(true);
      }
    } finally {
      CoordinatedScrollOwner.prototype.hold = hold;
      CoordinatedScrollOwner.prototype.release = release;
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a request's answer field puts the surface in the answering state; the composer does not", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    // linkedom tracks no focus at all, so the state the handler reads is
    // supplied here and the events that drive it are dispatched directly.
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    const focus = (element: Element) => { active = element; element.dispatchEvent(new window.Event("focusin", { bubbles: true })); };
    const blur = async (element: Element) => {
      active = document.body;
      element.dispatchEvent(new window.Event("focusout", { bubbles: true }));
      await Bun.sleep(1);
    };
    const api = questionApi(document);
    try {
      const { initChat } = await import(`./ui.ts?answering-ui-test=${Date.now()}`);
      initChat(api);
      const card = await waitForQuestionCard(document);
      const toggle = card.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      Object.defineProperty(toggle, "form", { configurable: true, value: card.querySelector("form[data-question-form]") });
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      const answerField = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;

      focus(answerField);
      expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(true);
      expect(document.documentElement.hasAttribute("data-chat-editing")).toBe(true);

      await blur(answerField);
      expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(false);
      expect(document.documentElement.hasAttribute("data-chat-editing")).toBe(false);

      // The composer is editing, but it is not answering a request: the
      // chrome that the answering state clears includes the composer itself.
      focus(document.querySelector<HTMLTextAreaElement>("#chat-input")!);
      expect(document.documentElement.hasAttribute("data-chat-editing")).toBe(true);
      expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(false);
    } finally {
      document.documentElement.removeAttribute("data-chat-answering");
      document.documentElement.removeAttribute("data-chat-editing");
      document.documentElement.removeAttribute("data-chat-input-focused");
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("the answered field's timeline is held while it has focus and released when it loses it", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    const focus = (element: Element) => { active = element; element.dispatchEvent(new window.Event("focusin", { bubbles: true })); };
    const blur = async (element: Element) => {
      active = document.body;
      element.dispatchEvent(new window.Event("focusout", { bubbles: true }));
      await Bun.sleep(1);
    };
    // The seam is which owner is asked to hold what: the hold's own defence
    // of the position is the coordinated owner's unit case, and the platform
    // autoscroll it defends against is the browser suite's.
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const holds: Array<{ scroller: string; element: Element; align: string | undefined }> = [];
    const placements: Array<RevealOptions | undefined> = [];
    const releases: string[] = [];
    const hold = CoordinatedScrollOwner.prototype.hold;
    const release = CoordinatedScrollOwner.prototype.release;
    CoordinatedScrollOwner.prototype.hold = function (this: InstanceType<typeof CoordinatedScrollOwner>, element: HTMLElement, options?: RevealOptions) {
      holds.push({ scroller: this.scroller.id, element, align: options?.align });
      placements.push(options);
      hold.call(this, element, options);
    };
    CoordinatedScrollOwner.prototype.release = function (this: InstanceType<typeof CoordinatedScrollOwner>) {
      releases.push(this.scroller.id);
      release.call(this);
    };
    try {
      const { initChat } = await import(`./ui.ts?answer-hold-ui-test=${Date.now()}`);
      initChat(questionApi(document));
      const card = await waitForQuestionCard(document);
      const toggle = card.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      Object.defineProperty(toggle, "form", { configurable: true, value: card.querySelector("form[data-question-form]") });
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      const answerField = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
      holds.length = 0;
      releases.length = 0;

      focus(answerField);
      // On touch the field is held against the bottom of the band left above
      // the keyboard, and the row carrying Answer and Reject is held with it:
      // placing the field alone could leave its own buttons covered.
      expect(holds).toEqual([{ scroller: "chat-timeline", element: answerField, align: "end" }]);
      expect(placements[0]?.extent).toBe(card.querySelector<HTMLElement>("form[data-question-form] .chat-request-actions")!);
      expect(releases).toEqual([]);

      await blur(answerField);
      // Both owners: by now the field may not be in the timeline that held it,
      // and releasing an owner that holds nothing does nothing.
      expect(releases).toContain("chat-timeline");
      expect(holds).toHaveLength(1);

      // The composer is editing, not answering: nothing is held for it.
      focus(document.querySelector<HTMLTextAreaElement>("#chat-input")!);
      expect(holds).toHaveLength(1);
    } finally {
      CoordinatedScrollOwner.prototype.hold = hold;
      CoordinatedScrollOwner.prototype.release = release;
      document.documentElement.removeAttribute("data-chat-answering");
      document.documentElement.removeAttribute("data-chat-editing");
      document.documentElement.removeAttribute("data-chat-input-focused");
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  for (const lifecycle of ["transfer", "resume"] as const) test(`answer hold follows ${lifecycle} in parent and drill-down`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let active: Element | null = null;
    let visibility = "visible";
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const focus = (element: Element) => { active = element; element.dispatchEvent(new window.Event("focusin", { bubbles: true })); };
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const calls: Array<{ kind: string; scroller: string; element?: Element }> = [];
    const hold = CoordinatedScrollOwner.prototype.hold;
    const release = CoordinatedScrollOwner.prototype.release;
    CoordinatedScrollOwner.prototype.hold = function (element, options) {
      calls.push({ kind: "hold", scroller: this.scroller.id, element });
      hold.call(this, element, options);
    };
    CoordinatedScrollOwner.prototype.release = function () {
      calls.push({ kind: "release", scroller: this.scroller.id });
      release.call(this);
    };
    try {
      const { initChat } = await import(`./ui.ts?answer-lifecycle=${lifecycle}-${Date.now()}`);
      initChat(questionApi(document));
      await waitForQuestionCard(document);
      // Synthetic request controls isolate focus ownership from rendering and
      // provider request ordering; real independently-owned requests are E2E.
      for (const id of ["chat-timeline", "chat-drilldown-timeline"]) {
        const request = document.createElement("div");
        request.className = "chat-request";
        const first = document.createElement("input");
        const second = document.createElement("input");
        request.append(first, second);
        document.getElementById(id)!.append(request);
        focus(first);
        calls.length = 0;
        if (lifecycle === "transfer") {
          focus(second);
          expect(calls.filter(call => call.kind === "hold").map(call => ({ scroller: call.scroller, correctField: call.element === second }))).toEqual([{ scroller: id, correctField: true }]);
          expect(calls.findIndex(call => call.kind === "release")).toBeLessThan(calls.findIndex(call => call.kind === "hold"));
        } else {
          visibility = "hidden";
          document.dispatchEvent(new window.Event("visibilitychange"));
          visibility = "visible";
          document.dispatchEvent(new window.Event("visibilitychange"));
          expect(calls.filter(call => call.kind === "hold").map(call => ({ scroller: call.scroller, correctField: call.element === first }))).toEqual([{ scroller: id, correctField: true }]);
        }
        calls.length = 0;
        // Repeated focus sync/viewport corrections must not undo a gesture's
        // release by installing the same hold again.
        focus(active!);
        expect(calls.filter(call => call.kind === "hold")).toEqual([]);
      }
    } finally {
      CoordinatedScrollOwner.prototype.hold = hold;
      CoordinatedScrollOwner.prototype.release = release;
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("on desktop the answered field is held with the minimal move", async () => {
    // The end alignment exists because a keyboard covers the chrome and the
    // question has to be pressed against what is left. Nothing covers it on
    // desktop, so there is no band to press against and moving a card the
    // reader can already see would be a jump bought for nothing. What the
    // field is held *with* is unchanged: the extent is not device-dependent.
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    const focus = (element: Element) => { active = element; element.dispatchEvent(new window.Event("focusin", { bubbles: true })); };
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const placements: Array<RevealOptions | undefined> = [];
    const hold = CoordinatedScrollOwner.prototype.hold;
    CoordinatedScrollOwner.prototype.hold = function (this: InstanceType<typeof CoordinatedScrollOwner>, element: HTMLElement, options?: RevealOptions) {
      placements.push(options);
      hold.call(this, element, options);
    };
    try {
      const { initChat } = await import(`./ui.ts?answer-hold-desktop-ui-test=${Date.now()}`);
      initChat(questionApi(document));
      const card = await waitForQuestionCard(document);
      const toggle = card.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      Object.defineProperty(toggle, "form", { configurable: true, value: card.querySelector("form[data-question-form]") });
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      const answerField = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
      placements.length = 0;

      focus(answerField);
      expect(placements.map(placement => placement?.align)).toEqual(["nearest"]);
      expect(placements[0]?.extent).toBe(card.querySelector<HTMLElement>("form[data-question-form] .chat-request-actions")!);
    } finally {
      CoordinatedScrollOwner.prototype.hold = hold;
      document.documentElement.removeAttribute("data-chat-answering");
      document.documentElement.removeAttribute("data-chat-editing");
      document.documentElement.removeAttribute("data-chat-input-focused");
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a press on a request's answer controls does not blur the field first, whatever the pointer", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const permission = {
      id: "permission:p1", type: "permission" as const, createdAt: 3, requestId: "p1", status: "pending" as const,
      action: "Run git status", resources: ["git status"],
    };
    const prompt = { id: "message:u", type: "user_message" as const, createdAt: 1, text: "which branch?" };
    // Only a conversation's newest request is answerable, so the question and
    // the permission are shown in turn rather than together.
    let items: unknown[] = [prompt, pendingQuestion("q1", 2)];
    let handlers: { resync(): void } | null = null;
    const api = questionApi(document, {
      items: () => items,
      stream: (streamHandlers: { resync(): void }) => { handlers = streamHandlers; },
    });
    const press = (element: Element, pointerType: string) => {
      const event = Object.assign(new window.Event("mousedown", { bubbles: true, cancelable: true }), { pointerType });
      element.dispatchEvent(event as unknown as Event);
      return event.defaultPrevented;
    };
    try {
      const { initChat } = await import(`./ui.ts?answer-press-ui-test=${Date.now()}`);
      initChat(api);
      const card = await waitForQuestionCard(document);
      // The state the guard reads, derived by `syncEditingFocus` and pinned
      // by the answering-state case above; set here so this case is about
      // which presses the guard intercepts.
      const answering = (on: boolean) => document.documentElement.toggleAttribute("data-chat-answering", on);

      // Nothing is being answered, so no press can blur a field and reflow
      // the card: every pointer keeps ordinary behavior.
      expect(press(card.querySelector("[data-question-primary]")!, "touch")).toBe(false);
      expect(press(card.querySelector("[data-question-primary]")!, "mouse")).toBe(false);

      answering(true);
      // Cancelling touch pointerdown suppresses the compatibility click in
      // WebKit. Let the pointer sequence through; only its mousedown default
      // (the focus transfer) is prevented.
      const touchDown = Object.assign(new window.Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" });
      card.querySelector("[data-question-primary]")!.dispatchEvent(touchDown);
      expect(touchDown.defaultPrevented).toBe(false);
      // The controls that resolve a request: pressing them must not take
      // focus off an open answer field and reflow the card under the pointer.
      // The pointer type is not the question — a trackpad on an iPad's
      // keyboard case moves the card exactly as a finger does.
      expect(press(card.querySelector("[data-question-primary]")!, "touch")).toBe(true);
      expect(press(card.querySelector("[data-question-reject]")!, "touch")).toBe(true);
      expect(press(card.querySelector("[data-question-primary]")!, "mouse")).toBe(true);
      expect(press(card.querySelector("[data-question-reject]")!, "pen")).toBe(true);

      // Ordinary targets keep ordinary behavior even while answering.
      expect(press(card.querySelector("[data-question-custom-toggle]")!, "touch")).toBe(false);
      expect(press(card.querySelector("summary")!, "touch")).toBe(false);

      // Preventing the default on mousedown does not cancel the click the
      // card resolves on: rejecting the question still reaches the agent.
      const rejects: string[] = [];
      Object.assign(api, { question: async (_conversationId: string, itemId: string) => { rejects.push(itemId); return { outcome: "rejected" }; } });
      card.querySelector<HTMLButtonElement>("[data-question-reject]")!.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
      await waitUntil(() => rejects.length === 1, () => `rejects ${rejects.join(",")}`);

      items = [prompt, permission];
      handlers!.resync();
      await waitUntil(
        () => document.querySelector('[data-chat-item-id="permission:p1"] [data-permission-outcome]') != null,
        () => document.querySelector("#chat-items")?.textContent ?? "no permission card",
      );
      const permissionCard = document.querySelector<HTMLElement>('[data-chat-item-id="permission:p1"]')!;
      expect(press(permissionCard.querySelector('[data-permission-outcome="approved-session"]')!, "touch")).toBe(true);
      expect(press(permissionCard.querySelector('[data-permission-outcome="approved-session"]')!, "mouse")).toBe(true);
      expect(press(permissionCard.querySelector("summary")!, "touch")).toBe(false);
    } finally {
      document.documentElement.removeAttribute("data-chat-answering");
      document.documentElement.removeAttribute("data-chat-editing");
      document.documentElement.removeAttribute("data-chat-input-focused");
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat outstanding-request pill", () => {
  test("yields while its request is on screen and re-targets when the request changes", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const { observers, restore: restoreObservers } = stubIntersectionObservers();
    const later = { ...pendingQuestion("q2", 3), questions: [{ prompt: "Which remote?", header: "Remote", multiple: false, allowFreeForm: true, options: [{ label: "origin", description: "" }] }] };
    let items: unknown[] = [{ id: "message:u", type: "user_message", createdAt: 1, text: "which branch?" }, pendingQuestion("q1", 2)];
    let handlers: { resync(): void } | null = null;
    const api = questionApi(document, {
      items: () => items,
      stream: (streamHandlers: { resync(): void }) => { handlers = streamHandlers; },
    });
    const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump")!;
    const latest = () => observers.at(-1)!;
    // linkedom measures nothing, so what the timeline shows of the card is
    // supplied: a 600px band, and a card of `cardHeight` with `visible` of it
    // on screen.
    const fire = (visible: number, cardHeight = 200) => latest().callback([seen(visible, cardHeight)]);
    try {
      const { initChat } = await import(`./ui.ts?requests-pill-ui-test=${Date.now()}`);
      initChat(api);
      await waitUntil(() => pill.textContent === "1 request needs your answer", () => `pill ${pill.textContent}`);
      // Rooted at the timeline, on the card the pill points at.
      expect(latest().options.root).toBe(document.querySelector("#chat-timeline"));
      expect(latest().observed).toEqual([document.querySelector('[data-chat-item-id="question:q1"]')!]);
      // Dense thresholds: the rule is re-evaluated as the card scrolls, not
      // only as it enters and leaves.
      expect(latest().options.threshold).toEqual(Array.from({ length: 21 }, (_, index) => index / 20));
      expect(pill.hidden).toBe(false);

      // Half the card showing is enough to yield to it.
      fire(200);
      expect(pill.hidden).toBe(true);
      fire(100);
      expect(pill.hidden).toBe(true);
      // A sliver is not: the field and the controls are still off screen, and
      // the pill is the way back to them.
      fire(40);
      expect(pill.hidden).toBe(false);
      fire(0);
      expect(pill.hidden).toBe(false);
      // A card taller than the band can never show half of itself, so half
      // the band showing is the other way to qualify.
      fire(300, 2_000);
      expect(pill.hidden).toBe(true);
      fire(200, 2_000);
      expect(pill.hidden).toBe(false);
      expect(pill.textContent).toBe("1 request needs your answer");

      items = [...items, later];
      handlers!.resync();
      await waitUntil(() => pill.textContent === "2 requests need your answer", () => `pill ${pill.textContent}`);
      // The newest request is the answerable one, so the observer moves to it
      // and every observer it replaced is released.
      expect(latest().observed).toEqual([document.querySelector('[data-chat-item-id="question:q2"]')!]);
      expect(observers.slice(0, -1).every(observer => observer.disconnected)).toBe(true);
      fire(200);
      expect(pill.hidden).toBe(true);
      // The count is the count of everything outstanding, unchanged by the gate.
      expect(pill.textContent).toBe("2 requests need your answer");

      // pagehide can retain this document on iOS: its existing surface and
      // observer must keep working rather than wait for a nonexistent remount.
      const retainedObserver = latest();
      window.dispatchEvent(new Event("pagehide"));
      expect(retainedObserver.disconnected).toBe(false);
      fire(0);
      expect(pill.hidden).toBe(false);

      // No outstanding request means there is no node left to observe, even
      // though the chat surface itself continues to live with the document.
      items = [];
      handlers!.resync();
      await waitUntil(() => pill.textContent === "", () => `pill ${pill.textContent}`);
      expect(retainedObserver.disconnected).toBe(true);
      expect(pill.hidden).toBe(true);
    } finally {
      restoreObservers();
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("returns while a subagent drill-down is pushed over the request it leads to", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const { observers, restore: restoreObservers } = stubIntersectionObservers();
    const items: unknown[] = [
      { id: "message:u", type: "user_message", createdAt: 1, text: "review the docs" },
      {
        id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed",
        input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
        childConversationId: "child",
      },
      pendingQuestion("q1", 3),
    ];
    const api = questionApi(document, { items: () => items, capabilities: ["questions", "subagents"] });
    const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump")!;
    const drilldown = document.querySelector<HTMLElement>("#chat-drilldown")!;
    const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
    try {
      const { initChat } = await import(`./ui.ts?requests-pill-drilldown-ui-test=${Date.now()}`);
      initChat(api);
      await waitUntil(() => pill.textContent === "1 request needs your answer", () => `pill ${pill.textContent}`);
      // The card is on screen in the parent transcript, so the pill yields.
      observers.at(-1)!.callback([seen(200)]);
      expect(pill.hidden).toBe(true);

      const openTranscript = () => document.querySelector<HTMLButtonElement>('#chat-compact-workers [data-worker-item="tool:agent1"]');
      await waitUntil(() => openTranscript() != null, () => document.querySelector("#chat-items")?.textContent ?? "no subagent card");
      click(openTranscript()!);
      expect(drilldown.hidden).toBe(false);
      // The card still intersects the parent timeline under the pushed
      // screen, but it cannot be reached there: the pill is what carries a
      // request the parent is waiting on over the layer.
      expect(pill.hidden).toBe(false);

      click(document.querySelector<HTMLButtonElement>("#chat-drilldown-back")!);
      expect(drilldown.hidden).toBe(true);
      expect(pill.hidden).toBe(true);
    } finally {
      restoreObservers();
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat running-task inspection", () => {
  const runningAgentItems = () => [
    { id: "message:u", type: "user_message", createdAt: 1, text: "review the renderer" },
    {
      id: "tool:toolu_1", type: "tool", createdAt: 2, name: "task", status: "running",
      input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
    },
    {
      id: "task:ada2b", type: "background_task", createdAt: 2, taskId: "ada2b", description: "Review renderer", taskType: "local_agent",
      toolUseId: "toolu_1", status: "running", childConversationId: "child", subagentType: "explore", progress: "Reading the tests",
      usage: { totalTokens: 13_122, toolUses: 1, durationMs: 4_000 },
    },
  ];

  test("touch inspection follows live launcher metadata while desktop tracks stay absent", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let parent: { event(event: unknown, cursor: string): void } | undefined;
    const api = taskApi(document, {
      items: id => id === "one" ? runningAgentItems() : [],
      onStream: (id, handlers) => { if (id === "one") parent = handlers; },
    });
    try {
      const { initChat } = await import(`./ui.ts?touch-live-metadata=${Date.now()}`);
      initChat(api);
      const inspect = () => document.querySelector<HTMLButtonElement>('#chat-compact-workers [data-worker-item="task:ada2b"]');
      await waitUntil(() => inspect() != null);
      inspect()!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => document.querySelector("#chat-drilldown-title")?.textContent === "explore · Review renderer");
      parent!.event({ type: "item.upsert", generation: "g", sequence: 1, conversationId: "one", item: { ...runningAgentItems()[1], input: JSON.stringify({ description: "Updated renderer review", subagent_type: "explore", prompt: "go" }) } }, "cursor-one-1");
      await waitUntil(() => document.querySelector("#chat-drilldown-title")?.textContent === "explore · Updated renderer review", () => `inspection title: ${document.querySelector("#chat-drilldown-title")?.textContent}`);
      expect(document.querySelectorAll("#chat-subagents-items li")).toHaveLength(0);
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });

  test("one canonical running agent row opens the child transcript under a strip that stops the task", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const stops: string[] = [];
    const api = taskApi(document, { items: id => id === "one" ? runningAgentItems() : [{ id: "message:c", type: "assistant_message", createdAt: 3, markdown: "Looking at the tests" }], stop: taskId => { stops.push(taskId); } });
    const drilldown = document.querySelector<HTMLElement>("#chat-drilldown")!;
    const strip = document.querySelector<HTMLElement>("#chat-drilldown-task")!;
    const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
    try {
      const { initChat } = await import(`./ui.ts?task-inspection-agent-ui-test=${Date.now()}`);
      initChat(api);
      const inspect = () => document.querySelector<HTMLButtonElement>('#chat-compact-workers [data-inspect-task="ada2b"]');
      await waitUntil(() => inspect() != null, () => document.querySelector("#chat-compact-workers")?.textContent ?? "no task list");
      expect(inspect()!.dataset.inspectView).toBe("transcript");
      expect(document.querySelectorAll('#chat-compact-workers [data-worker-id]')).toHaveLength(1);
      expect(document.querySelector("#chat-subagents, #chat-background-tasks")).toBeNull();
      expect(inspect()!.querySelector(".chat-worker-meta")?.getAttribute("title")).toContain("Reading the tests");

      click(inspect()!);
      expect(drilldown.hidden).toBe(false);
      expect(document.querySelector("#chat-drilldown-timeline")!.hasAttribute("hidden")).toBe(false);
      expect(document.querySelector("#chat-drilldown-output")!.hasAttribute("hidden")).toBe(true);
      expect(document.querySelector("#chat-drilldown-title")?.textContent).toBe("explore · Review renderer");
      expect(strip.hidden).toBe(false);
      expect(strip.querySelector(".chat-drilldown-task-description")?.textContent).toBe("Review renderer");
      expect(strip.querySelector(".chat-drilldown-task-type")?.textContent).toBe("explore");
      expect(strip.querySelector(".chat-drilldown-task-progress")?.textContent).toBe("Reading the tests");
      expect(strip.querySelector(".chat-drilldown-task-usage")?.textContent).toBe("13k tokens · 1 tool use");
      expect(strip.querySelector("[data-task-elapsed]")?.textContent).toMatch(/^\d+:\d\d(:\d\d)?$/);
      await waitUntil(() => document.querySelector("#chat-drilldown-items")?.textContent?.includes("Looking at the tests") ?? false, () => document.querySelector("#chat-drilldown-state")?.textContent ?? "no child");

      // Stop from the strip goes through the one stop path and holds the control.
      click(strip.querySelector('[data-stop-task="ada2b"]')!);
      expect(stops).toEqual(["ada2b"]);
      expect(strip.querySelector<HTMLButtonElement>("[data-stop-task]")!.disabled).toBe(true);

      click(document.querySelector<HTMLButtonElement>("#chat-drilldown-back")!);
      expect(drilldown.hidden).toBe(true);
      expect(strip.hidden).toBe(true);

      // Reopening the same keyed row retains the strip and in-flight stop.
      click(inspect()!);
      expect(drilldown.hidden).toBe(false);
      expect(strip.hidden).toBe(false);
      expect(strip.dataset.taskId).toBe("ada2b");
      click(document.querySelector<HTMLButtonElement>("#chat-drilldown-back")!);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a running shell task's row opens the output view in the drill-down and reads the task's output", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const outputs: Array<[string, string]> = [];
    const snapshots: string[] = [];
    const api = taskApi(document, {
      items: () => [
        { id: "message:u", type: "user_message", createdAt: 1, text: "run the tests" },
        { id: "task:bgjpa", type: "background_task", createdAt: 2, taskId: "bgjpa", description: "bun test", taskType: "local_bash", toolUseId: "toolu_2", status: "running", outputFile: "/tmp/tasks/bgjpa.output" },
      ],
      output: (conversationId, taskId) => { outputs.push([conversationId, taskId]); return { text: "1 pass\n", truncated: false, settled: false }; },
      onSnapshot: id => { snapshots.push(id); },
    });
    const drilldown = document.querySelector<HTMLElement>("#chat-drilldown")!;
    const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
    try {
      const { initChat } = await import(`./ui.ts?task-inspection-shell-ui-test=${Date.now()}`);
      initChat(api);
      const inspect = () => document.querySelector<HTMLButtonElement>('#chat-compact-workers [data-inspect-task="bgjpa"]');
      await waitUntil(() => inspect() != null, () => document.querySelector("#chat-compact-workers")?.textContent ?? "no task list");
      expect(inspect()!.dataset.inspectView).toBe("output");
      // A shell task reports no progress at all, so the elapsed readout is
      // the row's only live signal (D6) — without it the row says nothing
      // about the task between launch and settle.
      const elapsed = document.querySelector<HTMLElement>('#chat-compact-workers [data-background-task="bgjpa"] [data-elapsed-since]');
      expect(elapsed).not.toBeNull();
      expect(elapsed!.textContent).toMatch(/^\d+:\d\d(:\d\d)?$/);
      expect(elapsed!.dataset.elapsedSince).toBe("2");
      // And it ticks: the row is rebuilt only when what it SAYS changes, so a
      // readout painted once would stand still for the whole run. The clock
      // is the working lines' own second tick, which the background state has
      // to keep alive even though the turn has ended.
      const firstReading = elapsed!.textContent;
      for (let attempt = 0; attempt < 12 && elapsed!.textContent === firstReading; attempt += 1) await Bun.sleep(200);
      expect(elapsed!.textContent).not.toBe(firstReading);
      const snapshotsBefore = snapshots.length;

      click(inspect()!);
      expect(drilldown.hidden).toBe(false);
      expect(document.querySelector("#chat-drilldown-title")?.textContent).toBe("bun test");
      expect(document.querySelector("#chat-drilldown-timeline")!.hasAttribute("hidden")).toBe(true);
      expect(document.querySelector("#chat-drilldown-output")!.hasAttribute("hidden")).toBe(false);
      expect(document.querySelector("#chat-drilldown-task [data-stop-task]")).not.toBeNull();
      await waitUntil(() => document.querySelector("#chat-drilldown-output-text")?.textContent === "1 pass\n", () => document.querySelector("#chat-drilldown-output-note")?.textContent ?? "no output");
      expect(outputs).toEqual([["one", "bgjpa"]]);
      // No transcript was asked for: the view is the task's, not a child's.
      expect(snapshots.length).toBe(snapshotsBefore);

      click(document.querySelector<HTMLButtonElement>("#chat-drilldown-back")!);
      expect(drilldown.hidden).toBe(true);
      expect(document.querySelector("#chat-drilldown-timeline")!.hasAttribute("hidden")).toBe(false);
      expect(document.querySelector("#chat-drilldown-output")!.hasAttribute("hidden")).toBe(true);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  // The output view has no child stream whose next event would take a read
  // error down, so the recovery the panel reports is what clears the line.
  // Real timers: the retry after one failure is four seconds out.
  const openFailingOutputView = async (label: string, reads: Array<() => { text: string; truncated: boolean; settled: boolean } | null>) => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    let read = 0;
    const api = taskApi(document, {
      items: () => [
        { id: "message:u", type: "user_message", createdAt: 1, text: "run the tests" },
        { id: "task:bgjpa", type: "background_task", createdAt: 2, taskId: "bgjpa", description: "bun test", taskType: "local_bash", toolUseId: "toolu_2", status: "running", outputFile: "/tmp/tasks/bgjpa.output" },
      ],
      output: () => { const answer = reads[Math.min(read, reads.length - 1)]!; read += 1; return answer(); },
    });
    const { initChat } = await import(`./ui.ts?${label}=${Date.now()}`);
    initChat(api);
    const inspect = () => document.querySelector<HTMLButtonElement>('#chat-compact-workers [data-inspect-task="bgjpa"]');
    await waitUntil(() => inspect() != null, () => document.querySelector("#chat-compact-workers")?.textContent ?? "no task list");
    inspect()!.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
    const line = document.querySelector<HTMLElement>("#chat-drilldown-state")!;
    await waitUntil(() => line.textContent === "workspace did not answer", () => line.textContent ?? "no drill-down line");
    expect(line.classList.contains("is-error")).toBe(true);
    expect(line.hidden).toBe(false);
    return { document, window, line, reads: () => read };
  };
  const eventually = async (predicate: () => boolean, describe: () => string, ms = 8_000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe()}`);
      await Bun.sleep(50);
    }
  };
  const fail = () => { throw new Error("workspace did not answer"); };

  test("a shell task's output read that fails shows its error, and the next read that answers takes it down", async () => {
    const { document, window, line } = await openFailingOutputView("task-output-recovery-ui-test", [fail, () => ({ text: "1 pass\n", truncated: false, settled: false })]);
    try {
      await eventually(() => document.querySelector("#chat-drilldown-output-text")?.textContent === "1 pass\n", () => line.textContent ?? "no output");
      expect(line.textContent).toBe("");
      expect(line.classList.contains("is-error")).toBe(false);
      expect(line.hidden).toBe(true);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  }, 15_000);

  test("a recovered output read leaves standing a message spoken on the line after its error", async () => {
    const { document, window, line, reads } = await openFailingOutputView("task-output-recovery-guard-ui-test", [fail, () => ({ text: "1 pass\n", truncated: false, settled: false })]);
    try {
      // No path in the product speaks on this line while an output view is
      // open, so another speaker is stood in for at the announcer's own text
      // node — the one whose content the guard compares against.
      const spoken = [...line.childNodes].find(node => node.nodeType === 3)!;
      spoken.textContent = "Something else went wrong";
      await eventually(() => reads() >= 2 && document.querySelector("#chat-drilldown-output-text")?.textContent === "1 pass\n", () => line.textContent ?? "no output");
      expect(line.textContent).toBe("Something else went wrong");
      expect(line.hidden).toBe(false);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  }, 15_000);
});

// Design D13/D14: the run a typed command launches streams nothing; its
// drill-down follows the transcript Claude Code writes to disk.
describe("a typed command's silent run", () => {
  test("is listed with the subagents, not as background work, and its open transcript fills in from re-read snapshots without reopening the view", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const childReads: number[] = [];
    const streams: string[] = [];
    const record = (index: number) => ({ id: `message:r${index}`, type: "assistant_message", createdAt: 10 + index, markdown: `Review step ${index}` });
    const api = taskApi(document, {
      items: id => id === "one"
        ? [
          { id: "message:u", type: "user_message", createdAt: 1, text: "/code-review low" },
          { id: "task:rv", type: "background_task", createdAt: 2, taskId: "rv", description: "/code-review", taskType: "local_agent", status: "running", subagentType: "general-purpose", childConversationId: "child", foreground: true },
        ]
        // The transcript on disk grows by one record per read.
        : Array.from({ length: childReads.length }, (_, index) => record(index + 1)),
      onSnapshot: id => { if (id === "child") childReads.push(Date.now()); },
      onStream: id => { streams.push(id); },
    });
    const drilldown = document.querySelector<HTMLElement>("#chat-drilldown")!;
    const strip = document.querySelector<HTMLElement>("#chat-drilldown-task")!;
    const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
    try {
      const { initChat } = await import(`./ui.ts?silent-run-ui-test=${Date.now()}`);
      initChat(api);
      const trackRow = () => document.querySelector<HTMLButtonElement>('#chat-compact-workers [data-inspect-task="rv"]');
      await waitUntil(() => trackRow() != null, () => document.querySelector("#chat-compact-workers")?.textContent ?? "no track");
      expect(trackRow()!.querySelector(".chat-worker-name")?.textContent).toBe("/code-review");
      // Not background work: no composer list, and no row in the timeline.
      expect(document.querySelector("#chat-background-tasks")).toBeNull();
      expect(document.querySelector('#chat-items [data-chat-item-id="task:rv"]')).toBeNull();

      click(trackRow()!);
      expect(drilldown.hidden).toBe(false);
      expect(document.querySelector("#chat-drilldown-title")?.textContent).toBe("/code-review");
      expect(strip.querySelector(".chat-drilldown-task-description")?.textContent).toBe("/code-review");
      // The turn's own Cancel stops a command; the strip offers no Stop.
      expect(strip.querySelector("[data-stop-task]")).toBeNull();
      await waitUntil(() => document.querySelector("#chat-drilldown-items")?.textContent?.includes("Review step 1") ?? false, () => document.querySelector("#chat-drilldown-items")?.textContent ?? "empty");
      const description = strip.querySelector(".chat-drilldown-task-description");
      // Silent for two seconds: the snapshot is read again, and what the run
      // wrote since arrives in place.
      for (let attempt = 0; attempt < 40 && !(document.querySelector("#chat-drilldown-items")?.textContent?.includes("Review step 2")); attempt += 1) await Bun.sleep(100);
      expect(document.querySelector("#chat-drilldown-items")?.textContent).toContain("Review step 2");
      expect(childReads.length).toBe(2);
      expect(childReads[1]! - childReads[0]!).toBeGreaterThanOrEqual(1_900);
      // Folded in, never reopened: one stream for the child, the same strip.
      expect(streams.filter(id => id === "child")).toEqual(["child"]);
      expect(strip.querySelector(".chat-drilldown-task-description")).toBe(description);
      expect(document.querySelector("#chat-drilldown-title")?.textContent).toBe("/code-review");

      click(document.querySelector<HTMLButtonElement>("#chat-drilldown-back")!);
      expect(drilldown.hidden).toBe(true);
      const readsAtClose = childReads.length;
      await Bun.sleep(2_300);
      expect(childReads.length).toBe(readsAtClose);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  }, 15_000);
  test("a drill-down left open through the settle shows the run's last records, and closing it cancels the reads still due", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const childReads: number[] = [];
    let streamed: { event(event: unknown, cursor: string): void } | undefined;
    // The child's replay position and what its transcript on disk holds. The
    // run's last record is written before its settle is announced, and only
    // to disk: a typed command's run streams nothing.
    let sequence = 0;
    let settled = false;
    const cursorAt = (at: number) => Buffer.from(JSON.stringify({ v: 1, g: "g", s: at })).toString("base64url");
    const api = taskApi(document, {
      items: id => id === "one"
        ? [
          { id: "message:u", type: "user_message", createdAt: 1, text: "/code-review low" },
          { id: "task:rv", type: "background_task", createdAt: 2, taskId: "rv", description: "/code-review", taskType: "local_agent", status: "running", subagentType: "general-purpose", childConversationId: "child", foreground: true },
        ]
        : [
          { id: "message:r1", type: "assistant_message", createdAt: 11, markdown: "Review step 1" },
          ...(settled ? [{ id: "message:r2", type: "assistant_message", createdAt: 12, markdown: "Final review text" }] : []),
        ],
      onSnapshot: id => { if (id === "child") childReads.push(Date.now()); },
      onStream: (id, handlers) => { if (id === "child") streamed = handlers; },
      childSnapshot: () => ({ cursor: cursorAt(sequence), status: settled ? "completed" : "running" }),
    });
    const drilldown = document.querySelector<HTMLElement>("#chat-drilldown")!;
    const items = () => document.querySelector("#chat-drilldown-items")?.textContent ?? "";
    const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
    try {
      const { initChat } = await import(`./ui.ts?silent-run-settle-ui-test=${Date.now()}`);
      initChat(api);
      const trackRow = () => document.querySelector<HTMLButtonElement>('#chat-compact-workers [data-inspect-task="rv"]');
      await waitUntil(() => trackRow() != null, () => document.querySelector("#chat-compact-workers")?.textContent ?? "no track");
      click(trackRow()!);
      await waitUntil(() => items().includes("Review step 1") && streamed != null, items);
      expect(childReads.length).toBe(1);

      // The run finishes: its last record lands on disk, then the settle
      // arrives on the child's stream as a status change and nothing else.
      settled = true;
      sequence = 1;
      const settledAt = Date.now();
      streamed!.event({ type: "conversation.status", generation: "g", sequence: 1, conversationId: "child", status: "completed" }, cursorAt(1));
      // Read at the settle, not a quiet period later.
      await waitUntil(() => items().includes("Final review text"), () => `the run's last record; the drill-down holds "${items()}"`);
      expect(Date.now() - settledAt).toBeLessThan(1_000);
      expect(childReads.length).toBe(2);
      expect(drilldown.hidden).toBe(false);

      // Closed before the guard read falls due: it never comes.
      click(document.querySelector<HTMLButtonElement>("#chat-drilldown-back")!);
      expect(drilldown.hidden).toBe(true);
      await Bun.sleep(2_500);
      expect(childReads.length).toBe(2);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  }, 15_000);
});

describe("chat running work reachable without a disclosure", () => {
  test("touch foreground-only parent Stop explains native scope before cancelling the parent once", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const tool = { id: "tool:foreground", type: "tool" as const, createdAt: 2, name: "task", status: "running" as const,
      input: JSON.stringify({ description: "Foreground analysis", subagent_type: "general", prompt: "Inspect" }) };
    const cancelled: string[] = [], stopped: string[] = [];
    const api = taskApi(document, { items: () => [tool], stop: id => { stopped.push(id); } });
    api.status = async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["background-blocking-work", "subagents"] } } }];
    api.snapshot = async id => ({ ...snapshot(id), conversation: { ...conversation(id), status: "running" }, items: [tool] });
    api.cancel = async id => { cancelled.push(id); return { cancelled: true }; };
    const dialog = document.querySelector<HTMLDialogElement>("#chat-action-confirm")!;
    dialog.showModal = () => { dialog.setAttribute("open", ""); };
    const close = (value: string) => {
      dialog.returnValue = value;
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new window.Event("close"));
    };
    try {
      const { initChat } = await import(`./ui.ts?foreground-parent-stop=${Date.now()}`);
      initChat(api);
      const stop = document.querySelector<HTMLButtonElement>("#chat-stop")!;
      await waitUntil(() => !stop.disabled);
      expect(document.querySelectorAll('#chat-compact-workers-items [data-state="working"]')).toHaveLength(1);
      expect(document.querySelector("[data-stop-task]")).toBeNull();
      expect(stop.getAttribute("aria-label")).toBe("Stop parent");
      expect(stop.textContent).toBe("Stop parent");
      expect(stop.title).toContain("still-blocking work");
      stop.click();
      expect(dialog.hasAttribute("open")).toBe(true);
      expect(dialog.textContent).toContain("foreground work");
      expect(dialog.textContent).toContain("Detached workers continue");
      expect(dialog.textContent).toContain("wake the parent again");
      expect(cancelled).toEqual([]);
      close("cancel");
      await flush();
      expect(cancelled).toEqual([]);
      stop.click();
      close("confirm");
      await flush();
      expect(cancelled).toEqual(["one"]);
      expect(stopped).toEqual([]);
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });

  test("parent Stop follows canonical confirmed worker truth through aliases, mixed work and settlement", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const launcher = { id: "tool:a", type: "tool" as const, createdAt: 2, name: "task", status: "running" as const, input: '{"description":"Aliased analysis"}' };
    const canonical = { id: "task:canonical", type: "background_task" as const, taskId: "canonical", createdAt: 2,
      description: "Aliased analysis", taskType: "agent", status: "running" as const, toolUseIds: ["a", "b"], stateUncertain: true };
    const items = [launcher, { ...launcher, id: "tool:b" }, canonical];
    let stream: { event(event: unknown, cursor: string): void } | undefined;
    const api = taskApi(document, { items: () => items, onStream: (_id, handlers) => { stream = handlers; } });
    api.status = async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["background-blocking-work", "background-tasks", "subagents"] } } }];
    api.snapshot = async id => ({ ...snapshot(id), conversation: { ...conversation(id), status: "running" }, items });
    let sequence = 0;
    const emit = (body: Record<string, unknown>) => { sequence++; stream!.event({ generation: "g", sequence, conversationId: "one", ...body }, `cursor-one-${sequence}`); };
    const rows = (state: string) => document.querySelectorAll(`#chat-compact-workers-items [data-state="${state}"]`);
    const stop = document.querySelector<HTMLButtonElement>("#chat-stop")!;
    try {
      const { initChat } = await import(`./ui.ts?canonical-parent-stop=${Date.now()}`);
      initChat(api);
      await waitUntil(() => stream !== undefined && !stop.disabled);
      expect(rows("unknown")).toHaveLength(1);
      expect(document.querySelector<HTMLButtonElement>("[data-stop-task]")!.disabled).toBe(true);
      expect(stop.getAttribute("aria-label")).toBe("Stop response");
      emit({ type: "item.upsert", item: { ...canonical, stateUncertain: false } });
      await waitUntil(() => rows("working").length === 1);
      expect(stop.getAttribute("aria-label")).toBe("Stop parent");
      expect(document.querySelectorAll("[data-stop-task]")).toHaveLength(1);
      const foreground = { ...launcher, id: "tool:foreground", input: '{"description":"Foreground analysis"}' };
      emit({ type: "item.upsert", item: foreground });
      await waitUntil(() => rows("working").length === 2);
      expect(stop.getAttribute("aria-label")).toBe("Stop parent");
      expect(document.querySelectorAll("[data-stop-task]")).toHaveLength(1);
      emit({ type: "item.upsert", item: { ...canonical, stateUncertain: false, status: "completed" } });
      await waitUntil(() => rows("completed").length === 1);
      expect(rows("working")).toHaveLength(1);
      expect(stop.getAttribute("aria-label")).toBe("Stop parent");
      for (const [status, state] of [["cancelled", "stopped"], ["failed", "failed"], ["completed", "completed"]]) {
        emit({ type: "item.upsert", item: { ...foreground, status } });
        await waitUntil(() => rows(state!).length > 0 && rows("working").length === 0);
        expect(stop.getAttribute("aria-label")).toBe("Stop response");
        expect(document.querySelector("[data-stop-task]")).toBeNull();
      }
      emit({ type: "item.upsert", item: foreground });
      await waitUntil(() => rows("working").length === 1);
      emit({ type: "conversation.status", status: "completed" });
      await waitUntil(() => stop.disabled);
      expect(stop.getAttribute("aria-label")).toBe("Stop parent");
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });

  for (const change of ["settles", "switches"] as const) test(`touch parent Stop revalidates when its parent ${change} during confirmation`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const tool = { id: "tool:foreground", type: "tool" as const, createdAt: 2, name: "task", status: "running" as const, input: '{"description":"Foreground analysis"}' };
    let stream: { event(event: unknown, cursor: string): void } | undefined;
    const cancelled: string[] = [];
    const api = taskApi(document, { items: () => [tool], conversations: ["one", "two"], onStream: (_id, handlers) => { stream = handlers; } });
    api.status = async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["background-blocking-work", "subagents"] } } }];
    api.snapshot = async id => ({ ...snapshot(id), conversation: { ...conversation(id), status: "running" }, items: [tool] });
    api.cancel = async id => { cancelled.push(id); return { cancelled: true }; };
    const dialog = document.querySelector<HTMLDialogElement>("#chat-action-confirm")!;
    dialog.showModal = () => { dialog.setAttribute("open", ""); };
    try {
      const { initChat } = await import(`./ui.ts?parent-stop-revalidate=${change}-${Date.now()}`);
      initChat(api);
      const stop = document.querySelector<HTMLButtonElement>("#chat-stop")!;
      await waitUntil(() => stream !== undefined && !stop.disabled);
      stop.click();
      expect(dialog.hasAttribute("open")).toBe(true);
      if (change === "settles") {
        stream!.event({ type: "conversation.status", generation: "g", sequence: 1, conversationId: "one", status: "completed" }, "cursor-one-1");
        await waitUntil(() => stop.disabled);
      } else {
        const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
        select.value = "two";
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
        await flush();
        await waitUntil(() => !stop.disabled);
      }
      dialog.returnValue = "confirm";
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new window.Event("close"));
      await flush();
      expect(cancelled).toEqual([]);
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });

  for (const [mode, supported] of [["desktop", true], ["desktop", false], ["touch", false]] as const) test(`${mode} foreground parent Stop retains direct cancellation with V2 scope ${supported ? "supported" : "unsupported"}`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", mode);
    document.documentElement.setAttribute("data-chat-panel", "open");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const tool = { id: "tool:foreground", type: "tool" as const, createdAt: 2, name: "task", status: "running" as const, input: '{"description":"Foreground analysis"}' };
    const cancelled: string[] = [];
    const api = taskApi(document, { items: () => [tool] });
    api.status = async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: supported ? ["background-blocking-work", "subagents"] : ["subagents"] } } }];
    api.snapshot = async id => ({ ...snapshot(id), conversation: { ...conversation(id), status: "running" }, items: [tool] });
    api.cancel = async id => { cancelled.push(id); return { cancelled: true }; };
    try {
      const { initChat } = await import(`./ui.ts?parent-stop-direct=${mode}-${supported}-${Date.now()}`);
      initChat(api);
      const stop = document.querySelector<HTMLButtonElement>("#chat-stop")!;
      await waitUntil(() => !stop.disabled);
      expect(stop.getAttribute("aria-label")).toBe(supported ? "Stop parent" : "Stop response");
      stop.click();
      await flush();
      expect(document.querySelector("#chat-action-confirm[open]")).toBeNull();
      expect(cancelled).toEqual(["one"]);
    } finally { window.dispatchEvent(new window.Event("pagehide")); }
  });

  test("pending/running tools, detached workers and an idle parent never introduce a manual Continue control", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    let stream: { event(event: unknown, cursor: string): void } | undefined;
    const tool = { id: "tool:blocker", type: "tool", createdAt: 2, name: "subagent", status: "pending", input: "{}" };
    const api = taskApi(document, { items: () => [tool], onStream: (_id, handlers) => { stream = handlers; } });
    api.status = async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["background-tasks", "background-blocking-work", "subagents"] } } }];
    api.snapshot = async id => ({ ...snapshot(id), conversation: { ...conversation(id), status: "running" }, items: [tool as import("./types").ToolItem] });
    let sequence = 0;
    const emit = (body: Record<string, unknown>) => { sequence++; stream!.event({ generation: "g", sequence, conversationId: "one", ...body }, `cursor-one-${sequence}`); };
    const absent = () => expect(document.querySelector("#chat-continue-workers, .chat-background-help")).toBeNull();
    try {
      const { initChat } = await import(`./ui.ts?blocker-gating=${Date.now()}`);
      initChat(api);
      await waitUntil(() => stream !== undefined, () => "waiting for parent stream");
      absent();
      emit({ type: "item.upsert", item: { ...tool, status: "running" } });
      absent();
      emit({ type: "item.upsert", item: { id: "task:detached", type: "background_task", taskId: "detached", createdAt: 2, description: "Detached", taskType: "agent", status: "running", toolUseId: "blocker", childConversationId: "child" } });
      await waitUntil(() => document.querySelectorAll("#chat-compact-workers-items [data-inspect-task]").length === 1);
      absent();
      emit({ type: "item.upsert", item: { id: "task:detached", type: "background_task", taskId: "detached", createdAt: 2, description: "Detached", taskType: "agent", status: "completed", foreground: true, toolUseId: "blocker", childConversationId: "child" } });
      await waitUntil(() => document.querySelector('#chat-compact-workers [data-background-task="detached"]')?.getAttribute("data-state") === "completed", () => "settled task should remain as finished history, not active work");
      absent();
      emit({ type: "item.upsert", item: { ...tool, status: "completed" } });
      emit({ type: "item.upsert", item: { id: "tool:shell", type: "command", createdAt: 3, command: "fixture", status: "running" } });
      absent();
      emit({ type: "conversation.status", status: "completed" });
      await waitUntil(() => document.querySelector<HTMLButtonElement>("#chat-stop")!.disabled);
      absent();
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  const shellTask = (taskId: string, status: "running" | "completed", createdAt = 2) => ({
    id: `task:${taskId}`, type: "background_task", createdAt, taskId, description: `Task ${taskId}`, taskType: "local_bash",
    toolUseId: `toolu_${taskId}`, status, outputFile: `/tmp/tasks/${taskId}.output`,
  });

  for (const mode of ["desktop", "touch"] as const) test(`${mode} pending arrival and paused batch respect disclosure policy without hiding safety`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", mode);
    document.documentElement.setAttribute("data-chat-panel", "open");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let stream: { event(event: unknown, cursor: string): void } | undefined;
    const api = taskApi(document, { items: () => [], onStream: (_id, handlers) => { stream = handlers; } });
    api.status = async () => [{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["steering", "send-now"] } } }];
    let sequence = 0;
    const queued = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `pending-${index}`, text: `Pending ${index}`, delivery: "steer", paused: true, queuedAt: 1 }));
    const emit = (count: number) => {
      sequence++;
      stream!.event({ type: "conversation.queue", generation: "g", sequence, conversationId: "one", queued: queued(count), change: { kind: "paused", messageId: "pending-0" } }, `cursor-one-${sequence}`);
    };
    const toggle = () => document.querySelector<HTMLButtonElement>("[data-pending-toggle]")!;
    const click = (button: HTMLElement) => button.dispatchEvent(new window.Event("click", { bubbles: true }));
    const open = () => toggle().getAttribute("aria-expanded");
    try {
      const { initChat } = await import(`./ui.ts?pending-disclosure=${mode}-${Date.now()}`);
      initChat(api);
      await waitUntil(() => stream !== undefined);
      emit(1);
      await waitUntil(() => document.querySelectorAll("[data-chat-queued-id]").length === 1);
      expect(open()).toBe(String(mode === "desktop"));
      // Two native activations can precede the scheduled paint. Each is a
      // toggle, not two copies of a command derived from the last DOM paint.
      click(toggle()); click(toggle());
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect(open()).toBe(String(mode === "desktop"));
      if (mode === "desktop") click(toggle());
      await waitUntil(() => open() === "false");
      emit(2);
      await waitUntil(() => document.querySelectorAll("[data-chat-queued-id]").length === 2);
      expect(open()).toBe("false");
      // Paused-batch actions remain outside the collapsed entry list.
      const batch = document.querySelector<HTMLElement>(".chat-queue-batch")!;
      expect(batch.hidden).toBe(false);
      expect(batch.querySelector('[data-queue-send-now="pending-0"]')?.textContent).toBe("Send 2 paused steers now");
      expect(batch.closest("#chat-queue-items")).toBeNull();
      emit(0);
      await waitUntil(() => document.querySelectorAll("[data-chat-queued-id]").length === 0);
      emit(1);
      await waitUntil(() => document.querySelectorAll("[data-chat-queued-id]").length === 1);
      expect(open()).toBe(String(mode === "desktop"));
      if (mode === "touch") click(toggle());
      await waitUntil(() => open() === "true");
      emit(2);
      await waitUntil(() => document.querySelectorAll("[data-chat-queued-id]").length === 2);
      expect(open()).toBe("true");
    } finally { window.dispatchEvent(new Event("pagehide")); }
  });

  test("desktop opens new work, holds a deliberate collapse for its batch and isolates conversation choices", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const streams = new Map<string, { event(event: unknown, cursor: string): void }>();
    const sequences = new Map<string, number>();
    const api = taskApi(document, {
      conversations: ["one", "two"],
      items: id => id === "one"
        ? [{ id: "message:u", type: "user_message", createdAt: 1, text: "run it" }, shellTask("a", "running"),
          { id: "tool:toolu_s", type: "tool", createdAt: 2, name: "task", status: "running", input: JSON.stringify({ description: "Read the tree", subagent_type: "explore", prompt: "go" }) }]
        : [{ id: "message:u2", type: "user_message", createdAt: 1, text: "and here" }, shellTask("z", "running")],
      onStream: (id, handlers) => { streams.set(id, handlers); sequences.set(id, 0); },
    });
    const upsert = (conversationId: string, item: unknown) => {
      const sequence = (sequences.get(conversationId) ?? 0) + 1;
      sequences.set(conversationId, sequence);
      streams.get(conversationId)!.event({ type: "item.upsert", generation: "g", sequence, conversationId, item }, `cursor-${conversationId}-${sequence}`);
    };
    const tasks = document.querySelector<HTMLDetailsElement>("#chat-compact-workers")!;
    // What the browser does after `open` changes, a task later: linkedom
    // fires no `toggle`, so the tests deliver it as the page would see it.
    const toggle = (list: HTMLDetailsElement) => list.dispatchEvent(new window.Event("toggle") as unknown as Event);
    const collapse = (list: HTMLDetailsElement) => { list.open = false; toggle(list); };
    const settle = () => Bun.sleep(30);
    try {
      const { initChat } = await import(`./ui.ts?running-work-disclosure-ui-test=${Date.now()}`);
      initChat(api);
      await waitUntil(() => !tasks.hidden && streams.has("one"), () => tasks.textContent ?? "no task list");
      expect(tasks.open).toBe(true);
      expect(document.querySelector("#chat-subagents, #chat-background-tasks")).toBeNull();
      expect(tasks.querySelector('[data-inspect-task="a"]')).not.toBeNull();
      expect(tasks.querySelector('[data-stop-task="a"]')).not.toBeNull();
      toggle(tasks);

      // A deliberate collapse survives new work and settlement.
      collapse(tasks);
      upsert("one", shellTask("b", "running", 3));
      upsert("one", { id: "tool:toolu_t", type: "tool", createdAt: 3, name: "task", status: "running", input: JSON.stringify({ description: "Audit docs", subagent_type: "explore", prompt: "go" }) });
      await waitUntil(() => tasks.querySelector('[data-background-task="b"]') != null, () => tasks.textContent ?? "no task list");
      await settle();
      expect(tasks.open).toBe(false);

      // Finished work stays in the same card without undoing the collapse.
      upsert("one", shellTask("a", "completed"));
      upsert("one", shellTask("b", "completed", 3));
      upsert("one", { id: "tool:toolu_s", type: "tool", createdAt: 2, name: "task", status: "completed", input: JSON.stringify({ description: "Read the tree", subagent_type: "explore", prompt: "go" }) });
      upsert("one", { id: "tool:toolu_t", type: "tool", createdAt: 3, name: "task", status: "completed", input: JSON.stringify({ description: "Audit docs", subagent_type: "explore", prompt: "go" }) });
      await waitUntil(() => tasks.querySelector('[data-state="working"]') === null, () => tasks.textContent ?? "task list");
      expect(tasks.hidden).toBe(false);
      expect(tasks.open).toBe(false);
      upsert("one", shellTask("c", "running", 4));
      upsert("one", { id: "tool:toolu_u", type: "tool", createdAt: 4, name: "task", status: "running", input: JSON.stringify({ description: "Check links", subagent_type: "explore", prompt: "go" }) });
      await waitUntil(() => !tasks.hidden, () => "no task list");
      await settle();
      expect(tasks.open).toBe(true);
      collapse(tasks);

      // Another conversation's new work opens, but returning restores the
      // first conversation's deliberate collapse of its still-active batch.
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      select.value = "two";
      select.dispatchEvent(new window.Event("change") as unknown as Event);
      await waitUntil(() => tasks.querySelector('[data-background-task="z"]') != null, () => tasks.textContent ?? "no task list");
      expect(tasks.open).toBe(true);
      select.value = "one";
      select.dispatchEvent(new window.Event("change") as unknown as Event);
      await waitUntil(() => tasks.querySelector('[data-background-task="a"]') != null);
      expect(tasks.open).toBe(false);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("a question's owed-answer line", () => {
  // Every case here drives the real wiring from a seed the fake api serves:
  // no stream event follows a resolution, so a status line can only move by
  // the interaction handlers themselves — unlike the connected e2e flow,
  // where the resolution event's own status clear would mask these outcomes.
  const boot = async (options: {
    questions?: unknown[];
    questionResults?: Array<() => Promise<unknown>>;
    conversations?: string[];
    itemsFor?: (conversationId: string) => unknown[];
    capabilities?: string[];
    storedConversation?: string;
  } = {}) => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const previousStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
    if (options.storedConversation) {
      const values = new Map<string, string>();
      Object.defineProperty(window, "localStorage", { configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      } });
      const { presentationLocalStorage } = await import("../shell/presentation-storage");
      presentationLocalStorage()!.setItem("uatu:chat-presentation", JSON.stringify({ selectedId: options.storedConversation }));
    }
    const restoreStorage = () => {
      if (!options.storedConversation) return;
      if (previousStorage) Object.defineProperty(window, "localStorage", previousStorage);
      else delete (window as unknown as { localStorage?: Storage }).localStorage;
    };
    let questionCalls = 0;
    const questionResults = options.questionResults ?? [async () => ({})];
    const questionCallsRecord: Array<{ conversationId: string; interactionId: string; outcome: unknown; answers?: string[][] }> = [];
    const itemsFor = options.itemsFor ?? (() => [{ id: "message:u", type: "user_message", createdAt: 1, text: "please answer" }, {
      id: "question:q1", type: "question", createdAt: 2, requestId: "q1", status: "pending",
      questions: options.questions ?? [{
        prompt: "Which branch?", header: "Branch", multiple: false, allowFreeForm: true,
        optional: false, options: [{ label: "main", description: "" }],
      }],
    }]);
    const api = questionApi(document, {
      capabilities: options.capabilities,
      conversations: options.conversations,
      items: itemsFor,
    });
    Object.assign(api, {
      question: async (conversationId: string, interactionId: string, _requestId: string, outcome: unknown) => {
        questionCallsRecord.push({ conversationId, interactionId, outcome, answers: (outcome as { answers?: string[][] })?.answers });
        return await questionResults[Math.min(questionCalls++, questionResults.length - 1)]?.();
      },
    });
    await import(`./ui.ts?owed-line=${Date.now()}`).then(({ initChat }) => initChat(api));
    // The first question card the timeline mounts, whichever requestId it
    // carries — per-test items name their own questions.
    await waitUntil(() => document.querySelector("[data-chat-item-id] form[data-question-form]") != null);
    const card = document.querySelector<HTMLElement>("[data-chat-item-id] form[data-question-form]")!.closest<HTMLElement>("[data-chat-item-id]")!;
    const state = () => document.querySelector("#chat-state")?.textContent ?? "";
    return { document, window, card, state, questionCallsRecord, restoreStorage };
  };

  test("a Next advance keeps the line naming the required steps still outstanding", async () => {
    const { window, card, state } = await boot({ questions: [
      { prompt: "Q1 — Scope", header: "Which surfaces", multiple: false, allowFreeForm: true, options: [{ label: "Timeline only", description: "" }] },
      { prompt: "Q2 — Depth", header: "How deep", multiple: false, optional: true, allowFreeForm: true, options: [{ label: "Smoke", description: "" }] },
      { prompt: "Q3 — Report", header: "How reported", multiple: false, optional: true, allowFreeForm: true, options: [{ label: "Quiet", description: "" }] },
    ] });
    try {
      const form = card.querySelector("form[data-question-form]")!;
      const submitForm = () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      // linkedom tracks no form association, so the tabs and radio are handed
      // their form the way the other harness cases hand over one.
      const goto = (index: number) => {
        const tab = card.querySelector<HTMLElement>(`[data-question-tab="${index}"]`)!;
        Object.defineProperty(tab, "form", { configurable: true, value: form });
        tab.dispatchEvent(new window.Event("click", { bubbles: true }));
      };
      const panel = (index: string) => card.querySelector(`[data-question-panel="${index}"]`) as HTMLElement;

      // The empty required step holds the wizard with the owed line naming it.
      submitForm();
      expect(state()).toContain("Still to answer");
      expect(state()).toContain("Q1 — Scope");
      // Tab to the optional empty step: the line stands, naming what is owed.
      goto(1);
      expect(panel("1").hidden).toBe(false);
      expect(state()).toContain("Q1 — Scope");
      // Next past the optional empty step: the advance must not clear the line
      // while the required step stands unanswered — the tab path and the
      // advance route must settle the same whole-form outstanding set.
      submitForm();
      expect(panel("2").hidden).toBe(false);
      expect(state()).toContain("Still to answer");
      expect(state()).toContain("Q1 — Scope");
      // Answering the required step that holds the line retires it — nothing
      // outstanding remains (Q2 and Q3 were optional).
      goto(0);
      const choice = card.querySelector<HTMLInputElement>('[data-question-panel="0"] input[type="radio"]')!;
      Object.defineProperty(choice, "form", { configurable: true, value: form });
      choice.checked = true;
      choice.dispatchEvent(new window.Event("change", { bubbles: true }));
      submitForm();
      expect(state()).not.toContain("Still to answer");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("an invalid Next names the whole outstanding set, on the first gate and when repeated", async () => {
    // Two required steps, neither answered: whatever raises the owed line —
    // the advance gate or the final validation — must name both, and the
    // line must not shrink to the step that was just left when Next repeats.
    const { window, card, state } = await boot({ questions: [
      { prompt: "Q1 — Scope", header: "Which surfaces", multiple: false, allowFreeForm: true, options: [{ label: "Timeline only", description: "" }] },
      { prompt: "Q2 — Depth", header: "How deep", multiple: false, allowFreeForm: true, options: [{ label: "Smoke", description: "" }] },
    ] });
    try {
      const form = card.querySelector("form[data-question-form]")!;
      const submitForm = () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      const goto = (index: number) => {
        const tab = card.querySelector<HTMLElement>(`[data-question-tab="${index}"]`)!;
        Object.defineProperty(tab, "form", { configurable: true, value: form });
        tab.dispatchEvent(new window.Event("click", { bubbles: true }));
      };
      const panel = (index: string) => card.querySelector(`[data-question-panel="${index}"]`) as HTMLElement;

      // The first invalid Next is the gate: it stops the advance and speaks
      // the whole outstanding set, Q2 as much as Q1.
      submitForm();
      expect(state()).toContain("Still to answer");
      expect(state()).toContain("Q1 — Scope");
      expect(state()).toContain("How deep");
      expect(panel("0").hidden).toBe(false);

      // The final validation names the same full set.
      goto(1);
      submitForm();
      expect(panel("0").hidden).toBe(false);
      expect(state()).toContain("Q1 — Scope");
      expect(state()).toContain("How deep");

      // Repeating the invalid Next keeps the line naming Q2: the step just
      // left (Q1) does not replace the whole outstanding set.
      submitForm();
      expect(panel("0").hidden).toBe(false);
      expect(state()).toContain("Q1 — Scope");
      expect(state()).toContain("How deep");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("an in-flight rejection leaves another conversation's owed line standing", async () => {
    // A reject whose request is still in the air: while it flies, the reader
    // switches to a second conversation and raises the owed line for that
    // one. When the reject eventually lands, its cleanup retires its own
    // line only — the prefix the two messages share cannot be what lets it
    // follow over the other conversation's raised line.
    const rejectOne = deferred<void>();
    const { window, document, card, state } = await boot({
      conversations: ["one", "two"],
      itemsFor: conversationId => [
        { id: "message:u", type: "user_message", createdAt: 1, text: "please answer" },
        {
          id: conversationId === "one" ? "question:q1" : "question:q2", type: "question", createdAt: 2,
          requestId: conversationId, status: "pending",
          questions: [{
            prompt: conversationId === "one" ? "Which branch?" : "Which region?", header: conversationId === "one" ? "Branch" : "Region",
            multiple: false, allowFreeForm: true, options: [{ label: "main", description: "" }],
          }],
        },
      ],
      questionResults: [() => rejectOne.promise],
    });
    try {
      // Conversation one raises the owed line, then its reject goes out and
      // hangs in the api stub.
      card.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Branch");
      card.querySelector<HTMLInputElement>("[data-question-reject]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      // The reader switches to conversation two; its empty required submit
      // raises the same-shared line for that conversation.
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      select.value = "two";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitUntil(() => document.querySelector('[data-chat-item-id="question:q2"] form[data-question-form]') != null);
      document.querySelector<HTMLElement>('[data-chat-item-id="question:q2"]')!.querySelector("form[data-question-form]")!
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Region");
      // The hanging reject lands after one macrotask: every continuation
      // beyond the resolve is a microtask, so settling past one timeout
      // observes the cleanup deterministically — conversation two's line
      // stays standing.
      rejectOne.resolve();
      await flush();
      expect(state()).toBe("Still to answer: Region");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  for (const storedConversation of ["one", "two"]) test(`an old in-flight rejection does not erase a newer question's raised line (A to B to A) with stored ${storedConversation}`, async () => {
    // The reader defers conversation A's rejection, switches to B, returns
    // to A — where the conversation now carries a newer question — and
    // raises that newer question's line. The old rejection landing then
    // must not take the newer question's line down: the line's ownership
    // names the exact question request that raised it, not merely the
    // conversation both belong to.
    const rejectOld = deferred<void>();
    let firstVisit = true;
    const questionItem = (requestId: string, header: string) => ({
      id: `question:${requestId}`, type: "question", createdAt: 2, requestId, status: "pending",
      questions: [{ prompt: header, header, multiple: false, allowFreeForm: true, options: [{ label: "main", description: "" }] }],
    });
    const { window, document, card, state, questionCallsRecord, restoreStorage } = await boot({
      storedConversation,
      conversations: ["one", "two"],
      itemsFor: conversationId => [
        { id: "message:u", type: "user_message", createdAt: 1, text: "please answer" },
        conversationId === "two"
          ? questionItem("q-b", "B")
          : questionItem(firstVisit ? "q-old" : "q-new", firstVisit ? "Old A" : "New A"),
      ],
      questionResults: [() => rejectOld.promise],
    });
    try {
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      const findCard = (requestId: string) => document.querySelector<HTMLElement>(`[data-chat-item-id="question:${requestId}"]`)!;
      const submitCard = (cardElement: HTMLElement) => cardElement.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      const selectConversation = async (id: string, card: string) => {
        select.value = id;
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
        await waitUntil(() => document.querySelector(`[data-chat-item-id="question:${card}"] form[data-question-form]`) != null);
        expect(select.value).toBe(id);
        expect(findCard(card).dataset.chatItemId).toBe(`question:${card}`);
      };

      // Restoring another selected conversation is valid. Establish A through
      // the public picker rather than treating any mounted question as Old A.
      expect(select.value).toBe(storedConversation);
      expect(card.dataset.chatItemId).toBe(storedConversation === "one" ? "question:q-old" : "question:q-b");
      await selectConversation("one", "q-old");
      submitCard(findCard("q-old"));
      expect(state()).toBe("Still to answer: Old A");
      findCard("q-old").querySelector<HTMLInputElement>("[data-question-reject]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      expect(questionCallsRecord).toEqual([{ conversationId: "one", interactionId: "q-old", outcome: { kind: "rejected" }, answers: undefined }]);
      await selectConversation("two", "q-b");
      submitCard(findCard("q-b"));
      expect(state()).toBe("Still to answer: B");
      firstVisit = false;
      await selectConversation("one", "q-new");
      submitCard(findCard("q-new"));
      expect(state()).toBe("Still to answer: New A");
      // The old rejection lands: the newer question's line stays standing.
      rejectOld.resolve();
      await flush();
      expect(state()).toBe("Still to answer: New A");
      expect(questionCallsRecord).toHaveLength(1);
    } finally {
      window.dispatchEvent(new Event("pagehide"));
      restoreStorage();
    }
  });

  test("a drilldown rejection retires the parent surface's mirrored validation line", async () => {
    // A subagent's question mirrored onto the parent timeline raises the
    // parent's line; the reject is pressed from the child's own drill-down
    // and lands only after the drill-down closed. The retirement must find
    // its way back to the parent surface's line: both wirings share the one
    // ownership record, and the resolve-time surface routing ends at the
    // parent once the drill-down is gone.
    const rejectMirrored = deferred<void>();
    const mirroredItem = {
      id: "question:mirrored", type: "question", createdAt: 2, requestId: "mirrored",
      conversationId: "child", status: "pending",
      questions: [{ prompt: "Which import?", header: "Mirrored", multiple: false, allowFreeForm: true, options: [{ label: "main", description: "" }] }],
    };
    const { window, document, state } = await boot({
      capabilities: ["questions", "subagents", "background-tasks"],
      itemsFor: conversationId => conversationId === "one" ? [
        { id: "message:u", type: "user_message", createdAt: 1, text: "ask the child" },
        { id: "task:child", type: "background_task", createdAt: 1, taskId: "child", description: "The child", taskType: "local_agent", status: "running", childConversationId: "child", foreground: true },
        mirroredItem,
      ] : [mirroredItem],
      questionResults: [() => rejectMirrored.promise],
    });
    try {
      const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
      // The mirrored card raises the parent's line.
      const parentCard = document.querySelector<HTMLElement>('[data-chat-item-id="question:mirrored"]')!;
      parentCard.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Mirrored");
      // The reject goes out from the drill-down and hangs in the api stub;
      // the reader closes the drill-down while it flies.
      click(document.querySelector('#chat-compact-workers [data-inspect-task="child"]')!);
      await waitUntil(() => document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] [data-question-reject]') != null);
      click(document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] [data-question-reject]')!);
      click(document.querySelector("#chat-drilldown-back")!);
      // The rejection lands: the line it is bound to retires.
      rejectMirrored.resolve();
      await flush();
      expect(state()).toBe("");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a failed answer leaves the parent's mirrored line standing", async () => {
    // The answer's cleanup runs only once the resolution SUCCEEDS — the
    // spec's boundary for retiring raised lines. An in-flight answer whose
    // api call fails must leave the parent's still-valid validation line
    // standing (both during the flight and after the failure), with the
    // failure reported on the surface the answer ran from.
    const answer = deferred<void>();
    const mirroredItem = {
      id: "question:mirrored", type: "question", createdAt: 2, requestId: "mirrored",
      conversationId: "child", status: "pending",
      questions: [{ prompt: "Which import?", header: "Mirrored", multiple: false, allowFreeForm: true, options: [{ label: "main", description: "" }] }],
    };
    const { window, document, state } = await boot({
      capabilities: ["questions", "subagents", "background-tasks"],
      itemsFor: conversationId => conversationId === "one" ? [
        { id: "message:u", type: "user_message", createdAt: 1, text: "ask the child" },
        { id: "task:child", type: "background_task", createdAt: 1, taskId: "child", description: "The child", taskType: "local_agent", status: "running", childConversationId: "child", foreground: true },
        mirroredItem,
      ] : [mirroredItem],
      questionResults: [() => answer.promise],
    });
    try {
      const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
      // The mirrored card raises the parent's line.
      const parentForm = document.querySelector('[data-chat-item-id="question:mirrored"] form[data-question-form]')!;
      parentForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Mirrored");
      // The answer goes out from the drill-down and hangs in the api stub.
      click(document.querySelector('#chat-compact-workers [data-inspect-task="child"]')!);
      await waitUntil(() => document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] form[data-question-form]') != null);
      const childForm = document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] form[data-question-form]')!;
      const choice = childForm.querySelector<HTMLInputElement>('[data-question-panel="0"] input[type="radio"]')!;
      Object.defineProperty(choice, "form", { configurable: true, value: childForm });
      choice.checked = true;
      choice.dispatchEvent(new window.Event("change", { bubbles: true }));
      childForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      // The unresolved answer has retired nothing: the parent's validation
      // still stands.
      expect(state()).toBe("Still to answer: Mirrored");
      // The answer fails: the failure is the drill-down's status, and the
      // parent's line — still reporting its unanswered step — stands.
      answer.reject(new Error("the answer service refused"));
      await flush();
      expect(document.querySelector("#chat-drilldown-state")?.textContent).toContain("the answer service refused");
      expect(state()).toBe("Still to answer: Mirrored");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a successful answer retires validation the same request raised while it flew", async () => {
    // An in-flight answer does not make the question resolved yet: the
    // reader can arrive back at the same pending question and raise its
    // owed line again. When the answer then succeeds, that later-raised
    // line is the resolution's to retire — the cleanup has to run on
    // success, not before the api call went out.
    const answer = deferred<void>();
    const { window, document, card, state } = await boot({
      conversations: ["one", "two"], questionResults: [() => answer.promise],
      itemsFor: conversationId => [
        { id: "message:u", type: "user_message", createdAt: 1, text: "please answer" },
        {
          id: `question:${conversationId}`, type: "question", createdAt: 2, requestId: conversationId, status: "pending",
          questions: [{ prompt: "Which branch?", header: conversationId === "one" ? "Branch A" : "Branch B", multiple: false, allowFreeForm: true, options: [{ label: "main", description: "" }] }],
        },
      ],
    });
    try {
      // Conversation one's question is answered; the api call hangs.
      const form = card.querySelector("form[data-question-form]")!;
      const choice = form.querySelector<HTMLInputElement>('input[type="radio"]')!;
      Object.defineProperty(choice, "form", { configurable: true, value: form });
      choice.checked = true;
      choice.dispatchEvent(new window.Event("change", { bubbles: true }));
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      // The reader checks conversation two, comes back — the question still
      // stands unanswered — and raises its line again.
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      select.value = "two";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitUntil(() => document.querySelector('[data-chat-item-id="question:two"] form[data-question-form]') != null);
      select.value = "one";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitUntil(() => document.querySelector('[data-chat-item-id="question:one"] form[data-question-form]') != null);
      const rebuiltForm = document.querySelector('[data-chat-item-id="question:one"] form[data-question-form]')!;
      expect((rebuiltForm.querySelector("[data-question-primary]") as HTMLButtonElement).disabled).toBe(false);
      rebuiltForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Branch A");
      // The hanging answer succeeds: the line its request now owns retires.
      answer.resolve();
      await flush();
      expect(state()).toBe("");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a drilldown answer retires the parent surface's mirrored line while the drilldown stays open", async () => {
    // The parent's mirrored card raises the owed line; the answer goes out
    // from the child's drill-down, which stays open when the resolution
    // lands (and no stream event follows to clear the status either way).
    // The cleanup must retire the raising line wherever it lives — the
    // resolve ran on the child surface, but the raised line belongs to the
    // parent's — or closing the drill-down later exposes the stale status.
    const mirroredItem = {
      id: "question:mirrored", type: "question", createdAt: 2, requestId: "mirrored",
      conversationId: "child", status: "pending",
      questions: [{ prompt: "Which import?", header: "Mirrored", multiple: false, allowFreeForm: true, options: [{ label: "main", description: "" }] }],
    };
    const { window, document, state } = await boot({
      capabilities: ["questions", "subagents", "background-tasks"],
      itemsFor: conversationId => conversationId === "one" ? [
        { id: "message:u", type: "user_message", createdAt: 1, text: "ask the child" },
        { id: "task:child", type: "background_task", createdAt: 1, taskId: "child", description: "The child", taskType: "local_agent", status: "running", childConversationId: "child", foreground: true },
        mirroredItem,
      ] : [mirroredItem],
    });
    try {
      const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
      // The mirrored card raises the parent's line.
      const parentCard = document.querySelector<HTMLElement>('[data-chat-item-id="question:mirrored"]')!;
      parentCard.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Mirrored");
      // The answer goes out from the drill-down, which stays open.
      click(document.querySelector('#chat-compact-workers [data-inspect-task="child"]')!);
      await waitUntil(() => document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] form[data-question-form]') != null);
      const childForm = document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] form[data-question-form]')!;
      const choice = childForm.querySelector<HTMLInputElement>('[data-question-panel="0"] input[type="radio"]')!;
      Object.defineProperty(choice, "form", { configurable: true, value: childForm });
      choice.checked = true;
      choice.dispatchEvent(new window.Event("change", { bubbles: true }));
      childForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await flush();
      // The answer resolved the request: the parent's line retires even
      // though the drill-down — the surface the resolve ran on — is open.
      expect(state()).toBe("");
      // Closing the drill-down then exposes the parent with no stale status.
      click(document.querySelector("#chat-drilldown-back")!);
      expect(state()).toBe("");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a drilldown rejection retires both surfaces' raised lines while the drilldown stays open", async () => {
    // Both surfaces raised their own line for the one shared request; the
    // reject is pressed in the drill-down, which stays open while it lands.
    // Resolution retires the line on every surface it was raised on — not
    // merely the one the reject ran from.
    const rejectMirrored = deferred<void>();
    const mirroredItem = {
      id: "question:mirrored", type: "question", createdAt: 2, requestId: "mirrored",
      conversationId: "child", status: "pending",
      questions: [{ prompt: "Which import?", header: "Mirrored", multiple: false, allowFreeForm: true, options: [{ label: "main", description: "" }] }],
    };
    const { window, document, state } = await boot({
      capabilities: ["questions", "subagents", "background-tasks"],
      itemsFor: conversationId => conversationId === "one" ? [
        { id: "message:u", type: "user_message", createdAt: 1, text: "ask the child" },
        { id: "task:child", type: "background_task", createdAt: 1, taskId: "child", description: "The child", taskType: "local_agent", status: "running", childConversationId: "child", foreground: true },
        mirroredItem,
      ] : [mirroredItem],
      questionResults: [() => rejectMirrored.promise],
    });
    try {
      const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
      const drilldownState = () => document.querySelector("#chat-drilldown-state")?.textContent ?? "";
      // The parent's card raises the parent's line.
      const parentCard = document.querySelector<HTMLElement>('[data-chat-item-id="question:mirrored"]')!;
      parentCard.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Mirrored");
      // The drill-down's card raises that surface's own line.
      click(document.querySelector('#chat-compact-workers [data-inspect-task="child"]')!);
      await waitUntil(() => document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] form[data-question-form]') != null);
      document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] form[data-question-form]')!
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(drilldownState()).toBe("Still to answer: Mirrored");
      // The reject goes out from the drill-down and hangs in the api stub;
      // the drill-down stays open the whole time.
      click(document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] [data-question-reject]')!);
      // The rejection lands: both raised lines retire.
      rejectMirrored.resolve();
      await flush();
      expect(state()).toBe("");
      expect(drilldownState()).toBe("");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("settling one surface's form leaves the other surface's owed line standing", async () => {
    // Both surfaces carry the mirrored card, and both raised their line.
    // The reader answers the parent's own form controls — a local settlement
    // through tab navigation, not a submission — and the parent's line
    // retires by that form's standing. The child surface's line reflects
    // the child's own empty form: a settlement on one surface must never
    // erase the other surface's still-valid owed error.
    const mirroredItem = {
      id: "question:mirrored", type: "question", createdAt: 2, requestId: "mirrored",
      conversationId: "child", status: "pending",
      questions: [
        { prompt: "Which import?", header: "Mirrored", multiple: false, allowFreeForm: true, options: [{ label: "main", description: "" }] },
        { prompt: "Notes?", header: "Notes", multiple: false, optional: true, allowFreeForm: true, options: [{ label: "ok", description: "" }] },
      ],
    };
    const { window, document, state } = await boot({
      capabilities: ["questions", "subagents", "background-tasks"],
      itemsFor: conversationId => conversationId === "one" ? [
        { id: "message:u", type: "user_message", createdAt: 1, text: "ask the child" },
        { id: "task:child", type: "background_task", createdAt: 1, taskId: "child", description: "The child", taskType: "local_agent", status: "running", childConversationId: "child", foreground: true },
        mirroredItem,
      ] : [mirroredItem],
    });
    try {
      const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
      const drilldownState = () => document.querySelector("#chat-drilldown-state")?.textContent ?? "";
      // The drill-down's card raises that surface's line.
      click(document.querySelector('#chat-compact-workers [data-inspect-task="child"]')!);
      await waitUntil(() => document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] form[data-question-form]') != null);
      document.querySelector('#chat-drilldown-items [data-chat-item-id="question:mirrored"] form[data-question-form]')!
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(drilldownState()).toBe("Still to answer: Mirrored");
      // The parent's own form answers its required step, then tabs to the
      // optional one — a settlement, not a submission.
      const parentCard = document.querySelector<HTMLElement>('[data-chat-item-id="question:mirrored"]')!;
      const form = parentCard.querySelector("form[data-question-form]")!;
      const choice = form.querySelector<HTMLInputElement>('[data-question-panel="0"] input[type="radio"]')!;
      Object.defineProperty(choice, "form", { configurable: true, value: form });
      choice.checked = true;
      choice.dispatchEvent(new window.Event("change", { bubbles: true }));
      const tab = form.querySelector<HTMLElement>('[data-question-tab="1"]')!;
      Object.defineProperty(tab, "form", { configurable: true, value: form });
      tab.dispatchEvent(new window.Event("click", { bubbles: true }));
      // The parent's line had nothing of its own on it; the child's line —
      // raised for the child's still-empty form — must stand.
      expect(state()).not.toContain("Still to answer");
      expect(drilldownState()).toBe("Still to answer: Mirrored");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("tab navigation on another active form leaves the owed line its owner raised", async () => {
    // Two active forms of two different owners (a mirrored subagent
    // question and the conversation's own question) share the surface's one
    // status line. Form A's required validation raised the line; tabbing
    // across form B — whose own required step is still empty, so its
    // outstanding set is non-empty — must not rewrite the line with B's
    // names nor hand B the line: the refresh goes to the question that
    // already owns it, and B's own failed validation is what may establish
    // B's ownership.
    const { window, document, state } = await boot({
      capabilities: ["questions", "subagents", "background-tasks"],
      itemsFor: () => [
        { id: "message:u", type: "user_message", createdAt: 1, text: "please answer" },
        { id: "task:child", type: "background_task", createdAt: 1, taskId: "child", description: "The child", taskType: "local_agent", status: "running", childConversationId: "child", foreground: true },
        {
          id: "question:a", type: "question", createdAt: 2, requestId: "a1",
          conversationId: "child", status: "pending",
          questions: [{ prompt: "Which host?", header: "Host", multiple: false, allowFreeForm: true, options: [{ label: "a", description: "" }] }],
        },
        {
          id: "question:b", type: "question", createdAt: 3, requestId: "b1", status: "pending",
          questions: [
            { prompt: "Which region?", header: "Region", multiple: false, allowFreeForm: true, options: [{ label: "eu", description: "" }] },
            { prompt: "Notes?", header: "Notes", multiple: false, optional: true, allowFreeForm: true, options: [{ label: "ok", description: "" }] },
          ],
        },
      ],
    });
    try {
      const findForm = (itemId: string) => document.querySelector<HTMLElement>(`[data-chat-item-id="${itemId}"]`)!.querySelector("form[data-question-form]")!;
      const goto = (form: HTMLFormElement, index: number) => {
        const tab = document.querySelector<HTMLElement>(`[data-chat-item-id="question:b"] [data-question-tab="${index}"]`)!;
        Object.defineProperty(tab, "form", { configurable: true, value: form });
        tab.dispatchEvent(new window.Event("click", { bubbles: true }));
      };
      // Form A raises the surface line.
      findForm("question:a").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Host");
      // Tab navigation across form B, whose required step is still empty:
      // A's line is left standing, exactly as A spoke it.
      goto(findForm("question:b") as HTMLFormElement, 1);
      expect(state()).toBe("Still to answer: Host");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("an optional Next advance on another active form leaves the owed line its owner raised", async () => {
    // The same two-owner surface; the advance past form B's optional empty
    // step is navigation, not a validation failure — it must no more take
    // the line than tabbing does.
    const { window, document, state } = await boot({
      capabilities: ["questions", "subagents", "background-tasks"],
      itemsFor: () => [
        { id: "message:u", type: "user_message", createdAt: 1, text: "please answer" },
        { id: "task:child", type: "background_task", createdAt: 1, taskId: "child", description: "The child", taskType: "local_agent", status: "running", childConversationId: "child", foreground: true },
        {
          id: "question:a", type: "question", createdAt: 2, requestId: "a1",
          conversationId: "child", status: "pending",
          questions: [{ prompt: "Which host?", header: "Host", multiple: false, allowFreeForm: true, options: [{ label: "a", description: "" }] }],
        },
        {
          id: "question:b", type: "question", createdAt: 3, requestId: "b1", status: "pending",
          questions: [
            { prompt: "Notes?", header: "Notes", multiple: false, optional: true, allowFreeForm: true, options: [{ label: "ok", description: "" }] },
            { prompt: "Which region?", header: "Region", multiple: false, allowFreeForm: true, options: [{ label: "eu", description: "" }] },
          ],
        },
      ],
    });
    try {
      const findForm = (itemId: string) => document.querySelector<HTMLElement>(`[data-chat-item-id="${itemId}"]`)!.querySelector("form[data-question-form]")!;
      // Form A raises the surface line.
      findForm("question:a").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Host");
      // Next past form B's optional empty step: navigation only, A's line
      // stands.
      findForm("question:b").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Host");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a failed Next validation on the second form takes the line over from the first", async () => {
    // The other side of the coin: a genuine failed validation on form B —
    // the Next gate stopping on its empty required step — may establish B's
    // ownership, rewriting the line with B's own outstanding set. From then
    // on B settles its own line (finding 3's refresh path).
    const { window, document, state } = await boot({
      capabilities: ["questions", "subagents", "background-tasks"],
      itemsFor: () => [
        { id: "message:u", type: "user_message", createdAt: 1, text: "please answer" },
        { id: "task:child", type: "background_task", createdAt: 1, taskId: "child", description: "The child", taskType: "local_agent", status: "running", childConversationId: "child", foreground: true },
        {
          id: "question:a", type: "question", createdAt: 2, requestId: "a1",
          conversationId: "child", status: "pending",
          questions: [{ prompt: "Which host?", header: "Host", multiple: false, allowFreeForm: true, options: [{ label: "a", description: "" }] }],
        },
        {
          id: "question:b", type: "question", createdAt: 3, requestId: "b1", status: "pending",
          questions: [
            { prompt: "Which region?", header: "Region", multiple: false, allowFreeForm: true, options: [{ label: "eu", description: "" }] },
            { prompt: "Notes?", header: "Notes", multiple: false, optional: true, allowFreeForm: true, options: [{ label: "ok", description: "" }] },
          ],
        },
      ],
    });
    try {
      const findForm = (itemId: string) => document.querySelector<HTMLElement>(`[data-chat-item-id="${itemId}"]`)!.querySelector("form[data-question-form]")!;
      const goto = (form: HTMLFormElement, index: number) => {
        const tab = document.querySelector<HTMLElement>(`[data-chat-item-id="question:b"] [data-question-tab="${index}"]`)!;
        Object.defineProperty(tab, "form", { configurable: true, value: form });
        tab.dispatchEvent(new window.Event("click", { bubbles: true }));
      };
      findForm("question:a").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Host");
      // B's Next gate stops on its empty required step: the line now names
      // B's outstanding set, and B navigations keep refreshing it.
      findForm("question:b").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Region");
      goto(findForm("question:b") as HTMLFormElement, 1);
      expect(state()).toBe("Still to answer: Region");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("the owed line names the steps by the labels the tabs render", async () => {
    // The reproduced OpenCode mapping puts the long question text in the
    // structured question's header and a short label in the prompt — the
    // tab strip renders the short, distinct labels. The owed line speaks
    // through the same selection, not a divergent header-first algorithm
    // that repeats one long header for every step.
    const { window, card, state } = await boot({ questions: [
      { prompt: "Scope", header: "Which parts of the interface should this round polish", multiple: false, allowFreeForm: true, options: [{ label: "a", description: "" }] },
      { prompt: "Depth", header: "Which parts of the interface should this round polish", multiple: false, allowFreeForm: true, options: [{ label: "b", description: "" }] },
    ] });
    try {
      // The fixture is the reproduced shape: the tabs already show the two
      // short, distinct labels.
      const tabLabels = [...card.querySelectorAll<HTMLButtonElement>("[data-question-tab]")].map(tab => tab.textContent ?? "");
      expect(tabLabels[0]).toContain("Scope");
      expect(tabLabels[1]).toContain("Depth");
      card.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Scope, Depth");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("the owed line's label ties go to the header and empty mappings fall back", async () => {
    // The shared selection's edges: equal-length prompt and header pick the
    // header (the normal mappings name the label there), a missing header
    // hands the name to the prompt, and both missing speaks "the current
    // question" rather than an empty name.
    const { card, state } = await boot({ questions: [
      { prompt: "Right one", header: "Left side", multiple: false, allowFreeForm: true, options: [{ label: "a", description: "" }] },
      { prompt: "Which region?", header: "", multiple: false, allowFreeForm: true, options: [{ label: "b", description: "" }] },
      { prompt: "", header: "", multiple: false, allowFreeForm: true, options: [{ label: "c", description: "" }] },
    ] });
    try {
      card.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toBe("Still to answer: Left side, Which region?, the current question");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a successful rejection retires the line a required submit raised", async () => {
    const { window, card, state } = await boot();
    try {
      // The empty required question raises the owed line.
      card.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toContain("Still to answer");
      expect(state()).toContain("Branch");
      // Rejection resolves the request; the line a rejection leaves behind has
      // no reader left, so the guarded cleanup retires it with the form.
      card.querySelector<HTMLInputElement>("[data-question-reject]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flush();
      expect(state()).not.toContain("Still to answer");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a failed rejection speaks the failure and keeps the line standing", async () => {
    const { window, card, state } = await boot({ questionResults: [async () => { throw new Error("the question service refused"); }] });
    try {
      card.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toContain("Still to answer");
      card.querySelector<HTMLInputElement>("[data-question-reject]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flush();
      // The failure is the status now: the line names it and stands.
      expect(state()).toContain("the question service refused");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a successful rejection leaves a newer unrelated status alone", async () => {
    // A failed rejection puts a refusal on the line; a later successful
    // rejection of the still-pending question must not take that refusal down.
    const { window, card, state } = await boot({ questionResults: [async () => { throw new Error("the question service refused"); }, async () => ({})] });
    try {
      card.querySelector("form[data-question-form]")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      expect(state()).toContain("Still to answer");
      card.querySelector<HTMLInputElement>("[data-question-reject]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flush();
      expect(state()).toContain("the question service refused");
      card.querySelector<HTMLInputElement>("[data-question-reject]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await flush();
      expect(state()).toContain("the question service refused");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

function taskApi(document: Document, options: {
  items: (conversationId: string) => unknown[];
  stop?: (taskId: string) => void;
  output?: (conversationId: string, taskId: string) => { text: string; truncated: boolean; settled: boolean } | null;
  onSnapshot?: (conversationId: string) => void;
  onStream?: (conversationId: string, handlers: { event(event: unknown, cursor: string): void }) => void;
  conversations?: string[];
  // A child's snapshot as the server would state it: its cursor and status.
  childSnapshot?: () => { cursor: string; status: string };
}): ChatApiClient {
  return {
    status: async () => ([{
      agent: { id: "test", name: "Test" },
      availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["background-tasks", "subagents"] } },
    }]),
    conversations: async () => (options.conversations ?? ["one"]).map(id => ({ ...conversation(id), status: "background" })),
    commands: async () => [],
    snapshot: async (id: string) => {
      options.onSnapshot?.(id);
      const stated = id === "one" ? undefined : options.childSnapshot?.();
      return { ...snapshot(id), ...(stated ? { cursor: stated.cursor } : {}), conversation: { ...conversation(id), status: id === "one" ? "background" : stated?.status ?? "running" }, items: options.items(id) };
    },
    stream: (conversationId: string, _cursor: string, handlers: { event(event: unknown, cursor: string): void }) => {
      options.onStream?.(conversationId, handlers);
      return { close() {} };
    },
    inventoryStream: () => ({ close() {} }),
    attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    stopTask: async (_conversationId: string, taskId: string) => { options.stop?.(taskId); await new Promise(() => {}); },
    taskOutput: async (conversationId: string, taskId: string) => options.output?.(conversationId, taskId) ?? null,
  } as unknown as ChatApiClient;
}

afterAll(() => {
  for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
});

function stubConversationSelect(document: Document): void {
  const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
  let selected = "";
  Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
}

function pendingQuestion(requestId: string, createdAt: number) {
  return {
    id: `question:${requestId}`, type: "question" as const, createdAt, requestId, status: "pending" as const,
    questions: [{
      prompt: "Which branch?", header: "Branch", multiple: false, allowFreeForm: true,
      options: [{ label: "main", description: "" }],
    }],
  };
}

function questionApi(document: Document, options: { items?: (conversationId: string) => unknown[]; stream?: (handlers: { resync(): void }) => void; capabilities?: string[]; conversations?: string[] } = {}): ChatApiClient {
  const items = (conversationId: string) => options.items
    ? options.items(conversationId)
    : [{ id: "message:u", type: "user_message", createdAt: 1, text: "which branch?" }, pendingQuestion("q1", 2)];
  return {
    status: async () => ([{
      agent: { id: "test", name: "Test" },
      availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: options.capabilities ?? ["questions"] } },
    }]),
    conversations: async () => (options.conversations ?? ["one"]).map(id => conversation(id)),
    commands: async () => [],
    snapshot: async (id: string) => ({ ...snapshot(id), items: items(id) }),
    stream: (_conversationId: string, _cursor: string, handlers: { resync(): void }) => {
      options.stream?.(handlers);
      return { close() {} };
    },
    inventoryStream: () => ({ close() {} }),
    attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    question: async () => ({ outcome: "answered" }),
  } as unknown as ChatApiClient;
}

/** What the page's IntersectionObserver reports, as the pill reads it. */
type ObservedVisibility = {
  isIntersecting: boolean;
  intersectionRatio: number;
  intersectionRect: { height: number };
  rootBounds: { height: number } | null;
};

type StubObserver = {
  observed: Element[];
  disconnected: boolean;
  callback: (entries: ObservedVisibility[]) => void;
  options: { root?: Element | null; threshold?: number | number[] };
};

/**
 * The page's IntersectionObserver, replaced by one the test drives: linkedom
 * has no layout, so what a card shows of itself is supplied rather than
 * measured. Every constructed observer is collected, which is also how the
 * tests check that replaced ones are released.
 */
function stubIntersectionObservers(): { observers: StubObserver[]; restore(): void } {
  const observers: StubObserver[] = [];
  const saved = Reflect.get(globalThis, "IntersectionObserver");
  class Stub {
    readonly observed: Element[] = [];
    disconnected = false;
    constructor(readonly callback: (entries: ObservedVisibility[]) => void, readonly options: { root?: Element | null; threshold?: number | number[] }) {
      observers.push(this as unknown as StubObserver);
    }
    observe(element: Element): void { this.observed.push(element); }
    unobserve(): void {}
    disconnect(): void { this.disconnected = true; }
  }
  Reflect.set(globalThis, "IntersectionObserver", Stub);
  return { observers, restore: () => { Reflect.set(globalThis, "IntersectionObserver", saved); } };
}

/** `visible` pixels of a `cardHeight` card, inside a 600px visible band. */
function seen(visible: number, cardHeight = 200, bandHeight = 600): ObservedVisibility {
  return {
    isIntersecting: visible > 0,
    intersectionRatio: visible / cardHeight,
    intersectionRect: { height: visible },
    rootBounds: { height: bandHeight },
  };
}

async function waitForQuestionCard(document: Document): Promise<HTMLElement> {
  await waitUntil(
    () => document.querySelector('[data-chat-item-id="question:q1"] [data-question-custom-toggle]') != null,
    () => document.querySelector("#chat-state")?.textContent ?? "no question card",
  );
  return document.querySelector<HTMLElement>('[data-chat-item-id="question:q1"]')!;
}
}

// The chat surface owns no connection: every EventSource the page holds is
// the shell's one live channel. Any construction from chat code is a
// regression, whatever the fake api above does.
let eventSourceConstructions = 0;

function installDomGlobals(document: Document, window: Window): void {
  // LinkeDOM has no media queries. Model a desktop fine pointer explicitly;
  // layout and touch media behavior are exercised in the browser suites.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      media,
      matches: media === "(pointer: fine) and (hover: hover)",
      onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return true; },
    }),
  });
  const browserGlobal = window as unknown as Record<string, unknown>;
  const values: Record<string, unknown> = {
    document,
    window,
    EventSource: class { constructor() { eventSourceConstructions += 1; } addEventListener() {} close() {} },
    history: window.history ?? { back() {}, forward() {}, pushState() {}, replaceState() {} },
    navigator: window.navigator ?? {},
    Event: browserGlobal.Event,
    CustomEvent: browserGlobal.CustomEvent,
    Element: browserGlobal.Element,
    HTMLElement: browserGlobal.HTMLElement,
    HTMLButtonElement: browserGlobal.HTMLButtonElement,
    HTMLDialogElement: browserGlobal.HTMLDialogElement,
    HTMLInputElement: browserGlobal.HTMLInputElement,
    HTMLTemplateElement: browserGlobal.HTMLTemplateElement,
    HTMLTextAreaElement: browserGlobal.HTMLTextAreaElement,
    Node: browserGlobal.Node,
    NodeFilter: browserGlobal.NodeFilter ?? { SHOW_TEXT: 4 },
    MutationObserver: browserGlobal.MutationObserver,
    customElements: browserGlobal.customElements,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    CSS: { escape: (value: string) => value.replaceAll('"', '\\"') },
  };
  for (const [key, value] of Object.entries(values)) {
    if (!savedGlobals.has(key)) savedGlobals.set(key, Reflect.get(globalThis, key));
    Reflect.set(globalThis, key, value);
  }
  const elementPrototype = (browserGlobal.HTMLElement as { prototype: object }).prototype;
  Object.defineProperty(elementPrototype, "scrollIntoView", { configurable: true, value() {} });
  Object.defineProperty(elementPrototype, "scrollTo", { configurable: true, value() {} });
}

function conversation(id: string) {
  return { id, title: id, createdAt: 1, updatedAt: 1, status: "idle" as const, agent: { id: "test", name: "Test" } };
}

function snapshot(id: string): ConversationSnapshot {
  return { conversation: conversation(id), configuration: {}, generation: "g", cursor: `cursor-${id}`, items: [] };
}

function historySnapshot(id: string, reverted: boolean): ConversationSnapshot {
  const first = { id: "message:first", type: "user_message" as const, createdAt: 1, text: "first prompt" };
  const response = { id: "message:response", type: "assistant_message" as const, createdAt: 2, markdown: "response" };
  const second = { id: "message:second", type: "user_message" as const, createdAt: 3, text: "second prompt" };
  return {
    conversation: conversation(id),
    configuration: {},
    generation: "g",
    cursor: `cursor-${id}`,
    items: reverted ? [first, response] : [first, response, second],
    reversibleHistory: reverted
      ? { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: second.id, text: second.text }] }
      : { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
  };
}

function changed(text: string, attachments: Array<{ id?: string; name: string; mimeType: string }>): ReversibleHistoryResult {
  return {
    outcome: "changed",
    state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:restored", text }] },
    restoredDraft: { text, attachments },
  };
}

function chooseFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function type(input: HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(form: HTMLFormElement, input: HTMLTextAreaElement, value: string): void {
  type(input, value);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, describe = () => "Chat UI state"): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${describe()}`);
}

/**
 * One macrotask of settle: everything an already-started async resolution
 * still owes the test runs as microtasks, which all drain before a timeout
 * fires — so awaiting one timeout observes their outcome deterministically,
 * unlike a sleep racing the chain at some arbitrary depth.
 */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
