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
    expect(payload.html).toContain("<h1");
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
