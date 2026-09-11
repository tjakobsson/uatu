import { expect, test } from "bun:test";
import { startReviewServer } from "./server";
import { createStateReconciler } from "../../src/shell/recovery";
import { fileSiblings } from "../../src/preview/file-siblings";
import type { StatePayload } from "../../src/shared/types";
import { previewImage } from "./preview-corpus";

const operationNames = ["brief.md", "config.ts", "map.svg", "notes.txt", "reference.adoc", "runbook.adoc", "sample.bin"];

test("canonical HTTP index can restore ready after resume/retry, without admitting stale generations", async () => {
  const review = await startReviewServer({ port: 4732, assets: new Map() });
  const path = "/s/atlas/api/state?compareTarget=base&scope=folder";
  let status = "loading";
  let current: StatePayload;
  const reconciler = createStateReconciler<StatePayload>({
    fetchState: async () => {
      const response = await fetch(review.url + path);
      expect(response.status).toBe(200);
      return response.json();
    },
    applyState: value => { current = value; status = "ready"; },
    freshnessOf: value => value.generatedAt,
  });
  try {
    expect(await reconciler.reconcile()).toBe(true);
    const initial = current!;
    status = "index-error"; // document channel replacement reports reconnecting
    await reconciler.reconcile();
    expect(status).toBe("ready"); // otherwise the pill says File index unavailable
    expect(reconciler.acceptFrame(initial.generatedAt)).toBe(false);
    const target = current!.roots[0]!.docs.find(doc => doc.relativePath === "examples/operations/reference.adoc")!;
    const siblings = fileSiblings(current!.roots, current!.scope, target);
    expect(siblings.kind).toBe("ready");
    if (siblings.kind === "ready") {
      expect(siblings.files.map(doc => doc.name)).toEqual(operationNames);
      expect(siblings.index).toBe(4);
      for (const [index, file] of siblings.files.entries()) {
        const result = fileSiblings(current!.roots, current!.scope, file);
        expect(result.kind === "ready" && result.index).toBe(index);
      }
    }
    expect(current!.defaultDocumentId).toBe("readme");
  } finally { review.stop(); }
});

test("HTTP and SSE share a fresh index clock across reconnect, reset and independent workspaces", async () => {
  const review = await startReviewServer({ port: 4732, assets: new Map() });
  const read = async (id = "atlas") => (await fetch(`${review.url}/s/${id}/api/state?scope=folder&compareTarget=base`)).json() as Promise<StatePayload>;
  const streamState = async () => {
    const abort = new AbortController();
    try {
      const response = await fetch(`${review.url}/s/atlas/api/events?scope=folder&compareTarget=base&reconnect=1`, { signal: abort.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const frame = new TextDecoder().decode((await response.body!.getReader().read()).value);
      return JSON.parse(frame.split("data: ")[1]!.trim()) as StatePayload;
    } finally { abort.abort(); }
  };
  try {
    const initial = await read();
    const frame = await streamState();
    const retry = await read();
    expect(frame.generatedAt).toBeGreaterThan(initial.generatedAt);
    expect(retry.generatedAt).toBeGreaterThan(frame.generatedAt);
    expect(retry.roots).toEqual(initial.roots); // freshness is not file modification
    review.protocols.enableContinuityFixture();
    const expanded = await read();
    review.protocols.reset();
    const reset = await streamState();
    expect(reset.generatedAt).toBeGreaterThan(expanded.generatedAt);
    expect(reset.roots).toEqual(initial.roots);
    await review.synthetic.backend.startWorkspace({ workspaceId: "notes", unassigned: "confirmed-without-credentials" });
    expect((await read("notes")).roots).toEqual(initial.roots);
    expect((await fetch(`${review.url}/s/missing/api/state`)).status).toBe(409);
    expect((await fetch(`${review.url}/s/atlas/api/state?scope=folder&scope=folder`)).status).toBe(400);
    expect((await fetch(`${review.url}/s/atlas/api/state?file=secret`)).status).toBe(400);
  } finally { review.stop(); }
});

test("mixed-format destinations use actual renderers and exact authenticated resources", async () => {
  const review = await startReviewServer({ port: 4732, assets: new Map() });
  const get = (path: string) => fetch(`${review.url}/s/atlas${path}`);
  const resource = (id: string, rootId = "synthetic") => `/api/document/resource?scope=folder&compareTarget=base&id=${encodeURIComponent(id)}&rootId=${rootId}`;
  try {
    for (const [name, text] of [["brief.md", "Expedition brief"], ["config.ts", "expedition"], ["notes.txt", "Synthetic observation"], ["reference.adoc", "Observation reference"]]) {
      for (const view of ["source", "rendered"]) {
        const response = await get(`/api/document?id=examples/operations/${name}&view=${view}&scope=folder&compareTarget=base`);
        expect(response.status).toBe(200);
        expect((await response.json()).html).toContain(text);
      }
    }
    const image = await get(resource("examples/operations/map.svg"));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/svg+xml");
    expect(await image.text()).toBe(previewImage);
    expect((await get(resource("examples/operations/map.svg", "other"))).status).toBe(404);
    expect((await get(resource("../../secret.svg"))).status).toBe(404);
    expect((await get("/api/document?id=examples/operations/sample.bin")).status).toBe(415);
    const bytes = await get(resource("examples/operations/sample.bin"));
    expect(bytes.headers.get("content-type")).toBe("application/octet-stream");
    expect(await bytes.text()).toBe("\0SYNTHETIC\0");
    await review.synthetic.backend.stopWorkspace("atlas");
    expect((await get("/api/state")).status).toBe(409);
    expect((await get(resource("examples/operations/map.svg"))).status).toBe(409);
    await review.synthetic.backend.signOut();
    expect((await get("/api/state")).status).toBe(401);
    expect((await get("/api/events?reconnect=1")).status).toBe(401);
    expect((await get(resource("examples/operations/map.svg"))).status).toBe(401);
  } finally { review.stop(); }
});
