import { createServer } from "node:http";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Fixed artifact snapshot only: no configurable filesystem root, directory
// listing, request-time disk access, or fallback to the live demo/product.
const directory = fileURLToPath(new URL("../../test-results/worktree-gallery.e2e.ts-desktop-worktree-review-gallery/", import.meta.url));
const hosts = new Set(["127.0.0.1:4789", "localhost:4789"]);
const configuredOrigin = process.env.UATU_WORKTREE_GALLERY_ORIGIN;
if (configuredOrigin !== undefined) {
  const origin = new URL(configuredOrigin);
  if (origin.protocol !== "https:" || origin.origin !== configuredOrigin) throw new Error("Gallery origin must be an exact HTTPS origin without credentials, path or trailing slash");
  hosts.add(origin.host);
}
if ((await realpath(directory)) !== directory.replace(/\/$/, "")) throw new Error("Gallery directory must not contain symlinks");
const files = new Map<string, { bytes: Buffer; type: string }>();
for (const name of await readdir(directory)) {
  if (name !== "index.html" && name !== "README.md" && !/^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.png$/.test(name)) continue;
  const location = `${directory}${name}`;
  if (!(await lstat(location)).isFile()) throw new Error(`Gallery artifact is not a regular file: ${name}`);
  files.set(`/${name}`, { bytes: await readFile(location), type: name.endsWith(".png") ? "image/png" : name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
}
if (!files.has("/index.html") || !files.has("/README.md")) throw new Error("Generate the desktop gallery before starting its server");
const server = createServer((request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  if (!hosts.has(request.headers.host ?? "")) { response.writeHead(403).end(); return; }
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
  // Match the raw request target: percent escapes, traversal, queries, nested
  // paths, absolute URLs and unlisted basenames are all denied, not normalized.
  const file = files.get(request.url === "/" ? "/index.html" : request.url ?? "");
  if (!file) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": file.type, "Content-Length": file.bytes.length });
  response.end(request.method === "HEAD" ? undefined : file.bytes);
});
server.listen(4789, "127.0.0.1", () => console.log(JSON.stringify({ gallery: "http://127.0.0.1:4789/", publicOrigin: configuredOrigin, pid: process.pid, artifacts: files.size, snapshot: true })));
