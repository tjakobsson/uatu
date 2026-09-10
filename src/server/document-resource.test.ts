import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWatchSession } from "./watch-session";
import { documentResourceResponse } from "./static-files";
import { buildRoutes, type RouteAssets } from "./routes";
import { DEFAULT_WATCH_CONTEXT } from "../shared/watch-context";

test("resource route keeps exact root, encoding, pins, CLI constraints and containment", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-resource-"));
  const a = path.join(directory, "a");
  const b = path.join(directory, "b");
  await fs.mkdir(a);
  await fs.mkdir(b);
  const name = "image #?.svg";
  await fs.writeFile(path.join(a, name), '<svg xmlns="http://www.w3.org/2000/svg"><title>A</title></svg>');
  await fs.writeFile(path.join(b, name), '<svg xmlns="http://www.w3.org/2000/svg"><title>B</title></svg>');
  await fs.writeFile(path.join(b, "pin.md"), "pin");
  await fs.writeFile(path.join(b, "other.txt"), "not an image");
  const session = createWatchSession([{ kind: "dir", absolutePath: a }, { kind: "dir", absolutePath: b }], false);
  await session.start();
  try {
    const assets = { mermaid: import.meta.path, logo: import.meta.path, icon192: import.meta.path, icon512: import.meta.path, manifest: import.meta.path,
      fonts: { hackMono: import.meta.path, hackLicense: import.meta.path, nerdFontsLicense: import.meta.path, notices: import.meta.path } } satisfies RouteAssets;
    const routes = buildRoutes({ mode: "prod", assets, basePath: "/s/example/", getSession: () => session, getWorkspaceCredential: () => "test", chatService: {} as never, debug: false, getMetricsSnapshot: () => ({}) });
    const get = (routes["/s/example/api/document/resource"] as { GET: (request: Request) => Promise<Response> }).GET;
    const request = (id: string, rootId: string, extra = "") => get(new Request(`http://localhost/s/example/api/document/resource?id=${encodeURIComponent(id)}&rootId=${encodeURIComponent(rootId)}${extra}`));
    const id = path.join(b, name);
    const response = await request(id, b);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>B</title>");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await request(id, a)).status).toBe(404);
    expect((await request(id, b, `&scope=file&documentId=${encodeURIComponent(path.join(b, "pin.md"))}`)).status).toBe(404);
    expect((await request(id, b, "&scope=file&documentId=removed")).status).toBe(404);
    expect((await request(id, b, "&scope=file")).status).toBe(400);
    expect((await request(path.join(b, "other.txt"), b)).status).toBe(415);
    expect((await get(new Request("http://localhost/s/example/api/document/resource"))).status).toBe(400);

    // Recheck policy against a captured index, independently of watcher timing.
    const roots = session.getRoots();
    await fs.writeFile(path.join(b, ".uatu.json"), JSON.stringify({ ignore: { exclude: [name] } }));
    expect((await documentResourceResponse(roots, { kind: "folder" }, b, id, true)).status).toBe(404);
    await fs.rm(path.join(b, ".uatu.json"));
    await fs.rm(id);
    await fs.symlink(path.join(a, name), id);
    expect((await documentResourceResponse(roots, { kind: "folder" }, b, id, true)).status).toBe(404);

    const fileSession = createWatchSession([{ kind: "file", absolutePath: path.join(b, "pin.md"), parentDir: b }], false);
    await fileSession.start();
    try { expect((await fileSession.getDocumentResource(b, id, DEFAULT_WATCH_CONTEXT)).status).toBe(404); }
    finally { await fileSession.stop(); }
  } finally {
    await session.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
