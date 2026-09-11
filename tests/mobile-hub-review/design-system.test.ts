import { expect, test } from "bun:test";
import { buildDesignSystemAssets, designSystemPrefix } from "./design-system-assets";
import { startReviewServer, type ReviewAssets } from "./server";

test("reference build is a closed, prefixed asset map with product recipes", async () => {
  const assets = await buildDesignSystemAssets();
  expect([...assets.keys()].every(path => path.startsWith(designSystemPrefix))).toBe(true);
  const html = await new Response(assets.get(designSystemPrefix + "design-system.html")!.body).text();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) expect(assets.has(match[1]!)).toBe(true);
  const js = await Promise.all([...assets].filter(([path]) => path.endsWith(".js")).map(async ([, asset]) => new Response(asset.body).text()));
  expect(js.join("\n")).toContain("createTaskView");
  expect(js.join("\n")).toContain("createFolderPicker");
  expect(js.join("\n")).toContain("Choose Hub folder");
  expect(js.join("\n")).toContain("No subfolders");
  expect(js.join("\n")).toContain("Loading, not empty");
  expect(js.join("\n")).toContain("Error, not empty");
  expect(js.join("\n")).not.toContain("/review/backend/");
  expect([...assets.keys()].some(path => path.endsWith(".woff2"))).toBe(true);
  const guide = assets.get(designSystemPrefix + "guide")!;
  expect(guide.type).toBe("text/plain; charset=utf-8");
  expect(await new Response(guide.body).text()).toContain("# Uatu Web UI design system");
  const manifestPath = designSystemPrefix + "manifest.json";
  const manifest = await new Response(assets.get(manifestPath)!.body).json();
  const buildOnly = new Map(assets); buildOnly.delete(manifestPath);
  expect(manifest).toEqual({ kind: "reference-content-sha256", fingerprint: await (await import("./hosting-identity")).frontendFingerprint(buildOnly) });
});

test("reference HTTP boundary, canonical redirect and workspace identity separation", async () => {
  const assets: ReviewAssets = new Map([["/index.html", { body: "workspace", type: "text/html" }]]);
  const reference: ReviewAssets = new Map([[designSystemPrefix + "design-system.html", { body: "reference", type: "text/html" }], [designSystemPrefix + "example.js", { body: "example", type: "text/javascript" }]]);
  const server = await startReviewServer({ port: 0, assets, designSystemAssets: reference });
  try {
    const get = (path: string, init?: RequestInit) => fetch(server.url + path, init);
    const health = await (await get("/review/health")).json();
    expect(await (await get("/review/design-system")).text()).toBe("reference");
    const redirect = await get(designSystemPrefix, { redirect: "manual" });
    expect(redirect.status).toBe(308); expect(redirect.headers.get("location")).toBe("/review/design-system");
    const asset = await get(designSystemPrefix + "example.js");
    expect(asset.status).toBe(200); expect(asset.headers.get("content-security-policy")).toContain("connect-src 'self'");
    for (const path of [designSystemPrefix + "private.ts", designSystemPrefix + "%2e%2e%2fserver.ts", "/review/design-system?file=server.ts", "/s/atlas/review/design-system"]) expect((await get(path)).ok).toBe(false);
    expect((await get("/review/design-system", { method: "POST" })).status).toBe(404);
    expect((await get("/review/design-system", { headers: { Origin: "https://untrusted.invalid" } })).status).toBe(403);
    expect((await (await get("/review/health")).json()).version).toEqual(health.version);
    expect((await get("/unimplemented-design-system-route")).status).toBe(501);
  } finally { server.stop(); }
  const without = await startReviewServer({ port: 0, assets });
  try { expect((await (await fetch(without.url + "/review/health")).json()).version).toEqual({ kind: "frontend-content-sha256", fingerprint: await (await import("./hosting-identity")).frontendFingerprint(assets) }); }
  finally { without.stop(); }
});
