import { expect, test } from "bun:test";
import { previewExamples, previewImagePath, renderPreviewExample } from "./preview-corpus";
import { corpus, createWorkspaceProtocols } from "./protocols";
import { startReviewServer } from "./server";

test("examples use real renderers, preserve source and coexist with legacy sentinels", async () => {
  const protocols = createWorkspaceProtocols();
  for (const example of previewExamples) {
    expect(protocols.documentPathAllowed(`/${example.path}`)).toBe(true);
    const url = new URL(`/api/document?id=${example.path}`, "http://synthetic.invalid");
    const payload = await (await protocols.handle(new Request(url), url))!.json();
    expect(payload).toEqual(await renderPreviewExample(example.path, "rendered"));
    expect(payload.html).toContain(example.kind === "text" ? 'class="uatu-source-pre"' : "<h1");
    const source = await renderPreviewExample(example.path, "source");
    expect(source!.html).toContain('class="uatu-source-pre"');
    protocols.enableContinuityFixture();
    expect(await (await protocols.handle(new Request(url), url))!.json()).toEqual(payload);
  }
  expect(corpus.roots[0]!.docs[0]).toMatchObject({ id: "readme", relativePath: "README.md" });
  expect((await renderPreviewExample("examples/START-HERE.md", "rendered"))!.html).toContain("<table>");
  expect((await renderPreviewExample("examples/guides/architecture.md", "rendered"))!.html).toContain('class="language-mermaid"');
  const runbook = (await renderPreviewExample("examples/operations/runbook.adoc", "rendered"))!.html;
  expect(runbook).toContain('class="language-mermaid"');
  expect(runbook).toContain("admonitionblock");
  expect(await renderPreviewExample("../../README.md", "rendered")).toBeNull();
  protocols.reset();
});

test("indexed image paths reject query variants even when a browser requests HTML", async () => {
  const review = await startReviewServer({ port: 4732, assets: new Map([["/index.html", { body: '<meta charset="utf-8">workspace shell', type: "text/html" }]]) });
  try {
    for (const name of ["examples/media/coast.svg", "examples/operations/map.svg", "examples/operations/sample.bin"]) {
      for (const accept of ["text/html", "image/svg+xml", "*/*"]) {
        const response = await fetch(`${review.url}/s/atlas/${name}?file=secret`, { headers: { accept } });
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    }
  } finally { review.stop(); }
});

test("indexed images negotiate workspace navigation versus embedded bytes under canonical paths", async () => {
  const review = await startReviewServer({ port: 4732, assets: new Map([["/index.html", { body: '<meta charset="utf-8">workspace shell', type: "text/html" }]]) });
  try {
    await review.synthetic.backend.startWorkspace({ workspaceId: "notes", unassigned: "confirmed-without-credentials" });
    for (const workspace of ["atlas", "notes"]) {
      for (const path of [previewImagePath, "/examples/operations/map.svg"]) {
        const url = `${review.url}/s/${workspace}${path}`;
        for (const accept of ["text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8", "text/html"]) {
          const navigation = await fetch(url, { headers: { accept } });
          expect(navigation.status).toBe(200);
          expect(navigation.headers.get("content-type")).toBe("text/html");
          expect(navigation.headers.get("vary")).toBe("Accept");
          expect(await navigation.text()).toContain(`content="/s/${workspace}/"`);
        }
        const embedded = await fetch(url, { headers: { accept: "image/avif,image/webp,image/svg+xml,image/*;q=0.8,*/*;q=0.5" } });
        expect(embedded.headers.get("content-type")).toBe("image/svg+xml");
        expect(embedded.headers.get("vary")).toBe("Accept");
        expect(await embedded.text()).toContain("SYNTHETIC COAST");
        const resource = await fetch(`${review.url}/s/${workspace}/api/document/resource?id=${path.slice(1)}&rootId=synthetic&scope=folder&compareTarget=base`);
        expect(resource.headers.get("content-type")).toBe("image/svg+xml");
        expect(await resource.text()).toContain("SYNTHETIC COAST");
      }
    }
    const state = await (await fetch(`${review.url}/s/atlas/api/state`)).json();
    expect(state.roots[0].docs).toContainEqual(expect.objectContaining({ id: previewImagePath.slice(1), kind: "binary" }));
    await review.synthetic.backend.stopWorkspace("notes");
    expect((await fetch(`${review.url}/s/notes${previewImagePath}`, { headers: { accept: "text/html" } })).status).toBe(409);
    await review.synthetic.backend.signOut();
    expect((await fetch(`${review.url}/s/atlas${previewImagePath}`, { headers: { accept: "text/html" } })).status).toBe(401);
  } finally { review.stop(); }
});

test("every rendered link and image resolves in each canonical workspace, with closed asset/auth handling", async () => {
  const assets = new Map([["/index.html", { body: '<meta charset="utf-8">', type: "text/html" }]]);
  const review = await startReviewServer({ port: 0, assets });
  const get = (path: string) => fetch(`${review.url}${path}`);
  try {
    await review.synthetic.backend.startWorkspace({ workspaceId: "notes", unassigned: "confirmed-without-credentials" });
    for (const workspace of ["atlas", "notes"]) {
      for (const example of previewExamples) {
        const page = `/s/${workspace}/${example.path}`;
        expect(await (await get(page)).text()).toContain(`content="/s/${workspace}/"`);
        const payload = await (await get(`/s/${workspace}/api/document?id=${example.path}`)).json();
        for (const match of payload.html.matchAll(/(?:href|src)="([^"]+)"/g)) {
          const target = new URL(match[1], `${review.url}${page}`);
          expect(target.origin).toBe(review.url);
          expect(target.pathname.startsWith(`/s/${workspace}/`)).toBe(true);
          if (match[1].startsWith("#")) {
            expect(payload.html).toContain(`id="${match[1].slice(1)}"`);
          } else {
            const response = await fetch(target);
            expect(response.status).toBe(200);
            if (target.pathname.endsWith(".svg")) {
              expect(response.headers.get("content-type")).toBe("image/svg+xml");
              expect(await response.text()).toContain("SYNTHETIC COAST");
            }
          }
        }
      }
    }
    for (const path of [`${previewImagePath}?file=secret`, "/examples/media/unknown.svg", "/examples/media/%63oast.svg"]) expect((await get(`/s/atlas${path}`)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${review.url}/s/atlas${previewImagePath}`, { method: "POST" })).status).toBeGreaterThanOrEqual(400);
    await review.synthetic.backend.stopWorkspace("notes");
    expect((await get(`/s/notes${previewImagePath}`)).status).toBe(409);
    expect((await get(`/s/missing${previewImagePath}`)).status).toBe(409);
    await review.synthetic.backend.signOut();
    expect((await get(`/s/atlas${previewImagePath}`)).status).toBe(401);
    expect((await get("/s/atlas/api/document?id=examples/START-HERE.md")).status).toBe(401);
  } finally { review.stop(); }
});
