import { promises as fs } from "node:fs";

import { expect, test } from "./fixtures";
import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";

test("a stale file pin widens its document subscription and stays wide after recreation", async ({
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

  // The document topic's key is the watch context; it is presented in the
  // live stream's `subs` on connect and in a subscription change afterwards.
  const eventScopes: string[] = [];
  const scopeOfKey = (key: string) => new URLSearchParams(key).get("scope") ?? "folder";
  page.on("request", outgoing => {
    const url = new URL(outgoing.url());
    if (url.pathname === "/api/hub/live") {
      const subs = JSON.parse(url.searchParams.get("subs") ?? "[]") as { topic: string; key?: string }[];
      for (const sub of subs) if (sub.topic === "document") eventScopes.push(scopeOfKey(sub.key ?? ""));
    } else if (url.pathname.startsWith("/api/hub/live/") && outgoing.method() === "POST") {
      const change = JSON.parse(outgoing.postData() ?? "{}") as { add?: { topic: string; key?: string }[] };
      for (const sub of change.add ?? []) if (sub.topic === "document") eventScopes.push(scopeOfKey(sub.key ?? ""));
    }
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
