// Listing an ignored folder through a real Hub: the session page posts to its
// /s/<id>/api/index/folder, the Hub brokers the child credential, and the
// listing comes back over the one brokered live stream.
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, openSessionTab, test } from "./hub-fixtures";
import { revealTreeRow, treeRow } from "./tree-helpers";

test.use({ hubWorkspaces: ["alpha"] });

test("an ignored folder becomes an entry and lists on expansion through the Hub", async ({ hub, hubContext }) => {
  const workspace = hub.workspaces[0]!;
  const page = await openSessionTab(hubContext, workspace);
  const listings: { status: number; url: string }[] = [];
  page.on("response", response => { if (response.url().includes("/api/index/folder")) listings.push({ status: response.status(), url: response.url() }); });
  // Make the workspace a Git repository that ignores build/. Its contents
  // were already read (the root started outside Git), so the session adopts
  // build/ as listed; a rebuild rediscovers it unread, as on a fresh start.
  await fs.mkdir(path.join(workspace.path, "build"), { recursive: true });
  await fs.writeFile(path.join(workspace.path, "build", "CMakeCache.txt"), "CMAKE_BUILD_TYPE:STRING=Release\n");
  execFileSync("git", ["init", "-q"], { cwd: workspace.path });
  await fs.writeFile(path.join(workspace.path, ".gitignore"), "/build*/\n");
  const recovered = await page.evaluate(async () => (await fetch(new URL("api/index/recover", location.href), { method: "POST" })).status);
  expect(recovered).toBe(200);
  const row = async (target: string) => { await revealTreeRow(page, target); return treeRow(page, target); };
  await expect.poll(async () => (await row("build/")).getAttribute("aria-expanded"), { timeout: 15_000 }).toBe("false");
  await (await row("build/")).click();
  await expect.poll(async () => (await row("build/CMakeCache.txt")).count(), { timeout: 10_000 }).toBe(1);
  expect(listings).toEqual([{ status: 200, url: expect.stringContaining(`/s/${workspace.id}/api/index/folder`) }]);
});
