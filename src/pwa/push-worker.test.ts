import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const source = await Bun.file(new URL("./push-worker.js", import.meta.url)).text();
function fixture(windows: Array<{ url: string; focus(): Promise<void>; postMessage(value: unknown): void }> = []) {
  const handlers = new Map<string, (event: any) => void>();
  const shown: Array<{ title: string; options: any }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://hub.example" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    skipWaiting: async () => {},
    registration: { showNotification: async (title: string, options: unknown) => { shown.push({ title, options }); } },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } },
  };
  runInNewContext(source, { self, URL });
  return { handlers, shown, opened, async dispatch(name: string, event: any) {
    let work: Promise<unknown> = Promise.resolve();
    handlers.get(name)!({ ...event, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    await work;
  } };
}

test("push always displays a generic notification and has no fetch handler", async () => {
  const f = fixture();
  expect(f.handlers.has("fetch")).toBe(false);
  const payload = { version: 1, id: "one", title: "Project", kind: "turn-completed", url: "/s/project/?conversation=claude%3Aone", body: "do not display this transcript" };
  await f.dispatch("push", { data: { json: () => payload } });
  await f.dispatch("push", { data: { json: () => payload } });
  expect(f.shown).toHaveLength(2);
  expect(f.shown[0]).toMatchObject({ title: "Project", options: { body: "Agent turn finished", tag: "one", renotify: false } });
  expect(f.shown[1]!.options.tag).toBe(f.shown[0]!.options.tag);
  await f.dispatch("push", { data: { json: () => { throw new Error("malformed"); } } });
  expect(f.shown).toHaveLength(3);
});

test("click reuses only the matching conversation and leaves unrelated windows alone", async () => {
  const messages: unknown[] = [];
  let focused = 0;
  const f = fixture([
    { url: "https://hub.example/s/other/?conversation=claude%3Aone", focus: async () => { throw new Error("unrelated draft"); }, postMessage() {} },
    { url: "https://hub.example/s/project/README.md?conversation=claude%3Aone", focus: async () => { focused++; }, postMessage: value => { messages.push(value); } },
  ]);
  await f.dispatch("notificationclick", { notification: { close() {}, data: { url: "https://hub.example/s/project/?conversation=claude%3Aone" } } });
  expect(focused).toBe(1);
  expect(messages).toEqual([{ type: "uatu:open-conversation", conversationId: "claude:one" }]);
  expect(f.opened).toEqual([]);
});

test("click opens a destination without an existing window and rejects foreign destinations", async () => {
  const f = fixture();
  for (const url of ["https://evil.example/s/project/?conversation=opencode%3Aone", "javascript:alert(1)", "/s/project/", "/login?conversation=opencode%3Aone"]) {
    await f.dispatch("notificationclick", { notification: { close() {}, data: { url } } });
  }
  expect(f.opened).toEqual([]);
  await f.dispatch("notificationclick", { notification: { close() {}, data: { url: "/s/project/?conversation=opencode%3Aone" } } });
  expect(f.opened).toEqual(["https://hub.example/s/project/?conversation=opencode%3Aone"]);
});
