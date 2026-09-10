import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { ReviewControl, ReviewControlArguments } from "./controller";
import { activeTask, namedButton, credentialCreation, moreAction, toolDetail, toolOverride } from './navigation';

async function control<K extends ReviewControl>(request: APIRequestContext, name: K, args: ReviewControlArguments<K>) {
  expect((await request.post(`/review/control/${name}`, { data: args })).ok()).toBe(true);
}
const state = async (request: APIRequestContext) => (await request.get("/review/state")).json();
const button = namedButton;
test.beforeEach(async ({ request }) => { expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true); });

test("SSH import masks and clears secrets before held failure, then generates a public-only key", async ({ page, request }) => {
  await page.goto("/settings?detail=add-credential");
  await credentialCreation(page, 'ssh', true);
  await page.getByLabel("Name", { exact: true }).fill("Disposable import");
  await page.getByText("Paste a private key instead", { exact: true }).click();
  const paste = page.getByLabel("Private key, masked");
  await paste.fill("DISPOSABLE-SYNTHETIC-NOT-A-KEY");
  await expect(paste).toHaveCSS("-webkit-text-security", "disc");
  await page.getByLabel("Existing passphrase, if any").fill("disposable-secret");
  await expect(page.getByLabel("Existing passphrase, if any")).toHaveAttribute("type", "password");
  await control(request, "hold", ["importSsh"]);
  await button(page, "Import").click();
  await expect(paste).toHaveValue("");
  await expect(page.getByLabel("Existing passphrase, if any")).toHaveValue("");
  await expect.poll(async () => (await state(request)).pending).toContainEqual({ method: "importSsh", count: 1 });
  await control(request, "settle", ["importSsh", true]);
  await expect(activeTask(page)).toContainText("Synthetic operation failed (review controller).");
  expect(JSON.stringify(await state(request))).not.toContain("disposable-secret");
  expect(JSON.stringify(await state(request))).not.toContain("DISPOSABLE-SYNTHETIC-NOT-A-KEY");
  await button(page, "Cancel").click();
  await button(page, "Generate SSH key").click();
  await page.getByLabel("Name", { exact: true }).fill("Generated review key");
  await page.getByLabel("Passphrase", { exact: true }).fill("disposable-example");
  await button(page, "Generate").click();
  await expect(page.getByRole("heading", { name: "Generated review key", exact: true })).toBeVisible();
  await moreAction(page, 'Public key');
  await expect(activeTask(page)).toContainText("SYNTHETIC-PUBLIC-ONLY");
  expect((await state(request)).model.credentials.filter((c: { name: string }) => c.name === "Generated review key")).toHaveLength(1);
});

test("tool override does not invent readiness and clear uses discovery", async ({ page, request }) => {
  await control(request, "setToolState", ["git", "missing"]);
  await page.goto("/settings?detail=tools");
  await toolDetail(page); await toolOverride(page);
  await expect(page.getByLabel("Absolute executable path")).toHaveValue("");
  await page.getByLabel("Absolute executable path").fill("/synthetic/bin/custom-git");
  await button(page, "Save").click();
  await expect(page.locator('.mh-flow-page')).toContainText("/synthetic/bin/custom-git");
  await page.locator('[data-flow="test-git"]').click();
  await expect(activeTask(page, 'editor', 'Check Results')).toContainText("Synthetic binary not found");
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  expect((await state(request)).model.tools.find((t: { tool: string }) => t.tool === "git").path).toBe("/synthetic/bin/custom-git");
  await control(request, "setToolState", ["git", "ready"]);
  await page.locator('[data-flow="test-git"]').click();
  await expect(page.locator('.mh-readiness-summary')).toContainText("Ready on this Hub");
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await toolOverride(page);
  await button(page, "Use automatic discovery").click();
  await expect(page.getByLabel("Absolute executable path")).toHaveValue("");
  expect((await state(request)).model.tools.find((t: { tool: string }) => t.tool === "git").path).toBe("/synthetic/bin/custom-git");
  await button(page, "Save").click();
  await expect.poll(async () => (await state(request)).model.tools.find((t: { tool: string }) => t.tool === "git").path).toBe("/synthetic/bin/git");
});

test("OpenPGP file import clears upload and has no individual lock; token creation masks, disables and deletes", async ({ page, request }) => {
  await page.goto("/settings?detail=add-credential");
  await credentialCreation(page, 'openpgp', true);
  await page.getByLabel("Name", { exact: true }).fill("Imported signing review");
  const file = page.getByLabel("Private key file (preferred)");
  await file.setInputFiles({ name: "disposable.asc", mimeType: "text/plain", buffer: Buffer.from("DISPOSABLE-OPAQUE-SYNTHETIC-KEY") });
  await control(request, "hold", ["importOpenPgp"]);
  await button(page, "Import").click();
  await expect(file).toHaveValue("");
  await control(request, "settle", ["importOpenPgp", false]);
  await expect(page.getByRole("heading", { name: "Imported signing review", exact: true })).toBeVisible();
  await expect(button(page, "Lock SSH key")).toHaveCount(0);
  await expect(button(page, "Public key")).toBeVisible();
  expect(JSON.stringify(await state(request))).not.toContain("DISPOSABLE-OPAQUE-SYNTHETIC-KEY");
  await page.goto("/settings?detail=add-credential");
  await credentialCreation(page, 'token');
  await page.getByLabel("Name", { exact: true }).fill("Review token");
  await page.getByLabel("Provider host").fill("github.com");
  const token = page.getByLabel("Token", { exact: true });
  await expect(token).toHaveAttribute("type", "password");
  await token.fill("DISPOSABLE-TOKEN-SECRET");
  await control(request, "hold", ["createToken"]);
  await button(page, "Add").click();
  await expect(token).toHaveValue("");
  await control(request, "settle", ["createToken", false]);
  await expect(page.getByRole("heading", { name: "Review token", exact: true })).toBeVisible();
  await expect(button(page, "Unlock")).toHaveCount(0);
  await expect(button(page, "Public key")).toHaveCount(0);
  await button(page, "Disable").click();
  await activeTask(page, 'confirmation').getByRole("button", { name: "Disable", exact: true }).click();
  await expect(button(page, "Enable")).toBeVisible();
  await button(page, "Enable").click();
  await expect(button(page, "Disable")).toBeVisible();
  await button(page, "Delete credential").click();
  await button(page, "Delete").click();
  await expect.poll(async () => (await state(request)).model.credentials.some((c: { name: string }) => c.name === "Review token")).toBe(false);
  expect(JSON.stringify(await state(request))).not.toContain("DISPOSABLE-TOKEN-SECRET");
});

for (const outcome of ["succeeded", "register-failed", "start-failed", "cleanup-failed", "timed-out"] as const) {
  test(`clone terminal ${outcome} is rendered with truthful retained state`, async ({ page, request }) => {
    await page.goto("/clone");
    await page.getByLabel("Remote URL").fill("https://github.com/review/example.git");
    await page.getByLabel("Checkout folder name").fill("terminal-review");
    await page.getByLabel("Workspace display name").fill("Terminal review");
    if (outcome === "start-failed") { await page.locator('.mh-flow-page details > summary').click(); await page.getByLabel("Start after configuration").check(); }
    await button(page, "Review clone").click(); await button(page, "Clone").click();
    await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
    const send = await button(page, 'Send response').elementHandle();
    const response = await page.getByLabel('Response to any remote prompt (always masked)').elementHandle();
    await page.getByLabel('Response to any remote prompt (always masked)').fill('DISPOSABLE-TERMINAL-RESPONSE');
    const id = (await state(request)).model.jobs[0].id;
    await control(request, "finishClone", [id, outcome]);
    const text = { succeeded: "registered stopped", "register-failed": "could not be registered", "start-failed": "remains stopped", "cleanup-failed": "Cleanup failed", "timed-out": "timed out" }[outcome];
    await expect(page.locator("[data-clone-status]")).toContainText(text);
    // Terminal outcomes now remove the prompt instead of showing disabled Send.
    // Preserve the no-input contract against the *original* mounted handler,
    // not merely absence of a visible button in the new result layout.
    await expect(button(page, 'Send response')).toHaveCount(0);
    expect(await response!.evaluate(el => { if (!(el instanceof HTMLInputElement)) throw new Error('Expected original prompt input'); return el.value; })).toBe('');
    await send!.evaluate(el => { if (!(el instanceof HTMLButtonElement)) throw new Error('Expected original Send button'); el.click(); });
    expect((await state(request)).log.filter((l: { method: string }) => l.method === 'sendCloneInput')).toHaveLength(0);
    expect(JSON.stringify(await state(request))).not.toContain('DISPOSABLE-TERMINAL-RESPONSE');
    const model = (await state(request)).model;
    expect(model.jobs[0].result.status).toBe(outcome);
    const workspace = model.workspaces.find((w: { path: string }) => w.path === "/synthetic/terminal-review");
    if (outcome === "succeeded" || outcome === "start-failed") expect(workspace).toMatchObject({ runtime: { status: "stopped" } });
    else expect(workspace).toBeUndefined();
    if (outcome === "register-failed" || outcome === "cleanup-failed") expect(model.folders.some((f: { path: string }) => f.path === "/synthetic/terminal-review")).toBe(true);
    expect((await state(request)).log.filter((l: { method: string }) => l.method === "submitClone")).toHaveLength(1);
  });
}

test("assignment review is inert until Apply and stop failure preserves removal target", async ({ page, request }) => {
  await page.goto("/settings?detail=assignments");
  await page.locator('[data-flow="workspace-atlas"]').click();
  await page.locator('[data-flow="new-atlas"]').click();
  await page.getByRole("combobox", { name: "Authentication", exact: true }).selectOption("token-github");
  await page.getByLabel("Authentication host").fill("github.com");
  await button(page, "Review").click();
  expect((await state(request)).model.workspaces.find((w: { id: string }) => w.id === "atlas").assignments).toEqual([]);
  await button(page, "Back to edit").click();
  await expect(page.getByRole("combobox", { name: "Authentication", exact: true })).toHaveValue("token-github");
  await button(page, "Review").click();
  await button(page, "Apply").click();
  await page.locator('[data-flow="assignment-0"]').click();
  await expect(page.locator('[data-flow="remove-atlas-0"]')).toBeVisible();
  await page.locator('[data-flow="remove-atlas-0"]').click();
  await button(page, "Remove").click();
  await expect(activeTask(page, 'confirmation')).toContainText("atlas");
  await button(page, "Cancel").click();
  expect((await state(request)).model.workspaces.find((w: { id: string }) => w.id === "atlas").runtime.status).toBe("running");
  await control(request, "setStopFailure", ["atlas", true]);
  await page.locator('[data-flow="assignment-0"]').click();
  await page.locator('[data-flow="remove-atlas-0"]').click();
  await button(page, "Remove").click();
  await activeTask(page, 'confirmation').getByRole("button", { name: /Stop/ }).click();
  await expect(activeTask(page, 'confirmation')).toContainText("failed");
  expect((await state(request)).model.workspaces.find((w: { id: string }) => w.id === "atlas").assignments).toHaveLength(1);
});

test("create empty folder is not registration; explicit Git consent registers it stopped", async ({ page, request }) => {
  await page.goto("/?detail=add-workspace");
  await button(page, "Existing folder").click();
  await moreAction(page, 'Create empty folder');
  await page.getByLabel("Folder name", { exact: true }).fill("review-empty");
  await button(page, "Create folder").click();
  await expect(page.locator(".mh-flow-page")).toContainText("/synthetic/review-empty");
  expect((await state(request)).model.workspaces).toHaveLength(2);
  await button(page, "Configure this folder").click();
  await page.getByLabel("Workspace display name").fill("Review folder workspace");
  await button(page, "Review").click();
  await expect(activeTask(page)).toContainText("Confirm Git initialization");
  await page.getByLabel("Initialize Git in this folder").check();
  await button(page, "Review").click();
  await button(page, "Add stopped").click();
  await expect(page.getByRole("heading", { name: "Workspace configured", exact: true })).toBeVisible();
  expect((await state(request)).model.workspaces.find((w: { path: string }) => w.path === "/synthetic/review-empty")).toMatchObject({ displayName: "Review folder workspace", runtime: { status: "stopped" } });
});

test("onboarding registration failure reports retained checkout without fabricated workspace", async ({ page, request }) => {
  await control(request, "setOnboardingFault", ["register-failed"]);
  await page.goto("/?detail=add-workspace");
  await button(page, "Create workspace").click();
  await page.getByLabel("New folder name").fill("retained-review");
  await page.getByLabel("Workspace display name").fill("Retained review");
  await page.getByLabel("Create the folder and initialize Git").check();
  await button(page, "Review").click();
  await button(page, "Add stopped").click();
  await expect(page.getByRole("heading", { name: "Configuration needs attention" })).toBeVisible();
  await expect(page.locator(".mh-flow-page")).toContainText("Folder retained: /synthetic/retained-review");
  const model = (await state(request)).model;
  expect(model.workspaces).toHaveLength(2);
  expect(model.folders.find((f: { path: string }) => f.path === "/synthetic/retained-review")).toMatchObject({ git: true });
  await button(page, "Inspect retained folder").click();
  await expect(button(page, "Configure this folder")).toBeVisible();
});

test("clone independent unlock submits once; masked input replays on same job and cancellation cleans", async ({ page, request }) => {
  await page.goto("/clone");
  await page.getByLabel("Remote URL").fill("git@github.com:review/example.git");
  await page.getByLabel("Checkout folder name").fill("review-clone");
  await page.getByLabel("Workspace display name").fill("Review clone");
  await page.getByLabel("One-time clone credential").selectOption("ssh-locked");
  await button(page, "Unlock selected clone identity").click();
  await page.getByLabel("Passphrase", { exact: true }).fill("disposable-unlock");
  await button(page, "Unlock").click();
  await expect(button(page, "Review clone")).toBeVisible();
  expect((await state(request)).model.jobs).toEqual([]);
  await button(page, "Review clone").click();
  await button(page, "Clone").click();
  await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
  const id = (await state(request)).model.jobs[0].id;
  await control(request, "cloneOutput", [id, "prompt"]);
  const input = page.getByLabel("Response to any remote prompt (always masked)");
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("DISPOSABLE-PROMPT-SECRET");
  await button(page, "Send response").click();
  await expect(input).toHaveValue("");
  await expect(page.getByLabel("Clone output")).toContainText("[masked input accepted]");
  await control(request, "disconnectClone", [id]);
  await expect(page.locator("[data-clone-problem]")).toContainText("interrupted");
  await control(request, "cloneOutput", [id, "progress"]);
  await moreAction(page, 'Reconnect to this job');
  await expect(page.locator("[data-clone-problem]")).toHaveText("");
  await expect(page.getByLabel("Clone output")).toContainText("Synthetic checkout progress; no remote contacted.");
  expect((await page.getByLabel("Clone output").textContent())!.split("[masked input accepted]")).toHaveLength(2);
  expect((await state(request)).log.filter((l: { method: string }) => l.method === "submitClone")).toHaveLength(1);
  expect(JSON.stringify(await state(request))).not.toContain("DISPOSABLE-PROMPT-SECRET");
  await moreAction(page, 'Cancel clone');
  await activeTask(page, 'confirmation').getByRole("button", { name: "Cancel clone", exact: true }).click();
  await expect(page.locator("[data-clone-status]")).toContainText("Clone cancelled");
  expect((await state(request)).model.folders.some((f: { path: string }) => f.path === "/synthetic/review-clone")).toBe(false);
});

test("login rejects bad credentials, clears password, then authoritative unauthorized returns to login", async ({ page, request }) => {
  await request.post("/review/reset", { data: { scenario: "signed-out" } });
  expect((await request.get("/api/hub/state")).status()).toBe(401);
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("reviewer");
  await page.getByLabel("Password", { exact: true }).fill("wrong-disposable");
  await button(page, "Sign in").click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await page.getByLabel("Password", { exact: true }).fill("review-only");
  await button(page, "Sign in").click();
  await expect(page.locator('[data-workspace="atlas"]')).toBeVisible();
  await control(request, "invalidateAuthentication", []);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.locator('[data-workspace="atlas"]')).toHaveCount(0);
  expect((await request.get("/api/hub/state")).status()).toBe(401);
});
