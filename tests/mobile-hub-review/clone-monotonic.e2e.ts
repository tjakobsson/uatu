import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { ReviewControl, ReviewControlArguments } from "./controller";

const state = async (request: APIRequestContext) => (await request.get("/review/state")).json();
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function control<K extends ReviewControl>(request: APIRequestContext, name: K, args: ReviewControlArguments<K>) { expect((await request.post(`/review/control/${name}`, { data: args })).ok()).toBe(true); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const hints = (page: Page) => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("uatu.hub.clone-attempt-v2:")).map(([, value]) => JSON.parse(value)));
// A delayed response has no positive UI acknowledgement when correctly ignored.
// Finish its body, then allow browser fetch continuations/rendering to drain.
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function form(page: Page) {
  await page.goto("/clone"); await page.getByLabel("Remote URL").fill("https://github.com/review/monotonic.git");
  await page.getByLabel("Checkout folder name").fill("monotonic-review"); await page.getByLabel("Workspace display name").fill("Monotonic review");
}
async function submit(page: Page) { await button(page, "Review clone").click(); await button(page, "Clone").click(); }
test.beforeEach(async ({ request }) => { expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true); });

for (const snapshot of ["pending", "unavailable"] as const) test(`old ${snapshot} reconciliation sampled before admission cannot replace accepted progress`, async ({ page, request }) => {
  await control(request, "hold", ["submitClone"]);
  if (snapshot === "unavailable") await control(request, "fail", ["reconcileCloneAttempt", { kind: "unavailable", message: "ignored" }]);
  const sampled = deferred<void>(), release = deferred<void>(); let streams = 0;
  page.on("request", req => { if (new URL(req.url()).pathname === "/review/clone-events") streams++; });
  await page.route("**/review/backend/reconcileCloneAttempt", async route => {
    const response = await route.fetch(), body = await response.json();
    expect(body.status === "available" ? body.value.status : body.status).toBe(snapshot);
    sampled.resolve(); await release.promise; await route.fulfill({ response });
  });
  try {
    await form(page); await submit(page);
    await expect.poll(async () => (await state(request)).pending).toContainEqual({ method: "submitClone", count: 1 });
    await button(page, "Reconcile original attempt").click(); await sampled.promise;
    await control(request, "settle", ["submitClone", false]); await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
    const status = await page.locator("[data-clone-status]").elementHandle(); const responseInput = page.getByLabel("Response to any remote prompt (always masked)");
    await responseInput.fill("DISPOSABLE-UNSENT"); const input = await responseInput.elementHandle(); const acceptedHint = await hints(page);
    const oldResponse = page.waitForResponse(res => new URL(res.url()).pathname === "/review/backend/reconcileCloneAttempt");
    release.resolve(); await (await oldResponse).finished(); await frames(page);
    await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
    expect(await status!.evaluate(el => el.isConnected && el === document.querySelector("[data-clone-status]"))).toBe(true);
    expect(await input!.evaluate(el => el.isConnected)).toBe(true); await expect(responseInput).toHaveValue("DISPOSABLE-UNSENT");
    expect(await hints(page)).toEqual(acceptedHint); expect(streams).toBe(1);
    const model = await state(request); expect(model.model.jobs).toHaveLength(1); expect(model.log.filter((row: { method: string }) => row.method === "submitClone")).toHaveLength(1);
  } finally { release.resolve(); await control(request, "settle", ["submitClone", false]); }
});

test("original accepted response delayed after its effect cannot rewrite a hint retired by the reconciled job's terminal result", async ({ page, request }) => {
  const admitted = deferred<void>(), release = deferred<void>(); let streams = 0;
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    (window as Window & { cloneHintWrites?: number }).cloneHintWrites = 0;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === sessionStorage && key.startsWith("uatu.hub.clone-attempt-v2:")) {
        const observed = window as Window & { cloneHintWrites?: number }; observed.cloneHintWrites = (observed.cloneHintWrites ?? 0) + 1;
      }
      original.call(this, key, value);
    };
  });
  page.on("request", req => { if (new URL(req.url()).pathname === "/review/clone-events") streams++; });
  await page.route("**/review/backend/submitClone", async route => {
    const response = await route.fetch(), body = await response.json(); expect(body).toMatchObject({ status: "completed", value: { status: "accepted" } });
    admitted.resolve(); await release.promise; await route.fulfill({ response });
  });
  try {
    await form(page); await submit(page); await admitted.promise;
    await button(page, "Reconcile original attempt").click(); await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
    const id = (await state(request)).model.jobs[0].id; await control(request, "finishClone", [id, "succeeded"]);
    await expect(page.locator("[data-clone-status]")).toContainText("registered stopped"); expect(await hints(page)).toEqual([]);
    const terminal = await page.locator("[data-clone-status]").elementHandle();
    const writes = await page.evaluate(() => (window as Window & { cloneHintWrites?: number }).cloneHintWrites);
    const originalResponse = page.waitForResponse(res => new URL(res.url()).pathname === "/review/backend/submitClone");
    release.resolve(); await (await originalResponse).finished(); await frames(page);
    expect(await hints(page)).toEqual([]); expect(await page.evaluate(() => (window as Window & { cloneHintWrites?: number }).cloneHintWrites)).toBe(writes);
    expect(await terminal!.evaluate(el => el.isConnected && el === document.querySelector("[data-clone-status]"))).toBe(true);
    await expect(page.locator("[data-clone-status]")).toContainText("registered stopped"); expect(streams).toBe(1);
    await page.reload(); await expect(page.getByLabel("Remote URL")).toHaveValue(""); expect(streams).toBe(1);
    expect((await state(request)).model.jobs).toHaveLength(1);
  } finally { release.resolve(); }
});

for (const url of ["ssh://git:DISPOSABLE@github.com:notaport/repo", "ssh://git:DISPOSABLE@", "git+ssh://git:DISPOSABLE@host:bad/repo"]) test(`malformed SSH URI ${url} clears the original node and cannot survive a Settings detour`, async ({ page, request }) => {
  await form(page); const field = page.getByLabel("Remote URL"), original = await field.elementHandle();
  await field.fill(url); await expect(field).toHaveValue(""); expect(await original!.evaluate(el => (el as HTMLInputElement).value)).toBe("");
  expect(await original!.evaluate(el => el.isConnected)).toBe(true);
  await button(page, "Settings").click(); expect(await original!.evaluate(el => (el as HTMLInputElement).value)).toBe("");
  await page.goBack(); await expect(field).toHaveValue(""); await expect(page.locator(".mh-flow-page")).not.toContainText("DISPOSABLE");
  expect(JSON.stringify(await hints(page))).not.toContain("DISPOSABLE"); expect((await state(request)).log.filter((row: { method: string }) => row.method === "submitClone")).toHaveLength(0);
});

test("username-only SSH and SCP remotes remain intact across Settings detours", async ({ page }) => {
  await form(page);
  for (const url of ["ssh://git@github.com/repo", "ssh://git@github.com:2222/repo", "git@github.com:review/repo", "git@[::1]:review/repo"]) {
    await page.getByLabel("Remote URL").fill(url); await button(page, "Settings").click(); await page.goBack();
    await expect(page.getByLabel("Remote URL")).toHaveValue(url);
  }
});
