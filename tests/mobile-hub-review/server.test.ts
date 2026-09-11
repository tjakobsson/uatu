import { expect, test } from "bun:test";
import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import { assertFreePort, buildWorkspaceAssets, startReviewServer } from "./server";
import { buildEvidenceAssets } from "./hosting-evidence";

test("actual workspace assets serve the lazy production Mermaid library under canonical workspace paths", async () => {
  const review = await startReviewServer({ port: 0, assets: await buildWorkspaceAssets() });
  const installedLibrary = await Bun.file(mermaidAsset).text();
  try {
    for (const workspace of ["atlas", "notes"]) {
      const response = await fetch(`${review.url}/s/${workspace}/assets/mermaid.min.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe(installedLibrary);
    }
    for (const suffix of ["mermaid.min.js?file=secret", "mermaid.js", "mermaid.min.js.map", "%6dermaid.min.js"]) {
      expect((await fetch(`${review.url}/s/atlas/assets/${suffix}`)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await fetch(`${review.url}/s/atlas/assets/mermaid.min.js`, { method: "POST" })).status).toBeGreaterThanOrEqual(400);
  } finally { review.stop(); }
});

test("canonical registered workspaces share only synthetic corpus, not personal or protocol state", async () => {
  const assets = new Map([["/index.html", { body: '<meta charset="utf-8"><div class="app-shell"></div>', type: "text/html" }]]);
  const review = await startReviewServer({ port: 0, assets });
  const get = (path: string) => fetch(`${review.url}${path}`);
  try {
    await review.synthetic.backend.startWorkspace({ workspaceId: "notes", unassigned: "confirmed-without-credentials" });
    for (const id of ["atlas", "notes", "missing"]) {
      const html = await (await get(`/s/${id}/`)).text();
      expect(html).toContain(`name="uatu-review-workspace" content="${id}"`);
      expect(html).toContain(`name="uatu-base-path" content="/s/${id}/"`);
    }
    expect((await get("/s/missing/api/state")).status).toBe(409);
    expect((await get("/s/missing/review/control/continuity-fixture")).status).toBe(404);
    await fetch(`${review.url}/s/notes/review/control/continuity-fixture`, { method: "POST" });
    const atlas = await (await get("/s/atlas/api/state")).text();
    const notes = await (await get("/s/notes/api/state")).text();
    expect(atlas).not.toContain("note-099.md");
    expect(notes).toContain("note-099.md");
    await review.synthetic.backend.stopWorkspace("notes");
    expect((await get("/s/notes/api/state")).status).toBe(409);
    expect((await get("/s/atlas/api/state")).status).toBe(200);
    expect((await get("/s/notes/")).status).toBe(200);
  } finally { review.stop(); }
});

test("evidence routes serve only built selections, never repository paths", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map(), evidenceAssets: await buildEvidenceAssets() });
  try {
    expect(await (await fetch(`${review.url}/review/evidence`)).text()).toContain("Simulation only");
    const report = await fetch(`${review.url}/review/evidence/visual/corrected/index.html`);
    expect(report.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(report.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${review.url}/review/evidence/visual/corrected/chromium-hub-actual.png`)).headers.get("content-type")).toBe("image/png");
    for (const path of ["baseline.json", "../baseline.json", "%2e%2e%2fbaseline.json", "visual/index.html", "responsive/history/results.json", "../../../../.env", "manifest.json?file=baseline.json"]) expect((await fetch(`${review.url}/review/evidence/${path}`)).status).toBeGreaterThanOrEqual(400);
  } finally { review.stop(); }
});

test("configured public Host requires its exact origin and never trusts forwarded headers", async () => {
  const publicOrigin = "https://review-fixture.example-tailnet.ts.net:8445";
  const review = await startReviewServer({ port: 0, assets: new Map(), publicOrigin });
  const host = new URL(publicOrigin).host;
  const get = (headers: Record<string, string>) => fetch(`${review.url}/review/health`, { headers });
  try {
    expect((await get({ Host: host, Origin: publicOrigin, Cookie: "live=ignored", Authorization: "Bearer ignored" })).status).toBe(200);
    expect((await get({ Host: host })).headers.get("set-cookie")).toBeNull();
    const rejectedHeaders: Record<string, string>[] = [{ Host: host, Origin: "https://evil.invalid" }, { Host: host, Origin: review.url }, { Origin: publicOrigin }, { Host: "evil.invalid", "X-Forwarded-Host": host, "X-Forwarded-Proto": "https" }, { Host: host, Origin: "null" }, { Host: host, "Sec-Fetch-Site": "cross-site" }];
    for (const headers of rejectedHeaders) expect((await get(headers)).status).toBe(403);
    expect((await get({ "X-Forwarded-Host": "evil.invalid" })).status).toBe(200);
    expect((await get({ Origin: review.url })).status).toBe(200);
  } finally { review.stop(); }
});

test("unconfigured listener allows only loopback Host and same-origin requests", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map() });
  const syntheticOrigin = "https://review-fixture.example-tailnet.ts.net:8445";
  try {
    const rejectedHeaders: Record<string, string>[] = [
      { Host: new URL(syntheticOrigin).host },
      { Origin: syntheticOrigin },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of rejectedHeaders) expect((await fetch(`${review.url}/review/health`, { headers })).status).toBe(403);
    expect((await fetch(`${review.url}/review/health`, { headers: { Origin: review.url } })).status).toBe(200);
  } finally { review.stop(); }
});

test("controller advertises explicit facts and exposes fenced attempt expiry via named controls", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map() });
  const post = (path: string, value: unknown) => fetch(`${review.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  try {
    const capabilities = await (await fetch(`${review.url}/review/capabilities`)).json();
    expect(capabilities).toMatchObject({ backend: "synthetic", attemptIdRequired: true, notAcceptedFencesLateSubmission: true });
    expect(capabilities.methods).toEqual(expect.arrayContaining(["readCredentialFacts", "readToolConfiguration", "reconcileCloneAttempt"]));
    expect(capabilities.controls).toContain("expireCloneAttempt");
    expect((await post("/review/control/setCredentialFactsUnknown", ["ssh-open", true])).status).toBe(200);
    expect(await (await post("/review/backend/readCredentialFacts", [{ id: "ssh-open", type: "ssh" }])).json()).toMatchObject({ value: { lock: { status: "unknown" } } });
    const intent = { attemptId: "controller-attempt", url: "https://github.com/review/repo", dest: "/synthetic", folderName: "controlled", displayName: "Controlled", credentialId: null, retainedAuthentication: [], signing: null, start: false };
    expect(await (await post("/review/backend/submitClone", [intent])).json()).toMatchObject({ value: { status: "accepted" } });
    expect((await post("/review/control/expireCloneAttempt", [intent.attemptId])).status).toBe(200);
    expect(await (await post("/review/backend/reconcileCloneAttempt", [{ attemptId: intent.attemptId }])).json()).toEqual({ status: "available", value: { status: "expired" } });
    expect((await post("/review/control/setAttemptAccepted", [intent.attemptId, "fabricated-job"])).status).toBe(400);
    expect((await post("/review/backend/readToolConfiguration", [])).status).toBe(400);
  } finally { review.stop(); }
});
import { controls, scenarios } from "./controller";

test("loopback health, explicit allowlist, independent auth, reset and stop", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map([["/index.html", { body: "actual-build-in-other-test", type: "text/html" }]]) });
  try {
    expect(await (await fetch(`${review.url}/review/health`, { headers: { Cookie: "live_hub=not-read", Authorization: "Bearer not-read" } })).json()).toMatchObject({ backend: "synthetic" });
    await expect(assertFreePort(Number(new URL(review.url).port))).rejects.toThrow();
    for (const path of ["/.env", "/src/hub/auth.ts", "/api/unknown", "/%252e%252e/private", "/..%2fprivate", "/assets/../../private"]) {
      expect((await fetch(`${review.url}${path}`)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await fetch(`${review.url}/review/reset`, { method: "POST", headers: { Origin: "https://evil.invalid", "Content-Type": "application/json" }, body: '{"scenario":"empty"}' })).status).toBe(403);
    expect((await fetch(`${review.url}/review/health`)).headers.get("set-cookie")).toBeNull();
    expect((await fetch(`${review.url}/api/state?unhandled=secret`)).status).toBe(400);
    const controller = await (await fetch(`${review.url}/review/controller`)).text();
    expect(controller).toContain("Mock backend; do not enter real credentials");
    expect((await fetch(`${review.url}/review/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"scenario":"empty"}' })).status).toBe(200);
    expect(await review.synthetic.backend.readWorkspaces()).toEqual({ status: "available", value: [] });
  } finally { review.stop(); review.stop(); }
  await expect(fetch(`${review.url}/review/health`)).rejects.toThrow();
});

test("bundles actual product HTML/client without a privileged runtime", async () => {
  const assets = await buildWorkspaceAssets();
  const html = assets.get("/index.html")!;
  const text = typeof html.body === "string" ? html.body : await html.body.text();
  expect(text).toContain('class="app-shell"');
  expect(text).not.toContain("review/controller");
  expect([...assets.keys()].some(path => path.endsWith(".js"))).toBe(true);
}, 30_000);

test("all scenarios and management controls are isolated and allowlisted; reset rejects pending effects", async () => {
  const review = await startReviewServer({ port: 0, assets: new Map() });
  const post = (path: string, data: unknown) => fetch(`${review.url}/review/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  try {
    for (const scenario of scenarios) expect((await post("reset", { scenario })).status).toBe(200);
    await post("reset", { scenario: "mixed" });
    const html = await (await fetch(`${review.url}/review/controller`)).text();
    for (const name of Object.keys(controls)) expect(html).toContain(`<option>${name}</option>`);
    for (const name of ["inspect", "backend", "reset", "toString", "__proto__"]) expect((await post(`control/${name}`, [])).status).toBe(400);
    expect((await post("control/setUnlockFailure", ["secret"])).status).toBe(400);
    expect((await post("control/advance", [-1])).status).toBe(400);
    expect((await post("control/setKeyState", ["ssh-locked", "invented"])).status).toBe(400);
    expect((await post("control/hold", ["renameWorkspace"])).status).toBe(200);
    const pending = post("backend/renameWorkspace", [{ workspaceId: "atlas", displayName: "Never committed" }]);
    for (let i = 0; i < 100 && !review.synthetic.snapshot().pending.some(p => p.count); i++) await Bun.sleep(1);
    expect(review.synthetic.snapshot().pending).toContainEqual({ method: "renameWorkspace", count: 1 });
    await post("reset", { scenario: "mixed" });
    expect(await (await pending).json()).toMatchObject({ status: "rejected" });
    expect(review.synthetic.inspect().workspaces[0]!.displayName).toBe("Atlas");
    await post("control/fail", ["readCredentials", { kind: "forbidden", message: "PRIVATE-DIAGNOSTIC" }]);
    const response = await (await post("backend/readCredentials", [])).text();
    expect(response).toContain("forbidden"); expect(response).not.toContain("PRIVATE-DIAGNOSTIC");
    expect(await (await fetch(`${review.url}/review/state`)).text()).not.toContain("PRIVATE-DIAGNOSTIC");
    await post("control/advance", [123]); expect(review.synthetic.snapshot().clock).toBeGreaterThan(123);
  } finally { review.stop(); }
});
