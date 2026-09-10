import { expect, test } from "bun:test";
import { createTaskHistory } from "./task-history";

function harness() {
  const entries = [{ state: {}, url: "/" }, { state: { mobileHub: { route: "settings" } }, url: "/settings" }]; let index = 1, backs = 0;
  const history = { get state(): any { return entries[index]!.state; }, pushState(state: any, _title: string, url: string) { entries.splice(++index); entries.push({ state, url }); }, replaceState(state: any, _title: string, url: string) { entries[index] = { state, url }; }, back() { backs++; } };
  const owner = createTaskHistory(history, () => entries[index]!.url);
  return { owner, entries, history, get backs() { return backs; }, pop(steps = 1) { index -= steps; return owner.consumePop(); }, get url() { return entries[index]!.url; } };
}
test("Cancel consumes one workflow entry; a same-turn result replaces it without a queued Back", async () => {
  const h = harness(); h.owner.open({ route: "settings" }); h.owner.close();
  h.owner.write({ mobileHub: { route: "settings" } }, "/settings?detail=credential&id=new", false);
  await Promise.resolve(); expect(h.backs).toBe(0); expect(h.entries.map(e => e.url)).toEqual(["/", "/settings", "/settings?detail=credential&id=new"]);
  const c = harness(); c.owner.open({ route: "settings" }); c.owner.close(); await Promise.resolve();
  expect(c.backs).toBe(1); expect(c.pop()).toBe(true); expect(c.url).toBe("/settings");
  expect(c.pop()).toBe(false); expect(c.url).toBe("/");
});
test("a late result is serialized behind owned Back rather than being overwritten by its pop", async () => {
  const h = harness(); h.owner.open({ route: "settings" }); h.owner.close(); await Promise.resolve();
  h.owner.write({ mobileHub: { route: "settings" } }, "/settings?detail=credential&id=new", false);
  expect(h.pop()).toBe(true); expect(h.url).toBe("/settings?detail=credential&id=new");
  expect(h.entries.map(e => e.url)).toEqual(["/", "/settings", "/settings?detail=credential&id=new"]);
});
test("Back-to-edit replacement stays in one entry and stores no form state", async () => {
  const h = harness(); h.owner.open({ route: "settings" }); h.owner.close(); h.owner.open({ route: "settings" });
  await Promise.resolve(); expect(h.backs).toBe(0); expect(h.entries).toHaveLength(3);
  expect(h.history.state).toEqual({ mobileHub: { route: "settings", task: true } });
});
test("an unrelated history traversal wins over a queued task result", async () => {
  const h = harness(); h.owner.open({ route: "settings" }); h.owner.close(); await Promise.resolve();
  h.owner.write({ mobileHub: { route: "settings" } }, "/settings?detail=credential&id=stale", false);
  expect(h.pop(2)).toBe(false); expect(h.url).toBe("/"); expect(h.owner.pending).toBe(false);
});
test("a task opened by a queued result inherits the result context, not the old address bar", async () => {
  const h = harness(); h.owner.open({ route: "settings" }); h.owner.close(); await Promise.resolve();
  h.owner.write({ mobileHub: { route: "settings" } }, "/settings?detail=credential&id=new", false);
  h.owner.open({ route: "settings" });
  expect(h.owner.contextUrl).toBe("/settings?detail=credential&id=new");
  expect(h.pop()).toBe(true); expect(h.url).toBe("/settings?detail=credential&id=new"); expect(h.history.state.mobileHub.task).toBe(true);
});
test("blocked pending Back restores one entry synchronously; subsequent close/result still owns history", async () => {
  const h = harness(); h.owner.open({ route: "settings" });
  for (let i = 0; i < 2; i++) {
    expect(h.pop()).toBe(false); h.owner.open({ route: "settings" });
    expect(h.entries).toHaveLength(3); expect(h.owner.pending).toBe(false);
  }
  h.owner.close(); h.owner.write({ mobileHub: { route: "settings" } }, "/settings?detail=workspace&id=created", false);
  await Promise.resolve(); expect(h.backs).toBe(0); expect(h.url).toBe("/settings?detail=workspace&id=created");
});
