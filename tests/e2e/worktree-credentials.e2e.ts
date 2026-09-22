// A linked worktree's credential policy is its parent's, on a REAL Hub with
// real temporary Git repositories and the credential API mounted (token
// credentials; see hub-server.ts, UATU_E2E_HUB_CREDENTIALS).
//
// Three things are proved end to end: the dashboard row of a linked worktree
// summarises the parent's assignments and discloses the inheritance; the
// credential API refuses an assignment or removal that names a child, and
// names the parent that owns the policy instead; and a running child whose
// parent's assignments changed under it is flagged for restart on the
// credential card that names the parent.

import type { Page } from "@playwright/test";

import { test, expect } from "./hub-fixtures";
import { captureScreenshot, saveEvidence } from "./evidence";

test.use({
  hubWorktrees: true,
  hubCredentials: true,
  hubWorkspaces: ["vault-desktop", "vault-touch", "vault-refusal", "vault-restart"],
});

const HOST = "github.com";

type Json = Record<string, unknown>;

// A state-changing call from the signed-in context: the request carries the
// hub cookie; the hub's CSRF check accepts a request with no Origin.
async function post(page: Page, endpoint: string, body: Json = {}): Promise<{ status: number; body: Json }> {
  const response = await page.request.post(endpoint, { data: body });
  return { status: response.status(), body: (await response.json()) as Json };
}

async function createToken(page: Page, name: string): Promise<string> {
  const created = await post(page, "/api/hub/credentials/token", {
    name, host: HOST, token: `secret-${name}`, capabilities: ["https-git"],
  });
  expect(created.status).toBe(200);
  return (created.body.credential as { id: string }).id;
}

async function assignToParent(page: Page, credentialId: string, workspaceId: string, replace = false): Promise<void> {
  const assigned = await post(page, `/api/hub/credentials/${encodeURIComponent(credentialId)}/assign`, {
    workspaceId, role: "authentication", host: HOST, ...(replace ? { replace: true } : {}),
  });
  expect(assigned.status).toBe(200);
}

async function deleteCredential(page: Page, credentialId: string): Promise<void> {
  const deleted = await post(page, `/api/hub/credentials/${encodeURIComponent(credentialId)}/delete`, { confirm: true, unassign: true });
  expect(deleted.status).toBe(200);
}

type StateWorkspace = {
  id: string;
  displayName: string;
  running: boolean;
  parentId?: string;
  credentialRestartRequired: boolean;
  credentialAssignments: { authentication: string[]; signing: string[] };
};

async function hubState(page: Page): Promise<StateWorkspace[]> {
  const response = await page.request.get("/api/hub/state");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { workspaces: StateWorkspace[] }).workspaces;
}

async function inventoryOf(page: Page, sourceWorkspaceId: string) {
  const response = await page.request.get(`/api/hub/worktrees?source=${encodeURIComponent(sourceWorkspaceId)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).inventory as {
    checkouts: { checkoutId: string; workspaceId?: string; branch: string; running: boolean }[];
  };
}

// The registered child's workspace id for a branch the parent forked.
async function childIdFor(page: Page, parentId: string, branch: string): Promise<string> {
  const checkout = (await inventoryOf(page, parentId)).checkouts.find(item => item.branch === branch);
  expect(checkout?.workspaceId).toBeTruthy();
  return checkout!.workspaceId!;
}

// Forks a new-branch worktree through the API — the same published family the
// dashboard dialog uses — without starting it.
async function forkViaApi(page: Page, parentId: string, branch: string): Promise<string> {
  const created = await post(page, "/api/hub/worktrees/create", {
    sourceWorkspaceId: parentId, mode: "new-branch", branch, baseRef: "main", start: false,
  });
  expect(created.status).toBe(200);
  expect(created.body.ok).toBe(true);
  return childIdFor(page, parentId, branch);
}

// The Active-groups dashboard folds a repository's stopped children behind a
// `N stopped worktrees` disclosure; open the parent's so the child row is
// rendered. The dashboard re-renders on its own poll, so the open state is
// re-checked rather than assumed from one click.
async function revealStoppedChildren(page: Page, parentId: string): Promise<void> {
  const disclosure = page.locator(`[data-disclosure="${parentId}-stopped"]`);
  await expect(disclosure).toHaveCount(1);
  await expect(async () => {
    if (await disclosure.getAttribute("open") === null) {
      await disclosure.locator("summary").click({ timeout: 2_000 });
    }
    expect(await disclosure.getAttribute("open")).not.toBeNull();
  }).toPass({ timeout: 10_000 });
}

const rowFor = (page: Page, workspaceId: string) => page.locator(`[data-workspace="${workspaceId}"]`);

for (const touch of [false, true]) test.describe(touch ? "worktree credentials on touch" : "worktree credentials on desktop", () => {
  const parentId = touch ? "vault-touch" : "vault-desktop";
  const label = touch ? "touch" : "desktop";
  test.use({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch });

  test("a linked worktree's row discloses the parent's credentials", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const credentialName = `Vault token (${label})`;
    const credentialId = await createToken(page, credentialName);
    await assignToParent(page, credentialId, parentId);

    // Fork from the dashboard: the repository heading's own fork control
    // opens the one client worktree dialog.
    await page.goto(`${hub.origin}/`);
    await page.getByRole("button", { name: `Add worktree to ${parentId}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "New branch / worktree", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`New branch / worktree · ${parentId}`);
    const branch = "feature/inherits";
    await dialog.getByLabel("Name", { exact: true }).fill(branch);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-worktree-confirmation]")).toContainText(`Created ${branch}`);
    const childId = await childIdFor(page, parentId, branch);

    // The state API never claims the child holds assignments; the row
    // summarises the parent's and says so.
    const state = await hubState(page);
    const parent = state.find(workspace => workspace.id === parentId)!;
    const child = state.find(workspace => workspace.id === childId)!;
    expect(child.parentId).toBe(parentId);
    expect(child.running).toBe(false);
    expect(child.credentialAssignments).toEqual({ authentication: [], signing: [] });
    expect(parent.credentialAssignments.authentication).toEqual([credentialName]);

    await revealStoppedChildren(page, parentId);
    const childRow = rowFor(page, childId);
    const parentRow = rowFor(page, parentId);
    await expect(childRow.locator(".row-detail")).toHaveText(`🔑 Auth: ${credentialName} · inherited from ${parent.displayName}`);
    await expect(parentRow.locator(".row-detail")).toContainText(`🔑 Auth: ${credentialName}`);
    await expect(parentRow.locator(".row-detail")).not.toContainText("inherited");
    // The row names its branch; the inheritance names the parent by its
    // display name, not the branch of the child.
    await expect(childRow.locator(".row-title")).toContainText(branch);
    // Nothing about the summary pushes a narrow viewport sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await childRow.scrollIntoViewIfNeeded();
    await expect(childRow).toBeInViewport();
    await page.emulateMedia({ colorScheme: "light" });
    await captureScreenshot(page, info, `worktree-credentials-${label}-dashboard`);
    await page.emulateMedia({ colorScheme: "dark" });
    await captureScreenshot(page, info, `worktree-credentials-${label}-dashboard-dark`);
    await page.emulateMedia({ colorScheme: "light" });

    await deleteCredential(page, credentialId);
    // With the parent's policy gone, the child's row says so too — still
    // through the parent, never through assignments of its own.
    await expect(childRow.locator(".row-detail")).toHaveText(`⊘ No credentials assigned · inherited from ${parent.displayName}`);
    expect(errors).toEqual([]);
    await page.close();
  });
});

test.describe("worktree credential policy is managed on the parent", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("assigning to the child is refused, naming the parent", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parentId = "vault-refusal";
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const credentialName = "Refusal token";
    const credentialId = await createToken(page, credentialName);
    await assignToParent(page, credentialId, parentId);
    const childId = await forkViaApi(page, parentId, "feature/refused");
    const refusal = `credentials are managed on the parent workspace ${parentId}; linked worktrees inherit them`;

    const assigned = await post(page, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: childId, role: "authentication", host: HOST,
    });
    expect(assigned.status).toBe(409);
    expect(assigned.body.error).toBe(refusal);

    const replaced = await post(page, `/api/hub/workspaces/${encodeURIComponent(childId)}/credential-assignments`, {
      authentication: { credentialId, host: HOST },
    });
    expect(replaced.status).toBe(409);
    expect(replaced.body.error).toBe(refusal);

    // Removal is refused on the same terms, with and without stop — the
    // child holds no assignment to remove.
    const unassignedStopping = await post(page, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: childId, role: "authentication", host: HOST, stop: true,
    });
    expect(unassignedStopping.status).toBe(409);
    expect(unassignedStopping.body.error).toBe(refusal);
    const unassigned = await post(page, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: childId, role: "authentication", host: HOST,
    });
    expect(unassigned.status).toBe(409);
    expect(unassigned.body.error).toBe(refusal);

    // The parent's policy is intact and still the child's effective policy.
    const state = await hubState(page);
    const parent = state.find(workspace => workspace.id === parentId)!;
    expect(parent.credentialAssignments.authentication).toEqual([credentialName]);
    expect(state.find(workspace => workspace.id === childId)!.credentialAssignments).toEqual({ authentication: [], signing: [] });
    await page.goto(`${hub.origin}/`);
    await revealStoppedChildren(page, parentId);
    await expect(rowFor(page, childId).locator(".row-detail")).toHaveText(`🔑 Auth: ${credentialName} · inherited from ${parent.displayName}`);

    // The parent itself remains assignable through the same routes.
    const parentReplaced = await post(page, `/api/hub/workspaces/${parentId}/credential-assignments`, {
      authentication: { credentialId, host: HOST },
    });
    expect(parentReplaced.status).toBe(200);

    await saveEvidence(info, "worktree-credentials-refusal.json", JSON.stringify({
      realHub: true, realGit: true, parentId, childId,
      refusals: {
        assign: assigned, workspaceAssignments: replaced, unassignWithStop: unassignedStopping, unassign: unassigned,
      },
      parentAssignmentsAfter: parent.credentialAssignments,
    }, null, 2));
    await deleteCredential(page, credentialId);
    expect(errors).toEqual([]);
    await page.close();
  });

  test("a running child shows Restart required on the credential card", async ({ hub, hubContext }, info) => {
    test.setTimeout(90_000);
    const parentId = "vault-restart";
    const page = await hubContext.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const first = await createToken(page, "Restart token A");
    await assignToParent(page, first, parentId);
    const childId = await forkViaApi(page, parentId, "feature/restart");

    // Only the child runs: the parent is stopped, so the flag the card
    // reads can come from nowhere but the running child, whose policy the
    // assignment names through the parent.
    expect((await page.request.post(`/api/hub/sessions/${encodeURIComponent(childId)}/start`)).ok()).toBe(true);
    expect((await page.request.post(`/api/hub/sessions/${encodeURIComponent(parentId)}/stop`)).ok()).toBe(true);
    const before = await hubState(page);
    expect(before.find(workspace => workspace.id === childId)!.running).toBe(true);
    expect(before.find(workspace => workspace.id === parentId)!.running).toBe(false);
    expect(before.find(workspace => workspace.id === childId)!.credentialRestartRequired).toBe(false);

    // The parent's policy changes under the running child: a second token
    // replaces the first as the parent's authentication default.
    const second = await createToken(page, "Restart token B");
    await assignToParent(page, second, parentId, true);
    await expect.poll(async () => {
      const state = await hubState(page);
      return {
        child: state.find(workspace => workspace.id === childId)!.credentialRestartRequired,
        parent: state.find(workspace => workspace.id === parentId)!.credentialRestartRequired,
        parentAuthentication: state.find(workspace => workspace.id === parentId)!.credentialAssignments.authentication,
      };
    }).toEqual({ child: true, parent: false, parentAuthentication: ["Restart token B"] });

    await page.goto(`${hub.origin}/settings`);
    const card = page.locator(`details[data-credential-id="${second}"]`);
    await expect(card).toHaveCount(1);
    await card.locator("summary").click();
    await expect(card).toHaveAttribute("open", "");
    const notice = card.locator(".restart-required");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Restart required");
    // The replaced credential names nobody, so it raises no notice.
    const previous = page.locator(`details[data-credential-id="${first}"]`);
    await expect(previous).toHaveCount(1);
    await expect(previous.locator(".restart-required")).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await expect(notice).toBeInViewport();
    await captureScreenshot(page, info, "worktree-credentials-restart-required");

    expect((await page.request.post(`/api/hub/sessions/${encodeURIComponent(childId)}/stop`)).ok()).toBe(true);
    await deleteCredential(page, first);
    await deleteCredential(page, second);
    expect(errors).toEqual([]);
    await page.close();
  });
});
