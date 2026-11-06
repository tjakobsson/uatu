import { promises as fs } from "node:fs";
import { expect, test } from "./fixtures";
import { workspacePath } from "./config";
import type { Page } from "@playwright/test";
import { attachPageDiagnosticsOnFailure, recordContextDiagnostics } from "./page-diagnostics";

attachPageDiagnosticsOnFailure(test);

async function showIgnored(page: Page, value: boolean): Promise<void> {
  await page.getByRole("button", { name: "Files options", exact: true }).click();
  await page.getByRole("checkbox", { name: "Show ignored files" }).setChecked(value);
  await page.getByRole("button", { name: "Files options", exact: true }).click();
}

test.afterEach(async ({ request }) => { await request.post("/__e2e/reset"); });

test("clients nominate visible Follow candidates independently using the same live connection", async ({ page, browser, request, baseURL }) => {
  test.setTimeout(60_000);
  await request.post("/__e2e/reset", { data: { git: true, follow: false, extras: { ".gitignore": "ignored.md\n", "ignored.md": "# Ignored\n", "visible.md": "# Visible\n" } } });
  const secondContext = await browser.newContext({ baseURL });
  await recordContextDiagnostics(secondContext, "hidden-client");
  const second = await secondContext.newPage();
  const streams = [0, 0];
  for (const [index, client] of [page, second].entries()) client.on("request", req => {
    if (new URL(req.url()).pathname === "/api/hub/live") streams[index]!++;
  });
  try {
    await page.goto("/README.md");
    await second.goto(`${baseURL}/README.md`);
    for (const client of [page, second]) await expect(client.locator("#connection-state .connection-label")).toHaveText("Connected");
    await expect.poll(async () => {
      const state = await (await request.get("/api/state")).json();
      return state.roots.flatMap((root: any) => root.docs).find((doc: any) => doc.relativePath === "ignored.md")?.gitIgnoreStatus;
    }).toBe("ignored");
    const before = second.url();
    await showIgnored(second, false);
    expect(second.url()).toBe(before);
    await expect(page.locator("#files-show-ignored")).toBeChecked();
    await expect(second.locator("#files-show-ignored")).not.toBeChecked();
    for (const client of [page, second]) await client.locator("#follow-toggle").click();
    await fs.writeFile(workspacePath("visible.md"), "# Visible new write\n");
    for (const client of [page, second]) await expect(client.locator("#preview-path")).toHaveText("visible.md");
    await fs.writeFile(workspacePath("ignored.md"), "# Ignored new write\n");
    await expect(page.locator("#preview-path")).toHaveText("ignored.md");
    await expect(second.locator("#preview-path")).toHaveText("visible.md");
    await expect(second.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(streams).toEqual([1, 1]);
    // A context baseline containing an older eligible edit cannot steer a
    // following client merely because rows become visible again.
    const selected = second.url();
    await showIgnored(second, true);
    await expect.poll(async () => (await (await second.request.get("/api/personal-state")).json()).showIgnored).toBe(true);
    await expect(second.locator("#preview-path")).toHaveText("visible.md");
    expect(second.url()).toBe(selected);
    expect(streams).toEqual([1, 1]);
  } finally {
    await secondContext.close().catch(() => {});
  }
});

test("content search uses ignored visibility while direct access keeps exposure policy", async ({ request }) => {
  await request.post("/__e2e/reset", { data: { git: true, uatuConfig: { ignore: { exclude: ["private.txt"] } }, extras: { ".gitignore": "ignored.txt\n", "ignored.txt": "distinct-ignored-needle\n", "visible.txt": "distinct-ignored-needle\n", "private.txt": "distinct-ignored-needle\n" } } });
  await expect.poll(async () => {
    const state = await (await request.get("/api/state")).json();
    return state.roots.flatMap((root: any) => root.docs).find((doc: any) => doc.relativePath === "ignored.txt")?.gitIgnoreStatus;
  }).toBe("ignored");
  for (const allRoots of ["0", "1"]) {
    const hidden = await request.get(`/api/search?q=distinct-ignored-needle&showIgnored=0&allRoots=${allRoots}`);
    const visible = await request.get(`/api/search?q=distinct-ignored-needle&showIgnored=1&allRoots=${allRoots}`);
    expect(await hidden.text()).not.toContain('"relativePath":"ignored.txt"');
    const shown = await visible.text();
    expect(shown).toContain('"relativePath":"ignored.txt"');
    expect(shown).not.toContain('"relativePath":"private.txt"');
  }
  const direct = await request.get("/ignored.txt", { headers: { accept: "text/plain" } });
  expect(direct.status()).toBe(200);
  expect(await direct.text()).toBe("distinct-ignored-needle\n");
  expect((await request.get("/private.txt", { headers: { accept: "text/plain" } })).status()).toBe(404);
});
