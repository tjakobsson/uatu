import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { ReviewControl, ReviewControlArguments } from "./controller";
import { activeTask, diagnosticReport, toolDetail, toolOverride } from './navigation';

const state = async (request: APIRequestContext) => (await request.get("/review/state")).json();
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function control<K extends ReviewControl>(request: APIRequestContext, name: K, args: ReviewControlArguments<K>) {
  expect((await request.post(`/review/control/${name}`, { data: args })).ok()).toBe(true);
}
async function cloneForm(page: Page, folder = "contract-checkout") {
  await page.goto("/clone");
  await page.getByLabel("Remote URL").fill("https://github.com/review/example.git");
  await page.getByLabel("Checkout folder name").fill(folder);
  await page.getByLabel("Workspace display name").fill("Contract review");
}
async function submit(page: Page) { await button(page, "Review clone").click(); await button(page, "Clone").click(); }
async function hints(page: Page) { return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("uatu.hub.clone-attempt-v2:")).map(([key, raw]) => ({ key, ...JSON.parse(raw) }))); }
test.beforeEach(async ({ request }) => { expect((await request.post("/review/reset", { data: { scenario: "mixed" } })).ok()).toBe(true); });

test("Settings overview uses concise explicit lock facts, independent Disabled, and a truthful detail fallback", async ({ page, request }) => {
  await page.goto("/settings");
  const row = page.locator('[data-credential-id="ssh-locked"]');
  await expect(row.locator(".mh-value")).toHaveText("Locked");
  await expect(page.locator('[data-credential-id="ssh-open"] .mh-value')).toHaveText("Unlocked");
  await control(request, "setKeyState", ["ssh-locked", "unlocked"]); await expect(row.locator(".mh-value")).toHaveText("Unlocked");
  await control(request, "setCredentialFactsUnknown", ["ssh-locked", true]); await expect(row.locator(".mh-value")).toHaveText("Unknown");
  await request.post("/review/backend/disableCredential", { data: [{ target: { id: "ssh-locked", type: "ssh" }, stop: "ask" }] });
  await expect(row.locator(".mh-row-copy small")).toHaveText("SSH key · Disabled"); await expect(row.locator(".mh-value")).toHaveText("Unknown");
  await control(request, "setCredentialFactsUnknown", ["ssh-locked", false]); await expect(row.locator(".mh-value")).toHaveText("Locked");
  await control(request, "fail", ["readCredentialFacts", { kind: "unavailable", message: "ignored" }]); await page.reload();
  await expect(row.locator(".mh-value")).toHaveText("Unknown"); await row.click();
  await expect(page.getByRole("heading", { name: "Review SSH (locked)", exact: true })).toBeVisible();
  await expect(page.locator('[data-credential-fact="lock"] .mh-value')).toHaveText('Unknown');
  await expect(page.locator('[data-readiness-layer]')).toHaveCount(0);
  await diagnosticReport(page);
  await expect(activeTask(page).locator('[data-readiness-layer]')).toHaveCount(17);
  await activeTask(page).getByRole('button', { name: 'Back', exact: true }).click();
  await control(request, "fail", ["readCredentialFacts", null]); await button(page, "Retry status check").click();
  await expect(page.locator('[data-credential-fact="lock"] .mh-value')).toHaveText("locked");
  await expect(page.locator('[data-credential-fact="protection"] .mh-value')).toHaveText("protected");
  await expect(page.locator(".mh-flow-header")).toContainText("Disabled");
});

test("late overview facts preserve focused row identity, Settings scroll, and an open preference draft", async ({ page, request }) => {
  await control(request, "hold", ["readCredentialFacts"]);
  try {
    await page.goto("/settings"); const row = page.locator('[data-credential-id="ssh-locked"]'); await expect(row.locator(".mh-value")).toHaveText("Loading…");
    const handle = await row.elementHandle(); const scroll = page.locator(".mh-page");
    await scroll.evaluate(el => { el.scrollTop = 100; }); await row.focus(); const before = await scroll.evaluate(el => el.scrollTop);
    await control(request, "settle", ["readCredentialFacts", false]); await expect(row.locator(".mh-value")).toHaveText("Locked");
    expect(await handle!.evaluate(el => el === document.querySelector('[data-credential-id="ssh-locked"]'))).toBe(true);
    await expect(row).toBeFocused(); expect(await scroll.evaluate(el => el.scrollTop)).toBe(before);
    await page.locator('[data-action="preview-side"]').click(); const side = page.getByRole("radio", { name: "Right", exact: true });
    await side.check(); await side.focus(); const field = await side.elementHandle(); const formScroll = await scroll.evaluate(el => el.scrollTop);
    await control(request, "hold", ["readCredentialFacts"]); await control(request, "setKeyState", ["ssh-locked", "unlocked"]);
    await expect.poll(async () => (await state(request)).pending.some((p: { method: string; count: number }) => p.method === "readCredentialFacts" && p.count >= 5)).toBe(true);
    await control(request, "settle", ["readCredentialFacts", false]);
    await expect(row.locator(".mh-value")).toHaveText("Unlocked"); expect(await field!.evaluate(el => el.isConnected)).toBe(true);
    await expect(side).toBeChecked(); await expect(side).toBeFocused(); expect(await scroll.evaluate(el => el.scrollTop)).toBe(formScroll);
    await button(page, "Cancel").click(); await expect(page.locator('[data-action="preview-side"]')).toBeFocused();
    await expect(page.locator('[data-action="preview-side"] .mh-value')).toHaveText("Left");
  } finally { await control(request, "settle", ["readCredentialFacts", false]); }
});

test("explicit lock/protection/user-ID facts and current tool override are never guessed", async ({ page, request }) => {
  await request.post("/review/backend/lockSsh", { data: [{ id: "ssh-open", type: "ssh" }] });
  await page.goto("/settings?detail=credential&id=ssh-open");
  await expect(page.locator('[data-credential-fact="lock"] .mh-value')).toHaveText("locked");
  await expect(page.locator('[data-credential-fact="protection"] .mh-value')).toHaveText("unprotected");
  await control(request, "setOpenPgpUserId", ["pgp-locked", "Explicit signer <facts@mock.invalid>"]);
  await page.goto("/settings?detail=credential&id=pgp-locked");
  await expect(page.locator('[data-credential-fact="userId"] .mh-value')).toHaveText("Explicit signer <facts@mock.invalid>");
  await control(request, "setCredentialFactsUnknown", ["pgp-locked", true]); await page.reload();
  for (const name of ["lock", "protection", "userId"]) await expect(page.locator(`[data-credential-fact="${name}"] .mh-value`)).toHaveText("Unknown");
  await request.post("/review/backend/setToolOverride", { data: [{ tool: "git", path: "/synthetic/saved/git" }] });
  await page.goto("/settings?detail=tools"); await toolDetail(page); await toolOverride(page);
  await expect(page.getByLabel("Absolute executable path")).toHaveValue("/synthetic/saved/git");
  await button(page, "Cancel").click(); await control(request, "setToolConfigurationUnknown", ["git", true]); await toolOverride(page);
  await expect(page.getByLabel("Absolute executable path")).toHaveValue(""); await expect(activeTask(page)).toContainText("Saved override: Unknown");
});

test("tool Save pending/failure belongs to its sheet, including Escape and repeated activation", async ({ page, request }) => {
  await page.goto("/settings?detail=tools"); await toolDetail(page); await toolOverride(page);
  await page.getByLabel("Absolute executable path").fill("/synthetic/custom/git"); await control(request, "hold", ["setToolOverride"]);
  try {
    await button(page, "Save").click(); await expect(button(page, "Save")).toBeDisabled(); await expect(page.getByLabel("Absolute executable path")).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(activeTask(page)).toBeVisible();
    const owner = await activeTask(page).elementHandle();
    await page.goBack();
    await expect(activeTask(page).getByRole('status').and(page.locator('[data-task-pending]'))).toContainText('Wait for its result');
    expect(await owner!.evaluate(el => el.isConnected)).toBe(true);
    await expect(activeTask(page)).toHaveAttribute('aria-busy', 'true');
    await expect.poll(async () => (await state(request)).pending).toContainEqual({ method: "setToolOverride", count: 1 });
    await control(request, "settle", ["setToolOverride", true]);
    await expect(activeTask(page).getByRole("alert")).toContainText("Synthetic operation failed");
    await expect(page.getByLabel("Absolute executable path")).toHaveValue("/synthetic/custom/git"); await expect(button(page, "Save")).toBeEnabled();
  } finally { await control(request, "settle", ["setToolOverride", false]); }
});

test("CLI-only provider token is selectable for retained authentication, never for cloning", async ({ page, request }) => {
  const created = await (await request.post("/review/backend/createToken", { data: [{ name: "CLI only", host: "github.com", token: "DISPOSABLE-NOT-REAL", capabilities: ["github-cli"] }] })).json();
  expect(created.status).toBe("completed"); const id = created.value.id;
  await page.goto("/settings?detail=assignments"); await page.locator('[data-flow="workspace-notes"]').click(); await page.locator('[data-flow="new-notes"]').click();
  await page.getByRole("combobox", { name: "Git authentication credential", exact: true }).selectOption(id);
  await page.getByLabel("Authentication host").fill("github.com"); await button(page, "Review").click(); await button(page, "Apply").click();
  await expect.poll(async () => (await state(request)).model.workspaces.find((w: { id: string }) => w.id === "notes").assignments).toContainEqual({ workspaceId: "notes", credentialId: id, role: "authentication", host: "github.com" });
  await page.goto("/clone");
  await expect(page.locator(`[name="authentication"] option[value="${id}"]`)).toHaveCount(1);
  await expect(page.locator(`[name="cloneCredential"] option[value="${id}"]`)).toHaveCount(0);
});

test("actual server acceptance followed by network response loss recovers one job across reload", async ({ page, request }) => {
  const ids: string[] = [];
  await page.route("**/review/backend/submitClone", async route => {
    const intent = route.request().postDataJSON()[0]; ids.push(intent.attemptId);
    expect((await hints(page))[0]?.attemptId).toBe(intent.attemptId); // saved before dispatch
    await route.fetch(); await route.abort("failed"); // effect committed; no accepted response reaches UI
  });
  await cloneForm(page); await submit(page); await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
  expect(ids).toHaveLength(1); expect((await state(request)).model.jobs).toHaveLength(1);
  const accepted = (await hints(page))[0]; expect(accepted.attemptId).toBe(ids[0]); expect(accepted.jobId).toBe((await state(request)).model.jobs[0].id);
  expect(JSON.stringify(accepted)).not.toContain("github.com"); expect(JSON.stringify(accepted)).not.toContain("Contract review");
  await page.reload(); await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
  expect(ids).toHaveLength(1); expect((await state(request)).model.jobs).toHaveLength(1);
});

test("a reloaded pending admission stays fenced from new submissions until accepted", async ({ page, request }) => {
  await control(request, "hold", ["submitClone"]);
  try {
    await cloneForm(page); await submit(page); await expect.poll(async () => (await state(request)).pending).toContainEqual({ method: "submitClone", count: 1 });
    const id = (await hints(page))[0].attemptId; await page.reload();
    await expect(page.getByRole("heading", { name: "Clone Recovery" })).toBeVisible(); await expect(page.locator(".mh-flow-page")).toContainText("still pending");
    await expect(button(page, "Review clone")).toHaveCount(0); expect((await hints(page))[0].attemptId).toBe(id);
    await control(request, "settle", ["submitClone", false]); await button(page, "Reconcile original attempt").click();
    await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
    expect((await state(request)).log.filter((row: { method: string }) => row.method === "submitClone")).toHaveLength(1);
  } finally { await control(request, "settle", ["submitClone", false]); }
});

test("unavailable reconciliation remains unknown across reload until an authoritative lookup succeeds", async ({ page, request }) => {
  await control(request, "fail", ["submitClone", "indeterminate-after"]);
  await page.route("**/review/backend/reconcileCloneAttempt", route => route.abort("failed"));
  await cloneForm(page); await submit(page);
  await expect(page.locator(".mh-flow-page")).toContainText("reconciliation is unavailable");
  const id = (await hints(page))[0].attemptId; await expect(button(page, "Review clone")).toHaveCount(0);
  await page.reload(); await expect(page.locator(".mh-flow-page")).toContainText("reconciliation is unavailable");
  expect((await hints(page))[0].attemptId).toBe(id); expect((await state(request)).model.jobs).toHaveLength(1);
  await page.unroute("**/review/backend/reconcileCloneAttempt"); await button(page, "Reconcile original attempt").click();
  await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible();
  expect((await state(request)).log.filter((row: { method: string }) => row.method === "submitClone")).toHaveLength(1);
});

test("not-accepted authorizes a new reviewed id, whereas expired never offers blind retry", async ({ page, request }) => {
  await control(request, "fail", ["submitClone", "indeterminate-before"]); await cloneForm(page); await submit(page);
  await expect(page.locator(".mh-flow-page")).toContainText("not accepted and has been fenced");
  const first = (await state(request)).model.attempts[0].attemptId;
  await control(request, "fail", ["submitClone", null]); await control(request, "hold", ["submitClone"]);
  try {
    await submit(page); const second = (await hints(page))[0].attemptId; expect(second).not.toBe(first);
    await control(request, "expireCloneAttempt", [second]); await page.reload();
    await expect(page.locator(".mh-flow-page")).toContainText("no longer authoritative enough");
    await expect(button(page, "Review clone")).toHaveCount(0); await expect(button(page, "Forget unavailable job hint")).toHaveCount(0);
    await page.locator('[data-flow="flow-back"]').click(); await page.goBack();
    await expect(page.locator(".mh-flow-page")).toContainText("no longer authoritative enough"); expect((await hints(page))[0].attemptId).toBe(second);
  } finally { await control(request, "settle", ["submitClone", false]); }
});

test("requires-unlock resumes the authorized intent with a fresh attempt, not the concluded id", async ({ page, request }) => {
  const ids: string[] = []; page.on("request", req => { if (req.url().endsWith("/review/backend/submitClone")) ids.push(req.postDataJSON()[0].attemptId); });
  await cloneForm(page); await page.getByLabel("Remote URL").fill("ssh://git@github.com/review/example.git");
  await page.getByLabel("One-time clone credential").selectOption("ssh-locked"); await submit(page);
  await expect(activeTask(page)).toContainText("Unlock Clone Identity"); await page.getByLabel("Passphrase", { exact: true }).fill("DISPOSABLE"); await button(page, "Unlock and continue").click();
  await expect(page.getByRole("heading", { name: "Clone Progress" })).toBeVisible(); expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]);
  expect((await state(request)).model.attempts).toContainEqual({ attemptId: ids[0], status: "not-accepted" }); expect((await state(request)).model.jobs).toHaveLength(1);
});

test("input response loss blocks further input through replay/reload; non-cloning phases cannot submit", async ({ page, request }) => {
  let inputs = 0;
  await page.route("**/review/backend/sendCloneInput", async route => { inputs++; await route.fetch(); await route.abort("failed"); });
  await cloneForm(page); await submit(page); await expect(button(page, "Send response")).toBeEnabled();
  const field = page.getByLabel("Response to any remote prompt (always masked)"); await expect(field).toHaveAttribute("type", "password");
  await field.fill("DISPOSABLE-RESPONSE"); await button(page, "Send response").click(); await expect(field).toHaveValue("");
  await expect(page.locator("[data-clone-problem]")).toContainText("Input acceptance is unknown"); await expect(button(page, "Send response")).toBeDisabled();
  await page.reload(); await expect(button(page, "Send response")).toBeDisabled(); expect(inputs).toBe(1);
  const id = (await state(request)).model.jobs[0].id; await control(request, "clonePhase", [id, "registering"]);
  await expect(page.locator("[data-clone-status]")).toContainText("registering"); await expect(field).toBeDisabled();
  expect(JSON.stringify(await hints(page))).not.toContain("DISPOSABLE-RESPONSE"); expect(inputs).toBe(1);
});

test("secret URL text is discarded before the retained clone draft survives a Settings detour", async ({ page }) => {
  await cloneForm(page);
  for (const url of ["https://user:DISPOSABLE@github.com/repo", "https://github.com/repo?token=DISPOSABLE", "https://github.com/repo#DISPOSABLE"]) {
    await page.getByLabel("Remote URL").fill(url); await expect(page.getByLabel("Remote URL")).toHaveValue("");
    await button(page, "Settings").click(); await page.goBack(); await expect(page.getByLabel("Remote URL")).toHaveValue("");
    expect(JSON.stringify(await hints(page))).not.toContain("DISPOSABLE");
  }
});

test("auth-context loss and a new frontend identity cannot inherit delayed acceptance", async ({ page, request }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let responseReady = false;
  await page.route("**/review/backend/submitClone", async route => { const response = await route.fetch(); responseReady = true; await gate; await route.fulfill({ response }); });
  try {
    await cloneForm(page); await submit(page); await expect.poll(() => responseReady).toBe(true);
    const original = (await hints(page))[0]; await control(request, "invalidateAuthentication", []);
    await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();
    // The model uses one login name; an explicitly test-owned read projection
    // supplies a different public identity for the fresh authentication context.
    await page.route("**/review/backend/readAuthentication", async route => {
      const response = await route.fetch(), body = await response.json();
      if (body.status === "available" && body.value.status === "authenticated") body.value.identity.user = "another-reviewer";
      await route.fulfill({ response, json: body });
    });
    await page.getByLabel("Username", { exact: true }).fill("reviewer"); await page.getByLabel("Password", { exact: true }).fill("review-only"); await button(page, "Sign in").click();
    await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible(); release();
    await expect.poll(async () => (await hints(page))[0]).toEqual(original);
    await page.goto("/clone"); await expect(page.getByLabel("Remote URL")).toHaveValue("");
    expect(await hints(page)).toHaveLength(1); expect((await hints(page))[0].jobId).toBeUndefined();
  } finally { release(); }
});
