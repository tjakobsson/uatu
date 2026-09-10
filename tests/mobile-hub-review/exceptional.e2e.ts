import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { MobileHubBackend } from "../../src/hub/mobile/backend";
import type { createSyntheticBackend, Scenario } from "./backend";
import type { ReviewControl, ReviewControlArguments } from "./controller";
import type { ReviewMethod } from "./transport";
import { activeTask, namedButton, credentialCreation, moreAction } from './navigation';

type Review = ReturnType<typeof createSyntheticBackend>;
type State = ReturnType<Review["snapshot"]> & { model: ReturnType<Review["inspect"]> };
const state = async (request: APIRequestContext): Promise<State> => (await request.get("/review/state")).json();
const count = (s: State, method: keyof MobileHubBackend) => s.log.filter(row => row.method === method).length;
const button = namedButton;
async function reset(request: APIRequestContext, scenario: Scenario = "mixed") { expect((await request.post("/review/reset", { data: { scenario } })).ok()).toBe(true); }
async function control<K extends ReviewControl>(request: APIRequestContext, method: K, args: ReviewControlArguments<K>) { expect((await request.post(`/review/control/${method}`, { data: args })).ok()).toBe(true); }
async function setup<K extends ReviewMethod>(request: APIRequestContext, method: K, args: Parameters<MobileHubBackend[K]>): Promise<Awaited<ReturnType<MobileHubBackend[K]>>> {
  const response = await request.post(`/review/backend/${method}`, { data: args }); expect(response.ok()).toBe(true);
  const result = await response.json(); expect(["available", "completed"]).toContain(result.status); return result;
}
async function browse(page: Page, path: string) {
  await page.goto("/?detail=add-workspace"); await button(page, "Existing folder").click(); await moreAction(page, 'Browse elsewhere');
  await page.getByLabel("Absolute folder path").fill(path); await button(page, "Browse").click();
  await expect(page.locator(".mh-flow-page")).toContainText(path);
}
async function rename(page: Page, name: string) {
  await moreAction(page, 'Current folder options'); await button(page, "Rename folder").click(); await page.getByLabel("New folder name").fill(name);
  await button(page, "Review").click(); await button(page, "Rename folder").click();
}
async function clone(page: Page, folder: string, start = false) {
  await page.goto("/clone"); await page.getByLabel("Remote URL").fill("https://github.com/review/exceptional.git");
  await page.getByLabel("Checkout folder name").fill(folder); await page.getByLabel("Workspace display name").fill(`Exceptional ${folder}`);
  if (start) { await page.locator('.mh-flow-page details > summary').click(); await page.getByLabel("Start after configuration").check(); }
  await button(page, "Review clone").click(); await button(page, "Clone").click(); await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
}
test.beforeEach(async ({ request }) => { await reset(request); });

test("rate-limited login preserves public fields, clears password, and waits without auto-submitting", async ({ page, request }) => {
  await reset(request, "signed-out"); await page.clock.install();
  await control(request, "fail", ["signIn", { kind: "rate-limited", message: "ignored", retryAfterSeconds: 30 }]);
  await page.goto("/"); await page.getByLabel("Username", { exact: true }).fill("reviewer");
  await page.getByLabel("Device label (optional)").fill("Exceptional phone"); await page.getByLabel("Password", { exact: true }).fill("review-only");
  await button(page, "Sign in").click(); await expect(page.locator(".mh-login [role=alert]")).toContainText("Retry after 30 seconds");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(""); await expect(page.getByLabel("Username", { exact: true })).toHaveValue("reviewer");
  await expect(page.getByLabel("Device label (optional)")).toHaveValue("Exceptional phone"); await expect(button(page, "Sign in")).toBeDisabled();
  await expect(page.locator("#mobile-hub-root")).not.toContainText("mock.invalid"); await expect(page.locator("[data-workspace]")).toHaveCount(0);
  const device = page.getByLabel("Device label (optional)"); await device.fill("Edited during cooldown"); await device.focus(); const field = await device.elementHandle();
  await control(request, "fail", ["signIn", null]); await page.clock.fastForward(31_000); await expect(button(page, "Sign in")).toBeEnabled();
  await expect(device).toHaveValue("Edited during cooldown"); await expect(device).toBeFocused(); expect(await field!.evaluate(el => el.isConnected)).toBe(true);
  expect(count(await state(request), "signIn")).toBe(1); await page.getByLabel("Password", { exact: true }).fill("review-only"); await button(page, "Sign in").click();
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible(); expect(count(await state(request), "signIn")).toBe(2);
});

test("device revocation fails contextually, then removes only the other device before current-session logout", async ({ page, request }) => {
  await page.goto("/settings?detail=devices"); await expect(page.locator(".mh-flow-page")).toContainText("Issued "); await expect(page.locator(".mh-flow-page")).not.toContainText("Last active");
  await page.locator('[data-flow="device-1"]').click(); await button(page, "Revoke session").click(); await button(page, "Cancel").click(); expect(count(await state(request), "revokeDevice")).toBe(0);
  await control(request, "hold", ["revokeDevice"]);
  try {
    await page.locator('[data-flow="device-1"]').click(); await button(page, "Revoke session").click(); await button(page, "Revoke").click(); await expect(button(page, "Revoke")).toBeDisabled();
    await control(request, "settle", ["revokeDevice", true]); await expect(activeTask(page, 'confirmation').getByRole("alert")).toContainText("Synthetic operation failed");
    expect((await state(request)).model.devices).toHaveLength(2); await button(page, "Cancel").click();
    await control(request, "fail", ["revokeDevice", null]); await page.locator('[data-flow="device-1"]').click(); await button(page, "Revoke session").click(); await button(page, "Revoke").click();
    await expect(button(page, "Revoke session")).toHaveCount(0); await expect(page.locator(".mh-flow-page h1")).toBeFocused();
    expect((await state(request)).model.devices.map(d => d.handle)).toEqual(["review-device"]);
    await page.locator('[data-flow="device-0"]').click(); await button(page, "Revoke this session").click(); await expect(activeTask(page, 'confirmation')).toContainText("signs you out"); await button(page, "Revoke").click();
    await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible(); await expect(page.locator("#mobile-hub-root")).not.toContainText("Synthetic tablet");
    expect((await state(request)).model.workspaces.find(w => w.id === "atlas")?.runtime.status).toBe("running"); expect(count(await state(request), "stopWorkspace")).toBe(0);
  } finally { await control(request, "settle", ["revokeDevice", false]); }
});

test("failed sign-out retains authentication and returns keyboard focus to its Settings trigger", async ({ page, request }) => {
  await page.goto("/settings"); await page.locator('[data-action="security"]').click(); await control(request, "hold", ["signOut"]);
  try {
    await button(page, "Sign out").click(); await activeTask(page, 'confirmation').getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(activeTask(page, 'confirmation').getByRole("button", { name: "Sign out", exact: true })).toBeDisabled();
    await control(request, "settle", ["signOut", true]); await expect(activeTask(page, 'confirmation').getByRole("alert")).toContainText("Synthetic operation failed");
    expect(await activeTask(page, 'confirmation').evaluate(el => el.contains(document.activeElement))).toBe(true);
    expect((await state(request)).authenticated).toBe(true); await expect(page.getByRole("heading", { name: "Sign in required" })).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(activeTask(page, 'confirmation')).toHaveCount(0); await expect(page.locator('[data-flow="signout"]')).toBeFocused();
    expect((await state(request)).model.workspaces.find(w => w.id === "atlas")?.runtime.status).toBe("running"); expect(count(await state(request), "stopWorkspace")).toBe(0);
  } finally { await control(request, "settle", ["signOut", false]); }
});

test("every branch variant and duplicate path remains truthful through history and information without Start", async ({ page, request }) => {
  await reset(request, "branches"); await setup(request, "stopWorkspace", ["atlas"]); await page.goto("/");
  const labels = { atlas: "review/main", notes: "draft · no commits", "branch-0": "Detached · abc1234", "branch-1": "Not a Git repository", "branch-2": "Loading branch…", "branch-3": "Branch unavailable: Synthetic metadata unavailable." };
  for (const [id, label] of Object.entries(labels)) await expect(page.locator(`[data-workspace="${id}"] .mh-status`)).toHaveText(label);
  await page.locator('[data-action="info:branch-0"]').click(); await expect(page.locator('.mh-flow-page')).toContainText("/synthetic/branch-0");
  await expect(page.locator('.mh-flow-page')).toContainText("Detached · abc1234"); await button(page, "Back").click();
  await button(page, "Settings").click(); await page.goBack(); await expect(page.locator('[data-workspace="notes"] .mh-status')).toHaveText("draft · no commits");
  expect(count(await state(request), "startWorkspace")).toBe(0); expect((await state(request)).model.workspaces.every(w => w.runtime.status === "stopped")).toBe(true);
});

test("OpenPGP generation preserves draft and sheet context through local and missing-tool errors", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 600 }); await page.goto("/settings?detail=add-credential"); await credentialCreation(page, 'openpgp');
  await page.getByLabel("Name", { exact: true }).fill("Exceptional signer"); await page.getByLabel("User ID (name and email)").fill("Exceptional <signer@mock.invalid>");
  await button(page, "Generate").click(); await expect(activeTask(page).getByRole("alert")).toContainText("passphrase is required"); expect(count(await state(request), "generateOpenPgp")).toBe(0);
  const name = await page.getByLabel("Name", { exact: true }).elementHandle(); const body = page.locator(".mh-sheet-body");
  await control(request, "setToolState", ["gpg", "missing"]); await page.getByLabel("Passphrase", { exact: true }).fill("DISPOSABLE-SIGNER");
  await control(request, "hold", ["generateOpenPgp"]);
  try {
    await button(page, "Generate").click(); const before = await body.evaluate(el => el.scrollTop);
    await expect(page.getByLabel("Passphrase", { exact: true })).toHaveValue(""); await control(request, "settle", ["generateOpenPgp", false]);
    await expect(activeTask(page).getByRole("alert")).toContainText("Required synthetic key tooling unavailable");
    expect(await name!.evaluate(el => el.isConnected)).toBe(true); await expect(page.getByLabel("User ID (name and email)")).toHaveValue("Exceptional <signer@mock.invalid>");
    expect(await body.evaluate(el => el.scrollTop)).toBe(before);
    expect(await activeTask(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab"); expect(await activeTask(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
    await control(request, "setToolState", ["gpg", "ready"]); await page.getByLabel("Passphrase", { exact: true }).fill("DISPOSABLE-SIGNER"); await button(page, "Generate").click();
    await expect(page.getByRole("heading", { name: "Exceptional signer", exact: true })).toBeVisible();
    await expect(page.locator('[data-credential-fact="userId"] .mh-value')).toHaveText("Exceptional <signer@mock.invalid>"); await expect(button(page, "Lock SSH key")).toHaveCount(0);
    expect((await state(request)).model.credentials.filter(c => c.name === "Exceptional signer")).toHaveLength(1); expect(JSON.stringify(await state(request))).not.toContain("DISPOSABLE-SIGNER");
  } finally { await control(request, "settle", ["generateOpenPgp", false]); }
});

test("SSH lock and failed independent unlock preserve protection and never start work", async ({ page, request }) => {
  await page.goto("/settings?detail=credential&id=ssh-open"); await moreAction(page, 'Lock SSH key');
  await expect(page.locator('[data-credential-fact="lock"] .mh-value')).toHaveText("locked"); await expect(page.locator('[data-credential-fact="protection"] .mh-value')).toHaveText("unprotected");
  await control(request, "setUnlockFailure", [true]); await button(page, "Unlock").click(); await page.getByLabel("Passphrase", { exact: true }).fill("DISPOSABLE-UNLOCK");
  const secret = await page.getByLabel("Passphrase", { exact: true }).elementHandle(); await activeTask(page).getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(activeTask(page).getByRole("alert")).toContainText("Synthetic unlock rejected"); await expect(page.getByLabel("Passphrase", { exact: true })).toHaveValue("");
  expect(await secret!.evaluate(el => el.isConnected)).toBe(true); expect((await state(request)).model.credentialFacts.find(c => c.id === "ssh-open")?.lock).toEqual({ status: "known", value: "locked" });
  await control(request, "setUnlockFailure", [false]); await activeTask(page).getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(activeTask(page)).toHaveCount(0); await expect(page.locator('[data-credential-fact="lock"] .mh-value')).toHaveText("unlocked");
  expect(count(await state(request), "startWorkspace")).toBe(0); expect(count(await state(request), "submitClone")).toBe(0); expect(JSON.stringify(await state(request))).not.toContain("DISPOSABLE-UNLOCK");
});

test("projected provider dependencies survive assignment replacement and a first-success second-failure stop", async ({ page, request }) => {
  await reset(request, "all-stopped");
  for (const id of ["atlas", "notes"]) {
    await setup(request, "assignWorkspace", [{ workspaceId: id, mode: "assign-new", selection: { authentication: { credentialId: "token-github", host: "github.com" } } }]);
    await setup(request, "startWorkspace", [{ workspaceId: id, unassigned: "not-confirmed" }]);
  }
  const replacement = await setup(request, "createToken", [{ name: "Replacement", host: "github.com", capabilities: ["https-git"], token: "DISPOSABLE-REPLACEMENT" }]); if (replacement.status !== "completed") throw Error("Fixture token not created");
  for (const id of ["atlas", "notes"]) await setup(request, "assignWorkspace", [{ workspaceId: id, mode: "edit-current", selection: { authentication: { credentialId: replacement.value.id, host: "github.com" } } }]);
  expect((await state(request)).model.credentials.find(c => c.id === "token-github")?.assignments).toEqual([]);
  await control(request, "setStopFailure", ["notes", true]); await page.goto("/settings?detail=credential&id=token-github");
  await moreAction(page, 'Disable'); await expect(activeTask(page, 'confirmation')).toContainText("Current assignment rows do not identify");
  await activeTask(page, 'confirmation').getByRole("button", { name: "Disable", exact: true }).click();
  await expect(activeTask(page, 'confirmation')).toContainText("atlas, notes"); await button(page, "Stop and continue").click();
  await expect(activeTask(page, 'confirmation').getByRole("alert")).toContainText("Some prior dependent sessions may have stopped");
  const snapshot = await state(request); expect(snapshot.model.workspaces.find(w => w.id === "atlas")?.runtime.status).toBe("stopped"); expect(snapshot.model.workspaces.find(w => w.id === "notes")?.runtime.status).toBe("running");
  expect(snapshot.model.credentials.find(c => c.id === "token-github")?.enabled).toBe(true); expect(snapshot.model.credentials.find(c => c.id === "token-github")?.assignments).toEqual([]);
  await page.keyboard.press("Tab"); expect(await activeTask(page, 'confirmation').evaluate(el => el.contains(document.activeElement))).toBe(true);
  await button(page, "Cancel").click(); await expect(page.locator(".mh-flow-page h1")).toBeFocused();
});

test("default-folder fallback and local/server path errors retain the owned edit and saved value", async ({ page, request }) => {
  await setup(request, "setDefaultFolder", ["/synthetic/existing"]); await control(request, "setFolderAvailable", ["/synthetic/existing", false]);
  await page.goto("/settings?detail=default-folder"); await expect(page.locator(".mh-flow-page")).toContainText("Currently Using/synthetic");
  await page.locator('[data-flow="edit"]').click(); await expect(page.getByLabel("Folder path")).toHaveValue("/synthetic/existing");
  const field = await page.getByLabel("Folder path").elementHandle(); await page.getByLabel("Folder path").fill("relative"); await button(page, "Save").click();
  await expect(activeTask(page).getByRole("alert")).toContainText("absolute folder path"); expect(count(await state(request), "setDefaultFolder")).toBe(1);
  await page.getByLabel("Folder path").fill("/synthetic/denied"); await button(page, "Save").click();
  await expect(activeTask(page).getByRole("alert")).not.toBeEmpty(); expect(await field!.evaluate(el => el.isConnected)).toBe(true); await expect(page.getByLabel("Folder path")).toHaveValue("/synthetic/denied");
  expect((await state(request)).model.defaultFolder).toMatchObject({ configured: "/synthetic/existing", configuredAvailable: false, effective: "/synthetic" });
  await button(page, "Cancel").click(); await expect(page.locator('[data-flow="edit"]')).toBeFocused();
  await page.locator('[data-flow="edit"]').click(); await button(page, 'Use Hub home folder').click();
  await expect(page.getByLabel('Folder path')).toHaveValue('');
  expect((await state(request)).model.defaultFolder.configured).toBe('/synthetic/existing');
  await button(page, 'Cancel').click();
  await page.locator('[data-flow="edit"]').click();
  await expect(page.getByLabel('Folder path')).toHaveValue('/synthetic/existing');
  await button(page, 'Use Hub home folder').click(); await button(page, "Save").click(); await expect(page.locator('.mh-flow-page')).toContainText("Hub home folder");
  expect((await state(request)).model.defaultFolder.configured).toBeNull();
});

test("nested rename preflights collision, reports after-stop failure, and retries without changing stable identities", async ({ page, request }) => {
  test.setTimeout(60_000); await reset(request, "nested"); const original = (await state(request)).model.workspaces.filter(w => w.id.startsWith("nested-"));
  await browse(page, "/synthetic/group"); await rename(page, "atlas"); await expect(page.locator(".mh-flow-error")).toContainText("destination collision");
  expect((await state(request)).model.workspaces.filter(w => w.id.startsWith("nested-")).every(w => w.runtime.status === "running")).toBe(true);
  await control(request, "setFolderFault", ["after-stop"]); await rename(page, "renamed-group");
  await expect(activeTask(page, 'confirmation')).toContainText("nested-child, nested-parent"); await button(page, "Stop and continue").click();
  await expect(activeTask(page, 'confirmation').getByRole("alert")).toContainText("paths unchanged");
  const stopped = (await state(request)).model.workspaces.filter(w => w.id.startsWith("nested-")); expect(stopped.every(w => w.runtime.status === "stopped")).toBe(true);
  expect(stopped.map(w => [w.id, w.path, w.displayName])).toEqual(original.map(w => [w.id, w.path, w.displayName]));
  await button(page, "Cancel").click(); await control(request, "setFolderFault", [null]); await rename(page, "renamed-group");
  await expect(page.locator(".mh-flow-page")).toContainText("/synthetic/renamed-group");
  const renamed = (await state(request)).model.workspaces.filter(w => w.id.startsWith("nested-"));
  expect(renamed.map(w => [w.id, w.path, w.displayName])).toEqual(original.map(w => [w.id, w.path.replace("/synthetic/group", "/synthetic/renamed-group"), w.displayName]));
});

test("empty-folder removal rejects nested contents and retains a registered child on after-stop failure", async ({ page, request }) => {
  test.setTimeout(60_000); await reset(request, "nested"); await browse(page, "/synthetic/group");
  await moreAction(page, 'Current folder options'); await button(page, "Remove empty folder").click(); await activeTask(page, 'confirmation').getByRole("button", { name: "Remove empty folder", exact: true }).click();
  await expect(page.locator(".mh-flow-error")).toContainText("not empty"); expect((await state(request)).model.workspaces.filter(w => w.id.startsWith("nested-")).every(w => w.runtime.status === "running")).toBe(true);
  await browse(page, "/synthetic/group/child"); await control(request, "setFolderFault", ["after-stop"]);
  await moreAction(page, 'Current folder options'); await button(page, "Remove empty folder").click(); await activeTask(page, 'confirmation').getByRole("button", { name: "Remove empty folder", exact: true }).click();
  await button(page, "Stop and continue").click(); await expect(activeTask(page, 'confirmation').getByRole("alert")).toContainText("folder retained");
  let snapshot = await state(request); expect(snapshot.model.workspaces.find(w => w.id === "nested-child")?.runtime.status).toBe("stopped"); expect(snapshot.model.workspaces.find(w => w.id === "nested-parent")?.runtime.status).toBe("running"); expect(snapshot.model.folders.some(f => f.path === "/synthetic/group/child")).toBe(true);
  await button(page, "Cancel").click(); await control(request, "setFolderFault", [null]);
  await moreAction(page, 'Current folder options'); await button(page, "Remove empty folder").click(); await activeTask(page, 'confirmation').getByRole("button", { name: "Remove empty folder", exact: true }).click();
  await expect(page.locator(".mh-flow-page")).toContainText("/synthetic/group");
  await expect.poll(async () => (await state(request)).model.workspaces.some(w => w.id === "nested-child")).toBe(false);
  snapshot = await state(request); expect(snapshot.model.folders.some(f => f.path === "/synthetic/group/child")).toBe(false); expect(snapshot.model.workspaces.some(w => w.id === "nested-parent")).toBe(true);
});

test("unobserved completed clone expiry keeps recovery unknown without duplicating or restarting its registered workspace", async ({ page, request }) => {
  await clone(page, "expired-completion"); const id = (await state(request)).model.jobs[0]!.id;
  await page.goto("/settings"); await control(request, "finishClone", [id, "succeeded"]); await control(request, "expireClone", [id]);
  await page.goto("/clone"); await expect(page.getByRole("heading", { name: "Clone Recovery" })).toBeVisible(); await expect(page.locator(".mh-flow-page")).toContainText("no longer authoritative enough");
  await expect(button(page, "Review clone")).toHaveCount(0); await button(page, "Back").click(); await button(page, "Hub").click();
  await expect(page.locator("[data-workspace]").filter({ hasText: "Exceptional expired-completion" })).toContainText("/synthetic/expired-completion");
  const snapshot = await state(request); expect(snapshot.model.workspaces.find(w => w.path === "/synthetic/expired-completion")?.runtime.status).toBe("stopped"); expect(count(snapshot, "submitClone")).toBe(1); expect(count(snapshot, "startWorkspace")).toBe(0);
});

test("clone completion wins a held cancel race without being relabeled or cleaned up", async ({ page, request }) => {
  await clone(page, "cancel-race"); const id = (await state(request)).model.jobs[0]!.id; const status = await page.locator("[data-clone-status]").elementHandle();
  await control(request, "hold", ["cancelClone"]);
  try {
    await moreAction(page, 'Cancel clone'); await activeTask(page, 'confirmation').getByRole("button", { name: "Cancel clone", exact: true }).click();
    await expect(page.locator("[data-clone-status]")).toContainText("Waiting for the terminal result"); await control(request, "finishClone", [id, "succeeded"]);
    await expect(page.locator("[data-clone-status]")).toContainText("registered stopped"); await control(request, "settle", ["cancelClone", false]);
    await expect.poll(async () => count(await state(request), "cancelClone")).toBe(1); await expect(page.locator("[data-clone-status]")).toContainText("registered stopped");
    expect(await status!.evaluate(el => el.isConnected && el === document.querySelector("[data-clone-status]"))).toBe(true);
    const snapshot = await state(request); expect(snapshot.model.jobs[0]!.result?.status).toBe("succeeded"); expect(snapshot.model.folders.some(f => f.path === "/synthetic/cancel-race")).toBe(true); expect(count(snapshot, "submitClone")).toBe(1);
  } finally { await control(request, "settle", ["cancelClone", false]); }
});

test("clone cancellation cleanup failure preserves an already-registered stopped workspace and explicit recovery", async ({ page, request }) => {
  await clone(page, "retained-registration", true); const id = (await state(request)).model.jobs[0]!.id;
  await control(request, "clonePhase", [id, "starting"]); await control(request, "setCloneCleanupFailure", [true]);
  await moreAction(page, 'Cancel clone'); await activeTask(page, 'confirmation').getByRole("button", { name: "Cancel clone", exact: true }).click();
  await expect(page.locator("[data-clone-status]")).toContainText("Cleanup failed"); const snapshot = await state(request);
  const retained = snapshot.model.workspaces.find(w => w.path === "/synthetic/retained-registration"); expect(retained?.runtime.status).toBe("stopped"); expect(snapshot.model.jobs[0]!.result).toMatchObject({ status: "cleanup-failed", workspaceId: retained!.id });
  await button(page, "Workspace information").click(); await expect(page.getByRole("heading", { name: "Exceptional retained-registration", exact: true })).toBeVisible();
  await expect(button(page, "Start")).toBeVisible(); expect(count(await state(request), "startWorkspace")).toBe(0); expect(count(await state(request), "forgetWorkspace")).toBe(0);
});
