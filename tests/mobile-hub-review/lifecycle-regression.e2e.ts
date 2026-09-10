import { expect, test } from "@playwright/test";
import { activeTask, credentialCreation, moreAction } from './navigation';

test.beforeEach(async ({ request }) => { await request.post("/review/reset", { data: { scenario: "credentials" } }); });

for (const submitted of [false, true]) test(`history foreground clears retained secret nodes and ignores late events (submitted=${submitted})`, async ({ page, request }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await page.locator("#navigation-hub").click();
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="add-credential"]').click();
  await credentialCreation(page, 'ssh', true);
  await page.getByLabel("Name", { exact: true }).fill("Late import");
  await page.getByText("Paste a private key instead", { exact: true }).click();
  await page.getByLabel("Private key, masked").fill("DISPOSABLE-SECRET");
  await page.evaluate(() => { (window as any).oldSecret = document.querySelector('[name="privateText"]') ?? document.querySelector('textarea[data-secret]'); (window as any).oldCommit = document.querySelector('[data-action="commit-sheet"]'); });
  if (submitted) {
    await request.post("/review/control/hold", { data: ["importSsh"] });
    await page.getByRole("button", { name: "Import", exact: true }).click();
  }
  // Hub, Settings, credential chooser and its owned editor each add an entry.
  await page.evaluate(() => history.go(-4));
  await expect(page.locator("#mobile-hub-root")).toBeHidden();
  expect(await page.evaluate(() => (window as any).oldSecret.value)).toBe("");
  expect(await page.evaluate(() => (window as any).oldSecret.isConnected)).toBe(false);
  if (submitted) await request.post("/review/control/settle", { data: ["importSsh", false] });
  await page.evaluate(() => (window as any).oldCommit.click());
  await expect(page.locator("#mobile-workspace-root")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".mh-sheet")).toHaveCount(0);
  await expect(page.locator(".mh-flow-page")).toBeEmpty();
  const snapshot = await (await request.get("/review/state")).json();
  expect(snapshot.log.filter((entry: any) => entry.method === "importSsh")).toHaveLength(submitted ? 1 : 0);
});

test("stopping retained A preserves an unrelated active management draft for B", async ({ page, request }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await page.locator("#navigation-hub").click();
  await page.locator('[data-action="info:notes"]').click();
  await moreAction(page, 'Rename display name');
  await page.getByLabel("Display name", { exact: true }).fill("Unrelated draft");
  await request.post("/review/backend/stopWorkspace", { data: ["atlas"] });
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Unrelated draft");
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".mh-flow-page h1")).toHaveText("Unrelated draft");
});

test("first dependent stop survives second stop failure without discarding active provider result", async ({ page, request }) => {
  await request.post("/review/backend/assignWorkspace", { data: [{ workspaceId: "notes", mode: "edit-current", selection: { authentication: { credentialId: "token-github", host: "github.com" } } }] });
  await request.post("/review/backend/startWorkspace", { data: [{ workspaceId: "notes", unassigned: "not-confirmed" }] });
  // Notes also has a locked signing key in this scenario: unlock, then start.
  await request.post("/review/backend/unlockCredential", { data: [{ target: { id: "pgp-locked", type: "openpgp" }, passphrase: "synthetic" }] });
  await request.post("/review/backend/startWorkspace", { data: [{ workspaceId: "notes", unassigned: "not-confirmed" }] });
  await request.post("/review/control/setStopFailure", { data: ["notes", true] });
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await page.locator("#navigation-hub").click();
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="credential:token-github"]').click();
  await moreAction(page, 'Disable');
  await activeTask(page, 'confirmation').getByRole("button", { name: "Disable", exact: true }).click();
  await page.getByRole("button", { name: "Stop and continue", exact: true }).click();
  await expect(activeTask(page, 'confirmation')).toContainText("Some prior dependent sessions may have stopped");
  const model = (await (await request.get("/review/state")).json()).model;
  expect(model.workspaces.find((w: any) => w.id === "atlas").runtime.status).toBe("stopped");
  expect(model.workspaces.find((w: any) => w.id === "notes").runtime.status).toBe("running");
  expect(model.credentials.find((c: any) => c.id === "token-github").enabled).toBe(true);
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
});

test("successful stop and remove retains the active assignment result", async ({ page }) => {
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await page.locator("#navigation-hub").click();
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-action="assignments"]').click();
  await page.locator('[data-flow="workspace-atlas"]').click();
  await page.locator('[data-flow="assignment-0"]').click();
  await page.locator('[data-flow="remove-atlas-0"]').click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Stop and continue", exact: true }).click();
  await expect(activeTask(page, 'confirmation')).toHaveCount(0);
  await expect(page.locator(".mh-flow-page")).toContainText("No credentials assigned");
  await expect(page.locator(".mh-flow-page h1")).toHaveText("Atlas");
  await expect(page.locator("#mobile-workspace-root")).toHaveAttribute("inert", "");
});
