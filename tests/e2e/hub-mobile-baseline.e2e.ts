import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicCredentialDto, ReadinessResult } from "../../src/hub/credential-types";
import type { RootGroup } from "../../src/shared/types";
import { test, expect, loginHub, hubPost } from "./hub-mobile-fixtures";

for (const mobile of [false, true]) {
  test.describe(mobile ? "mobile 390x844" : "desktop 1440x1000", () => {
    test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, colorScheme: "light" });

    test("real Hub lifecycle, credentials and visual baseline", async ({ page, hub }, testInfo) => {
      test.setTimeout(180_000);
      page.setDefaultTimeout(15_000);
      const request = page.request;
      const capture = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        const screenshot = testInfo.outputPath(`${name}.png`);
        const bytes = await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
        await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
        if (process.env.UATU_CAPTURE_HUB_MOBILE_BASELINE === "1") {
          await writeFile(path.resolve("tests/e2e/hub-mobile-baselines", `${mobile ? "mobile" : "desktop"}-${name}.png`), bytes);
        }
      };
      expect((await request.get(`${hub.origin}/api/hub/state`)).status()).toBe(401);
      await page.goto(hub.origin);
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      await capture("login");
      await loginHub(page, hub);

      const ids: string[] = [];
      for (const folder of Object.values(hub.workspaces)) {
        const result = await hubPost<{ workspace: { id: string } }>(request, hub, "/api/hub/workspaces/configure", {
          path: folder, displayName: "Shared workspace", start: false,
        });
        ids.push(result.workspace.id);
      }
      const [a, b] = ids as [string, string];
      expect(a).not.toBe(b);
      const post = <T>(route: string, data?: unknown) => hubPost<T>(request, hub, route, data);
      const credentialRoute = "/api/hub/credentials";
      const passphrase = "isolated baseline key passphrase";
      const ssh = (await post<{ credential: PublicCredentialDto }>(`${credentialRoute}/ssh/generate`, {
        name: "Baseline SSH", capabilities: ["ssh-authentication", "ssh-signing"], passphrase,
      })).credential;
      const pgp = (await post<{ credential: PublicCredentialDto }>(`${credentialRoute}/openpgp/generate`, {
        name: "Baseline OpenPGP", userId: "Hub Baseline <baseline@example.invalid>", passphrase,
      })).credential;
      // Deliberately non-provider secrets: this exercises real token storage and
      // capability metadata, not external GitHub/GitLab authentication.
      const tokens: PublicCredentialDto[] = [];
      for (const [host, capability] of [["github.com", "github-cli"], ["gitlab.com", "gitlab-cli"]]) {
        tokens.push((await post<{ credential: PublicCredentialDto }>(`${credentialRoute}/token`, {
          name: `Baseline ${capability}`, host, token: `test-only-${capability}-not-a-provider-token`,
          capabilities: ["https-git", capability],
        })).credential);
      }
      expect([ssh.type, pgp.type, ...tokens.map(token => token.type)]).toEqual(["ssh", "openpgp", "token", "token"]);
      expect([...new Set([ssh, pgp, ...tokens].flatMap(credential => credential.capabilities))].sort()).toEqual([
        "github-cli", "gitlab-cli", "https-git", "openpgp-signing", "ssh-authentication", "ssh-signing",
      ]);
      for (const credential of [ssh, pgp, ...tokens]) {
        const route = `${credentialRoute}/${credential.id}`;
        if (credential.type !== "token") {
          const publicKey = await request.get(`${hub.origin}${route}/public-key`);
          expect(publicKey.ok()).toBe(true);
          expect((await publicKey.json()).publicKey).toMatch(credential.type === "ssh" ? /^ssh-ed25519 / : /BEGIN PGP PUBLIC KEY BLOCK/);
          await post(`${route}/unlock`, { passphrase });
        }
        const tested = await post<{ results: ReadinessResult[] }>(`${route}/test`);
        expect(tested.results.some(item => item.status === "ready")).toBe(true);
        expect(tested.results.some(item => item.status === "unavailable")).toBe(false);
        const disabled = await post<{ credential: PublicCredentialDto }>(`${route}/disable`);
        expect(disabled.credential.enabled).toBe(false);
        expect(disabled.credential.readiness.some(item => item.status === "unavailable")).toBe(true);
        await post(`${route}/enable`);
        if (credential.type !== "token") await post(`${route}/unlock`, { passphrase });
      }
      await post(`${credentialRoute}/${ssh.id}/lock`);
      expect((await post<{ results: ReadinessResult[] }>(`${credentialRoute}/${ssh.id}/test`)).results[0]?.status).toBe("unavailable");
      await post(`${credentialRoute}/${ssh.id}/unlock`, { passphrase });
      await post(`/api/hub/workspaces/${a}/credential-assignments`, {
        authentication: { credentialId: ssh.id, host: "github.com" }, signing: { credentialId: ssh.id },
      });
      await post(`/api/hub/workspaces/${b}/credential-assignments`, {
        authentication: { credentialId: tokens[0]!.id, host: "github.com" }, signing: { credentialId: pgp.id },
      });
      await post(`/api/hub/sessions/${a}/start`);
      const state = async () => {
        const response = await request.get(`${hub.origin}/api/hub/state`);
        expect(response.ok()).toBe(true);
        return (await response.json()).workspaces as Array<{ id: string; running: boolean; displayName: string }>;
      };
      expect(await state()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: a, running: true, displayName: "Shared workspace" }),
        expect.objectContaining({ id: b, running: false, displayName: "Shared workspace" }),
      ]));
      await page.reload();
      await expect(page.locator(`#sessions a[href="/s/${a}/"]`)).toBeVisible();
      await expect(page.locator("#workspaces")).toContainText(hub.workspaces.b);
      await capture("dashboard-a-running-b-stopped");
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(page.locator(".credential-card")).toHaveCount(4);
      await expect(page.locator("#devices")).toContainText("this device");
      await capture("settings");
      await page.locator(".credential-card").filter({ hasText: "Baseline SSH" }).locator("summary").click();
      await capture("settings-ssh-details");
      await page.getByRole("link", { name: "Add workspace", exact: true }).click();
      await expect(page.locator("#clone-form")).toBeVisible();
      await capture("clone");

      await page.goto(`${hub.origin}/s/${a}/docs/guide.md`);
      await expect(page.locator("#preview-path")).toHaveText("docs/guide.md");
      await expect(page.locator("#preview")).toContainText("Guide A");
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", mobile ? "touch" : "desktop");
      await capture("workspace-a-preview");
      await page.goto(hub.origin);
      expect((await state()).find(item => item.id === a)?.running).toBe(true);
      await post(`/api/hub/sessions/${b}/start`);
      const documentIds: string[] = [];
      for (const id of [a, b]) {
        const response = await request.get(`${hub.origin}/s/${id}/api/state`);
        expect(response.ok()).toBe(true);
        const roots = (await response.json()).roots as RootGroup[];
        const docs = roots.flatMap(root => root.docs);
        expect(docs.map(doc => doc.relativePath).sort()).toEqual(["README.md", "docs/guide.md"]);
        const guide = docs.find(doc => doc.relativePath === "docs/guide.md")!;
        documentIds.push(guide.id);
        const scoped = await request.get(`${hub.origin}/s/${id}/api/state`, {
          params: { scope: "file", documentId: guide.id },
        });
        expect(scoped.ok()).toBe(true);
        const scopedState = await scoped.json();
        expect(scopedState.scope).toEqual({ kind: "file", documentId: guide.id });
        expect((scopedState.roots as RootGroup[]).flatMap(root => root.docs).map(doc => doc.id)).toEqual([guide.id]);
      }
      expect(documentIds[0]).not.toBe(documentIds[1]);
      await page.goto(`${hub.origin}/s/${b}/docs/guide.md`);
      await expect(page.locator("#preview")).toContainText("Guide B");
      await expect(page.locator("#preview")).not.toContainText("Guide A");
      await capture("workspace-b-preview");
      await page.goto(hub.origin);
      await post(`/api/hub/sessions/${a}/stop`);
      await page.goto(`${hub.origin}/s/${a}/`);
      await expect(page.getByText(/not running/i).first()).toBeVisible();
      await capture("workspace-a-stopped");
      expect((await state()).find(item => item.id === a)?.running).toBe(false);
      await post(`/api/hub/sessions/${a}/start`);
      expect((await state()).map(item => item.id).sort()).toEqual([a, b].sort());
      for (const id of [a, b]) await post(`/api/hub/sessions/${id}/stop`);
      // Export only the fixture's generated keys, hold them in memory, then
      // exercise import after deletion. No private fixture material is retained.
      const sshPrivate = await readFile(path.join(hub.root, "state", "credential-secrets", `${ssh.id}.key`), "utf8");
      if (pgp.type !== "openpgp") throw new Error("expected generated OpenPGP identity");
      const pgpPrivate = execFileSync("gpg", [
        "--homedir", path.join(hub.root, "state", "credential-gnupg"),
        "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--armor", "--export-secret-keys", pgp.metadata.fingerprint,
      ], { env: hub.env, input: `${passphrase}\n`, encoding: "utf8", timeout: 15_000 });
      for (const credential of [ssh, pgp, ...tokens]) {
        await post(`${credentialRoute}/${credential.id}/delete`, { confirm: true, unassign: true });
      }
      expect((await (await request.get(`${hub.origin}${credentialRoute}`)).json()).credentials).toEqual([]);
      for (const [credential, privateKey] of [[ssh, sshPrivate], [pgp, pgpPrivate]] as const) {
        const imported = (await post<{ credential: PublicCredentialDto }>(`${credentialRoute}/${credential.type}/import`, {
          name: `Imported ${credential.type}`, privateKey,
          ...(credential.type === "ssh" ? { capabilities: credential.capabilities, passphrase } : {}),
        })).credential;
        expect(imported.type).toBe(credential.type);
        expect(imported.metadata).toEqual(credential.metadata);
        await post(`${credentialRoute}/${imported.id}/delete`, { confirm: true });
      }
    });
  });
}
