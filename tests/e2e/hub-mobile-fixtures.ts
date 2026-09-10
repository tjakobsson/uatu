import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type HubMobileFixture = {
  origin: string;
  root: string;
  env: NodeJS.ProcessEnv;
  workspaces: Record<"a" | "b", string>;
};

export const test = base.extend<{ hub: HubMobileFixture }>({
  hub: [async ({}, use) => {
    // Short paths matter for real Unix-domain SSH/GnuPG agent sockets on macOS.
    const root = await realpath(await mkdtemp("/tmp/uatu-hm-"));
    const home = path.join(root, "home");
    await mkdir(home);
    // Do not inherit the invoking Hub's projected Git/SSH wrappers, agents,
    // provider credentials, or the developer's personal config directories.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.UATU_HUB_MOBILE_TOOL_PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      GNUPGHOME: path.join(home, ".gnupg"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LANG: "en_US.UTF-8",
      TMPDIR: root,
    };
    const cli = path.resolve("src/cli.ts");
    let logs = "";
    try {
      const passwordHash = execFileSync("bun", [cli, "hub", "hash-password"], {
        env, input: "hub mobile test password\n", encoding: "utf8", timeout: 30_000,
      }).trim();
      const config = path.join(root, "hub.json");
      await writeFile(config, JSON.stringify({
        host: "127.0.0.1", stateDir: path.join(root, "state"),
        users: [{ name: "baseline", passwordHash }],
      }), { mode: 0o600 });
      const workspaces = { a: path.join(root, "workspace-a"), b: path.join(root, "workspace-b") };
      for (const [identity, folder] of Object.entries(workspaces)) {
        await mkdir(path.join(folder, "docs"), { recursive: true });
        execFileSync("git", ["init", "--quiet", folder], { env });
        await writeFile(path.join(folder, "README.md"), `# Workspace ${identity.toUpperCase()}\n\nRoot document.\n`);
        await writeFile(path.join(folder, "docs", "guide.md"), `# Guide ${identity.toUpperCase()}\n\nScoped document belonging only to workspace ${identity.toUpperCase()}.\n`);
      }
      const child = spawn("bun", [cli, "hub", "--config", config, "--port", "0", "--exit-on-stdin-close"], {
        env, stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise<number | null>(resolve => child.once("close", resolve));
      child.stderr?.on("data", chunk => { logs = (logs + chunk.toString()).slice(-20_000); });
      try {
        const origin = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Hub startup timed out\n${logs}`)), 45_000);
          let stdout = "";
          child.stdout?.on("data", chunk => {
            stdout += chunk.toString();
            const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (match) { clearTimeout(timer); resolve(match[0]); }
          });
          child.once("error", error => { clearTimeout(timer); reject(error); });
          void exited.then(code => { clearTimeout(timer); reject(new Error(`Hub exited (${code})\n${logs}`)); });
        });
        await use({ origin, root, env, workspaces });
      } finally {
        // Production stdin-EOF shutdown awaits workspaces and dedicated agents.
        child.stdin?.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        const code = await exited.finally(() => clearTimeout(timer));
        expect(code, `Hub must shut down cleanly\n${logs}`).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, { timeout: 90_000 }],
});

export { expect };

export async function loginHub(page: Page, hub: HubMobileFixture): Promise<void> {
  await page.goto(hub.origin);
  await expect(page).toHaveURL(`${hub.origin}/login`);
  await page.getByRole("textbox", { name: "User", exact: true }).fill("baseline");
  await page.getByLabel("Password", { exact: true }).fill("hub mobile test password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${hub.origin}/`);
}

export async function hubPost<T>(request: APIRequestContext, hub: HubMobileFixture, route: string, data: unknown = {}): Promise<T> {
  const response = await request.post(`${hub.origin}${route}`, { headers: { origin: hub.origin }, data, timeout: 45_000 });
  expect(response.ok(), `${route}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}
