import { expect, test } from "bun:test";
import { corpus, createWorkspaceProtocols } from "./protocols";
import { continuityCommit } from "./continuity-fixture";

test("long-content/commit fixture is opt-in and reset restores the original protocol data", async () => {
  const original = structuredClone(corpus);
  const protocols = createWorkspaceProtocols();
  const read = async (path: string) => { const url = new URL(path, "http://synthetic.invalid"); return (await protocols.handle(new Request(url), url))!.json(); };
  protocols.enableContinuityFixture();
  const expanded = await read("/api/state");
  expect(expanded.roots[0].docs).toHaveLength(original.roots[0]!.docs.length + 100);
  expect(expanded.repositories[0].commitLog[0].sha).toBe(continuityCommit);
  expect((await read("/api/document?id=readme")).html).toContain("Continuity section 79");
  expect((await read("/api/document?id=continuity-1")).path).toBe("note-001.md");
  expect(protocols.documentPathAllowed("/note-001.md")).toBe(true);
  expect(corpus).toEqual(original);
  protocols.reset();
  expect(protocols.documentPathAllowed("/note-001.md")).toBe(false);
  expect(await read("/api/state")).toEqual(original);
  expect((await read("/api/document?id=readme")).html).not.toContain("Continuity section 79");
});
