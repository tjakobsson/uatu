import { promises as fs } from "node:fs";

import { expect, test } from "./fixtures";
import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";

test("a stale file pin widens its SSE URL and stays wide after recreation", async ({
  page,
  request,
}) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "stale-pin.md": "# Stale pin\n" } },
  });
  const pinnedPath = workspacePath("stale-pin.md");
  await page.addInitScript(documentId => {
    const originalFetch = window.fetch.bind(window);
    let initialStatePending = true;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (initialStatePending && url.pathname === "/api/state") {
        initialStatePending = false;
        url.searchParams.set("scope", "file");
        url.searchParams.set("documentId", documentId);
        input = input instanceof Request ? new Request(url, input) : url;
      }
      return originalFetch(input, init);
    };
  }, pinnedPath);

  const eventScopes: string[] = [];
  page.on("request", outgoing => {
    const url = new URL(outgoing.url());
    if (url.pathname === "/api/events") eventScopes.push(url.searchParams.get("scope") ?? "folder");
  });

  await page.goto("/");
  await expect(treeRow(page, "stale-pin.md")).toBeVisible();
  await expect(treeRow(page, "README.md")).toHaveCount(0);
  await expect.poll(() => eventScopes.at(-1)).toBe("file");

  await fs.rm(pinnedPath);
  await expect(treeRow(page, "README.md")).toBeVisible();
  await expect.poll(() => eventScopes.includes("folder")).toBe(true);

  await fs.writeFile(pinnedPath, "# Recreated stale pin\n", "utf8");
  await expect(treeRow(page, "stale-pin.md")).toBeVisible();
  await expect(treeRow(page, "README.md")).toBeVisible();
  await expect.poll(() => eventScopes.at(-1)).toBe("folder");
});
