import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersonalChatPreferencesStore } from "./personal-chat-preferences";
import { personalChatPreferencesPath } from "./state-dir";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-personal-chat-"));
  roots.push(root);
  const file = path.join(root, "personal-chat-preferences.json");
  const store = new PersonalChatPreferencesStore(file);
  await store.load();
  return { root, file, store };
}

test("personal chat preferences have a dedicated Hub state path", () => {
  expect(personalChatPreferencesPath("/state/hub")).toBe("/state/hub/personal-chat-preferences.json");
});

test("personal default ON and saved OFF survive restart independently for unusual account keys", async () => {
  const { root, file, store } = await fixture();
  const unrelated = path.join(root, "hub-preferences.json");
  await fs.writeFile(unrelated, "existing unrelated state");
  expect(store.get("alice")).toEqual({ version: 1, revision: 0, autoBackgroundOnSteer: true });
  for (const user of ["alice", "__proto__", "constructor", "a/../b", "雪"]) {
    expect(await store.update(user, { version: 1, expectedRevision: 0, autoBackgroundOnSteer: false }))
      .toEqual({ version: 1, revision: 1, autoBackgroundOnSteer: false });
  }
  const restarted = new PersonalChatPreferencesStore(file);
  await restarted.load();
  for (const user of ["alice", "__proto__", "constructor", "a/../b", "雪"]) {
    expect(restarted.get(user)).toEqual({ version: 1, revision: 1, autoBackgroundOnSteer: false });
  }
  expect(restarted.get("bob")).toEqual({ version: 1, revision: 0, autoBackgroundOnSteer: true });
  expect(await fs.readFile(unrelated, "utf8")).toBe("existing unrelated state");
});

test("concurrent devices compare revisions and observe only committed owner-only state", async () => {
  const { store, file } = await fixture();
  const writes = await Promise.allSettled([
    store.update("alice", { version: 1, expectedRevision: 0, autoBackgroundOnSteer: false }),
    store.update("alice", { version: 1, expectedRevision: 0, autoBackgroundOnSteer: true }),
  ]);
  expect(writes[0].status).toBe("fulfilled");
  expect(writes[1]).toMatchObject({ status: "rejected", reason: { code: "conflict", current: { revision: 1, autoBackgroundOnSteer: false } } });
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  const result = store.get("alice");
  result.autoBackgroundOnSteer = true;
  expect(store.get("alice").autoBackgroundOnSteer).toBe(false);
});

test("failed atomic commit retains OFF and other accounts without leftover files", async () => {
  const { store, file, root } = await fixture();
  await store.update("alice", { version: 1, expectedRevision: 0, autoBackgroundOnSteer: false });
  await store.update("bob", { version: 1, expectedRevision: 0, autoBackgroundOnSteer: false });
  const before = await fs.readFile(file, "utf8");
  const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("commit refused"));
  try {
    await expect(store.update("alice", { version: 1, expectedRevision: 1, autoBackgroundOnSteer: true })).rejects.toMatchObject({ code: "unavailable" });
    expect(store.get("alice").autoBackgroundOnSteer).toBe(false);
    expect(store.get("bob").autoBackgroundOnSteer).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect(await fs.readdir(root)).toEqual(["personal-chat-preferences.json"]);
  } finally { rename.mockRestore(); }
});

test("corrupt, unsupported and unsafe persisted state is unavailable and never overwritten", async () => {
  const { store, file } = await fixture();
  for (const text of ["{broken", '{"version":2,"records":{}}', '{"version":1,"records":{"alice":{"version":1,"revision":1,"autoBackgroundOnSteer":"false"}}}']) {
    await fs.writeFile(file, text, { mode: 0o600 });
    await store.load();
    expect(() => store.get("alice")).toThrow();
    await expect(store.update("alice", { version: 1, expectedRevision: 0, autoBackgroundOnSteer: true })).rejects.toMatchObject({ code: "unavailable" });
    expect(await fs.readFile(file, "utf8")).toBe(text);
  }
  await fs.writeFile(file, '{"version":1,"records":{}}');
  await fs.chmod(file, 0o644);
  await store.load();
  expect(() => store.get("alice")).toThrow();
  await fs.chmod(file, 0o600);
  await store.load();
  expect(store.get("alice").autoBackgroundOnSteer).toBe(true);
});

test("unreadable state never defaults ON and input contract rejects foreign identities and versions", async () => {
  const { store } = await fixture();
  const read = spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
  try {
    await store.load();
    expect(() => store.get("alice")).toThrow();
  } finally { read.mockRestore(); }
  await store.load();
  for (const input of [
    { version: 2, expectedRevision: 0, autoBackgroundOnSteer: false },
    { version: 1, expectedRevision: -1, autoBackgroundOnSteer: false },
    { version: 1, expectedRevision: 0, autoBackgroundOnSteer: "false" },
    { version: 1, expectedRevision: 0, autoBackgroundOnSteer: false, user: "bob" },
  ]) {
    await expect(store.update("alice", input as never)).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(store.get("alice").revision).toBe(0);
});
