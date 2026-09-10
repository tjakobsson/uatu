import { expect, test } from "@playwright/test";
import { activeTask } from './navigation';

for (const operation of ["startWorkspace", "readWorkspace", "unlockCredential"] as const) test(`matching stop fences an after-effect delayed ${operation} response`, async ({ page, request }) => {
  await request.post("/review/reset", { data: { scenario: operation === "unlockCredential" ? "credentials" : "mixed" } });
  if (operation === "unlockCredential") await request.post("/review/control/setKeyState", { data: ["pgp-locked", "unlocked"] });
  if (operation === "readWorkspace") await request.post("/review/backend/startWorkspace", { data: [{ workspaceId: "notes", unassigned: "confirmed-without-credentials" }] });
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await page.locator("#navigation-hub").click();
  let release!: () => void, arrived = false, released = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/review/backend/${operation}`, async route => {
    const response = await route.fetch();
    arrived = true; await gate;
    await route.fulfill({ response }); released = true;
  });
  await page.locator(`[data-action="${operation === "readWorkspace" ? "open" : "start"}:notes"]`).click();
  if (operation === "startWorkspace") await activeTask(page, 'confirmation').getByRole("button", { name: "Start", exact: true }).click();
  if (operation === "unlockCredential") {
    await page.getByLabel("Passphrase", { exact: true }).fill("synthetic");
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
  }
  await expect.poll(() => arrived).toBe(true);
  if (operation === "unlockCredential") await request.post("/review/backend/startWorkspace", { data: [{ workspaceId: "notes", unassigned: "not-confirmed" }] });
  const stopped = await request.post("/review/backend/stopWorkspace", { data: ["notes"] });
  expect((await stopped.json()).value.status).toBe("stopped");
  await expect(activeTask(page)).toHaveCount(0);
  await expect(activeTask(page, 'confirmation')).toHaveCount(0);
  const before = (await (await request.get("/review/state")).json()).log.filter((e: any) => e.method === "startWorkspace").length;
  release(); await expect.poll(() => released).toBe(true);
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#mobile-hub-root")).toBeVisible();
  const state = await (await request.get("/review/state")).json();
  expect(state.log.filter((e: any) => e.method === "startWorkspace")).toHaveLength(before);
  expect(state.model.workspaces.find((w: any) => w.id === "notes").runtime.status).toBe("stopped");
});

for (const typed of [false, true]) test(`an after-effect old unauthorized response cannot sign out a fresh session (typed=${typed})`, async ({ page, request }) => {
  await request.post("/review/reset", { data: { scenario: "mixed" } });
  let release!: () => void, arrived = false, released = false, first = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/review/backend/readDevices", async route => {
    if (!first) { await route.continue(); return; } first = false;
    await route.fetch(); arrived = true; await gate;
    await route.fulfill(typed ? { status: 200, contentType: "application/json", body: JSON.stringify({ status: "unavailable", problem: { kind: "unauthorized", message: "Obsolete session" } }) } : { status: 401, body: "Old session" });
    released = true;
  });
  await page.goto("/settings"); await expect.poll(() => arrived).toBe(true);
  await request.post("/review/control/invalidateAuthentication", { data: [] });
  await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
  await page.getByLabel("Username", { exact: true }).fill("reviewer");
  await page.getByLabel("Password", { exact: true }).fill("review-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in required" })).toHaveCount(0);
  release(); await expect.poll(() => released).toBe(true); await page.waitForTimeout(200);
  await expect(page.getByRole("heading", { name: "Sign in required" })).toHaveCount(0);
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="devices"]').click();
  await expect(page.locator(".mh-flow-page")).toContainText("Synthetic browser");
});
