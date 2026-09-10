import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import type { PublicCredentialDto } from "../../src/hub/credential-types";
import { test, expect, loginHub, hubPost } from "./hub-mobile-fixtures";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("current defaults, explicit replacement review, draft refresh and shared device preferences", async ({ page, context, hub }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await loginHub(page, hub);
  const post = <T>(route: string, data?: unknown) => hubPost<T>(page.request, hub, route, data);
  const a = (await post<{ workspace: { id: string } }>("/api/hub/workspaces/configure", { path: hub.workspaces.a, displayName: "A" })).workspace.id;
  const credentials: PublicCredentialDto[] = [];
  for (const name of ["Current", "Replacement"]) credentials.push((await post<{ credential: PublicCredentialDto }>("/api/hub/credentials/token", {
    name, host: "github.com", token: "not-a-provider-token", capabilities: ["https-git"],
  })).credential);
  const signing = (await post<{ credential: PublicCredentialDto }>("/api/hub/credentials/ssh/generate", { name: "Current signing", capabilities: ["ssh-signing"], passphrase: "test-passphrase" })).credential;
  await post(`/api/hub/workspaces/${a}/credential-assignments`, { authentication: { credentialId: credentials[0]!.id, host: "github.com" }, signing: { credentialId: signing.id } });
  await page.goto(`${hub.origin}/settings`);
  await page.getByText("Workspace assignments", { exact: true }).click();
  const form = page.locator(".workspace-assignment-form");
  await expect(form.getByLabel("Authentication", { exact: false }).first()).toHaveValue(credentials[0]!.id);
  await expect(form.locator("select").nth(3)).toHaveValue(signing.id);
  const requests: unknown[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/credential-assignments")) requests.push(request.postDataJSON()); });
  await form.getByRole("button", { name: "Assign selected" }).click();
  await expect(page.locator("#workspace-credential-assignments > .local-error")).toHaveText("No changes to the current defaults.");
  expect(requests).toHaveLength(0);
  await form.getByLabel("Intent").selectOption("assign");
  await form.locator("select").nth(2).selectOption(credentials[1]!.id);
  page.once("dialog", dialog => dialog.dismiss());
  await form.getByRole("button", { name: "Assign selected" }).click();
  expect(requests).toHaveLength(0);
  await expect(form.locator("select").nth(2)).toHaveValue(credentials[1]!.id);
  await expect(form.getByRole("button", { name: "Assign selected" })).toBeFocused();
  // Refresh through the actual page-cache lifecycle; the assignment node owns its draft.
  const added = (await post<{ credential: PublicCredentialDto }>("/api/hub/credentials/token", { name: "Newly created", host: "github.com", token: "test-only", capabilities: ["https-git"] })).credential;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(form.locator("select").nth(2)).toHaveValue(credentials[1]!.id);
  await expect(form.locator(`option[value="${added.id}"]`)).toHaveCount(1);
  await expect(form.getByRole("button", { name: "Assign selected" })).toBeFocused();
  page.once("dialog", dialog => dialog.accept());
  await form.getByRole("button", { name: "Assign selected" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ authentication: { credentialId: credentials[1]!.id, host: "github.com" } });
  const other = await context.newPage();
  await other.goto(`${hub.origin}/settings`);
  await page.locator("#navigation-side").selectOption("right");
  await page.locator("#navigation-auto-hide").selectOption("false");
  await page.locator("#navigation-preview-side").selectOption("right");
  await expect(other.locator("#navigation-side")).toHaveValue("right");
  await expect(other.locator("#navigation-auto-hide")).toHaveValue("false");
  await expect(other.locator("#navigation-preview-side")).toHaveValue("right");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("uatu:navigation:v1:hub")!));
  expect(stored).toEqual({ side: "right", position: 0.72, autoHide: false, previewSide: "right" });
  await other.close();
});

test("clone unlock cancellation retains non-secret intent and successful continuation submits once", async ({ page, hub }) => {
  test.setTimeout(120_000);
  await loginHub(page, hub);
  const post = <T>(route: string, data?: unknown) => hubPost<T>(page.request, hub, route, data);
  await post("/api/hub/settings/workspace-defaults", { defaultWorkspaceParent: hub.root });
  const passphrase = "test-only-passphrase";
  const key = (await post<{ credential: PublicCredentialDto }>("/api/hub/credentials/ssh/generate", {
    name: "Locked signing", capabilities: ["ssh-signing"], passphrase,
  })).credential;
  await page.goto(`${hub.origin}/clone`);
  await expect(page.locator("#clone-signing option")).toHaveCount(2);
  // Real local Git clone: isolated repository, no network or projected credentials.
  execFileSync("git", ["-C", hub.workspaces.a, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "."], { env: hub.env });
  execFileSync("git", ["-C", hub.workspaces.a, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { env: hub.env });
  await page.locator("#clone-url").fill(hub.workspaces.a);
  await page.locator("#clone-folder-name").fill("new-checkout");
  await page.locator("#clone-display-name").fill("Preserved draft");
  await page.locator("#clone-signing").selectOption(key.id);
  await page.locator("#clone-start-after").check();
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url() === `${hub.origin}/api/hub/clone-jobs`) submissions++; });
  await page.locator('#clone-form button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Unlock credentials to start after clone");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(submissions).toBe(0);
  await expect(page.locator("#clone-url")).toHaveValue(hub.workspaces.a);
  await expect(page.locator("#clone-folder-name")).toHaveValue("new-checkout");
  await expect(page.locator("#clone-display-name")).toHaveValue("Preserved draft");
  await expect(page.locator("#clone-signing")).toHaveValue(key.id);
  await page.locator('#clone-form button[type="submit"]').click();
  await dialog.getByLabel("Locked signing passphrase").fill(passphrase);
  await dialog.getByRole("button", { name: "Unlock and clone" }).click();
  await expect(page).toHaveURL(/\/s\/new-checkout\//, { timeout: 45_000 });
  expect(submissions).toBe(1);
  let releaseBrowse!: () => void;
  const browseGate = new Promise<void>(resolve => { releaseBrowse = resolve; });
  await page.route("**/api/hub/browse", async route => {
    const response = await route.fetch();
    await browseGate;
    await route.fulfill({ response });
  });
  await page.goto(`${hub.origin}/clone`);
  await expect(page.locator("#clone-start-after")).not.toBeChecked();
  await page.locator("#clone-url").fill(hub.workspaces.a);
  await page.locator("#clone-folder-name").fill("stopped-checkout");
  await page.locator('#clone-form button[type="submit"]').click();
  await expect(page.locator("#clone-form-error")).toContainText("destination folder is not loaded");
  expect(submissions).toBe(1);
  releaseBrowse();
  await expect(page.locator("#browse-path")).toHaveText(hub.root);
  await page.unroute("**/api/hub/browse");
  // Delay only this client's event transport, then reconnect to the real
  // owner's retained job replay after reloading the production document.
  await page.route("**/api/hub/clone-jobs/*/events", route => route.abort());
  await page.locator('#clone-form button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("uatu.activeCloneJob"))).not.toBeNull();
  await page.unroute("**/api/hub/clone-jobs/*/events");
  await page.reload();
  await expect(page.locator("#clone-phase")).toContainText("Workspace added. Start it", { timeout: 30_000 });
  const workspaces = (await (await page.request.get(`${hub.origin}/api/hub/state`)).json()).workspaces;
  expect(workspaces.find((w: { id: string }) => w.id === "stopped-checkout").running).toBe(false);
  expect(submissions).toBe(2);
});

test("all credential types keep capability actions, contextual secret errors, tools and device revocation", async ({ page, context, hub }) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  await loginHub(page, hub);
  const post = <T>(route: string, data?: unknown) => hubPost<T>(page.request, hub, route, data);
  const ssh = (await post<{ credential: PublicCredentialDto }>("/api/hub/credentials/ssh/generate", { name: "SSH identity", capabilities: ["ssh-authentication", "ssh-signing"], passphrase: "test-passphrase" })).credential;
  const pgp = (await post<{ credential: PublicCredentialDto }>("/api/hub/credentials/openpgp/generate", { name: "OpenPGP identity", userId: "Test <test@example.invalid>", passphrase: "test-passphrase" })).credential;
  const tokens: PublicCredentialDto[] = [];
  for (const [host, capability] of [["github.com", "github-cli"], ["gitlab.com", "gitlab-cli"]]) tokens.push((await post<{ credential: PublicCredentialDto }>("/api/hub/credentials/token", { name: capability, host, capabilities: ["https-git", capability], token: "test-only-token" })).credential);
  await page.goto(`${hub.origin}/settings`);
  await expect(page.locator(".credential-card")).toHaveCount(4);
  for (const credential of [ssh, pgp, ...tokens]) {
    const card = page.locator(`[data-credential-id="${credential.id}"]`);
    await card.locator("summary").click();
    await expect(card).toContainText(credential.type === "token" ? credential.metadata.host : credential.metadata.fingerprint);
    for (const action of ["Test", "Disable", "Delete"]) await expect(card.getByRole("button", { name: action, exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Copy public key" })).toHaveCount(credential.type === "token" ? 0 : 1);
    if (credential.type !== "token") {
      await card.getByLabel("Unlock passphrase").fill("test-passphrase");
      await card.getByRole("button", { name: "Unlock", exact: true }).click();
      await expect(card).toContainText("Unlocked");
    }
    await card.getByRole("button", { name: "Test", exact: true }).click();
    await expect(card).toContainText("ready");
    await card.locator("summary").click();
  }
  await page.locator("#tools-details summary").click();
  await expect(page.locator("#credential-tools")).toContainText("ssh");
  await expect(page.locator("#credential-tools").getByRole("button", { name: "Save override", exact: true }).first()).toBeVisible();
  await page.getByText("Import SSH private key", { exact: true }).click();
  const importForm = page.locator("#ssh-import-form");
  await importForm.getByLabel("Name", { exact: true }).fill("Retained non-secret name");
  await importForm.getByRole("button", { name: "Import SSH key" }).click();
  await expect(importForm.locator("[data-form-error]")).toContainText("exactly one private key source");
  await expect(importForm.getByLabel("Name", { exact: true })).toHaveValue("Retained non-secret name");
  await importForm.locator('input[type="file"]').setInputFiles({ name: "oversize.key", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024 + 1) });
  await importForm.getByRole("button", { name: "Import SSH key" }).click();
  await expect(importForm.locator("[data-form-error]")).toContainText("1 MiB");
  expect(await importForm.locator('input[type="file"]').inputValue()).toBe("");
  const otherContext = await context.browser()!.newContext();
  const other = await otherContext.newPage();
  await loginHub(other, hub);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  const device = page.locator("#devices .row").filter({ hasNotText: "this device" });
  await expect(device).toHaveCount(1);
  await expect(device).toContainText("signed in");
  await device.locator("summary").click();
  await device.getByRole("button", { name: "Revoke", exact: true }).click();
  expect((await other.request.get(`${hub.origin}/api/hub/state`)).status()).toBe(401);
  expect((await page.request.get(`${hub.origin}/api/hub/state`)).status()).toBe(200);
  await otherContext.close();
});

test("folder creation, dirty-sheet cancellation, Git consent, rename and forget retain files", async ({ page, hub }) => {
  test.setTimeout(120_000);
  await loginHub(page, hub);
  await hubPost(page.request, hub, "/api/hub/settings/workspace-defaults", { defaultWorkspaceParent: hub.root });
  await page.goto(`${hub.origin}/clone`);
  await page.getByRole("textbox", { name: "New folder name" }).fill("empty-folder");
  await page.getByRole("button", { name: "Create folder", exact: true }).click();
  const folder = page.locator("#browser .row").filter({ has: page.getByRole("link", { name: "empty-folder", exact: true }) });
  await expect(folder).toBeVisible();
  await folder.getByRole("button", { name: "Add workspace for empty-folder", exact: true }).click();
  await page.locator("#add-workspace-name").fill("Display only");
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#add-workspace-cancel").click();
  await expect(page.locator("#add-workspace-dialog")).toBeVisible();
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#add-workspace-submit").click();
  await expect(page.locator("#add-workspace-name")).toHaveValue("Display only");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#add-workspace-submit").click();
  await expect(page.locator("#add-workspace-dialog")).not.toBeVisible();
  expect((await stat(`${hub.root}/empty-folder/.git`)).isDirectory()).toBe(true);
  await folder.getByRole("button", { name: "Start Display only", exact: true }).waitFor();
  await folder.getByText("More actions", { exact: true }).click();
  await folder.getByRole("button", { name: "Rename folder empty-folder", exact: true }).click();
  await page.locator("#rename-folder-name").fill("renamed-folder");
  await page.locator("#rename-folder-submit").click();
  await expect(page.locator("#browser")).toContainText("renamed-folder");
  // Successful mutations do not leave a dirty-navigation warning.
  page.on("dialog", dialog => dialog.accept());
  await page.goto(hub.origin);
  const workspace = page.locator("#workspaces .row").filter({ hasText: "Display only" });
  await expect(workspace).toContainText("renamed-folder");
  await workspace.getByText("More actions", { exact: true }).click();
  await workspace.getByRole("button", { name: "Remove Display only from Hub", exact: true }).click();
  await expect(workspace).toHaveCount(0);
  expect((await stat(`${hub.root}/renamed-folder/.git`)).isDirectory()).toBe(true);
});

test("stop failure preserves registration; failed forget truthfully leaves a stopped workspace for retry", async ({ page, hub }) => {
  test.setTimeout(90_000);
  await loginHub(page, hub);
  const a = (await hubPost<{ workspace: { id: string } }>(page.request, hub, "/api/hub/workspaces/configure", { path: hub.workspaces.a, displayName: "A", start: true })).workspace.id;
  await page.reload();
  const order: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && /\/(stop|forget)$/.test(request.url())) order.push(new URL(request.url()).pathname.split("/").pop()!); });
  const stopUrl = `**/api/hub/sessions/${a}/stop`;
  await page.route(stopUrl, route => route.fulfill({ status: 500, json: { error: "Controlled stop failure" } }));
  const running = page.locator("#sessions .row");
  await running.locator("summary").click();
  page.once("dialog", dialog => dialog.accept());
  await running.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(running.locator("[role=alert]")).toHaveText("Controlled stop failure");
  expect((await (await page.request.get(`${hub.origin}/api/hub/state`)).json()).workspaces[0].running).toBe(true);
  expect(order).toEqual(["stop"]);
  await page.unroute(stopUrl);
  page.once("dialog", dialog => dialog.accept());
  await running.getByRole("button", { name: "Stop", exact: true }).click();
  const stopped = page.locator("#workspaces .row");
  await expect(stopped).toContainText(hub.workspaces.a);
  const forgetUrl = `**/api/hub/workspaces/${a}/forget`;
  await page.route(forgetUrl, route => route.fulfill({ status: 500, json: { error: "Controlled forget failure" } }));
  await stopped.locator("summary").click();
  await stopped.getByRole("button", { name: "Remove A from Hub" }).click();
  await expect(stopped.locator("[role=alert]")).toHaveText("Controlled forget failure");
  expect((await (await page.request.get(`${hub.origin}/api/hub/state`)).json()).workspaces[0].running).toBe(false);
  await page.unroute(forgetUrl);
  await stopped.getByRole("button", { name: "Remove A from Hub" }).click();
  await expect(stopped).toHaveCount(0);
  expect(order).toEqual(["stop", "stop", "forget", "forget"]);
  expect((await stat(hub.workspaces.a)).isDirectory()).toBe(true);
});
