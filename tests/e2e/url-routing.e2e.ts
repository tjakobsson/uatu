import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("typing a doc URL boots the SPA on that document with follow off", async ({ page }) => {
  await page.goto("/guides/setup.md");

  // Rendered preview, not raw markdown — `#preview-title` only exists in the
  // SPA shell, and a heading inside the preview confirms the renderer ran.
  await expect(page.locator("#preview-title")).toHaveText("Setup");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(page.locator("#preview h1")).toBeVisible();
  // Direct-link arrival forces follow off regardless of CLI default (D3).
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  // Sidebar selection follows the URL.
  await expect(
    treeRow(page, "guides/setup.md"),
  ).toHaveAttribute("aria-selected", "true");
});

test("in-app cross-doc clicks push history; back restores the previous document", async ({ page }) => {
  // Start on the markdown links demo and click into another doc.
  await treeRow(page, "links-demo.md").click();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");

  await page.locator('#preview a[href="guides/setup.md"]').click();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  expect(new URL(page.url()).pathname).toBe("/guides/setup.md");

  await page.goBack();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");
  expect(new URL(page.url()).pathname).toBe("/links-demo.md");
  await expect(
    treeRow(page, "links-demo.md"),
  ).toHaveAttribute("aria-selected", "true");
});

test("browser back disables follow mode so the next file change does not undo the navigation", async ({ page }) => {
  // Build a back stack: README → links-demo → README (the second README entry
  // comes from clicking Follow, which catches up to the most recently
  // modified file — README.md — and pushes its URL).
  await treeRow(page, "links-demo.md").click();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  // Pressing back must drop follow off so a subsequent file change does not
  // yank the preview back to the latest changed file.
  await page.goBack();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  // A file change must NOT switch the preview now that follow is off.
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nNo auto-switch please.\n", "utf8");
  await page.waitForTimeout(500);
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");
});

test("forward button restores a document the user just stepped back from", async ({ page }) => {
  await treeRow(page, "links-demo.md").click();
  await page.locator('#preview a[href="guides/setup.md"]').click();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");

  await page.goBack();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");

  await page.goForward();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  expect(new URL(page.url()).pathname).toBe("/guides/setup.md");
});

test("refreshing a deep-linked URL re-renders the same document", async ({ page }) => {
  await page.goto("/guides/setup.md");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");

  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  expect(new URL(page.url()).pathname).toBe("/guides/setup.md");
});

test("follow auto-switch updates the URL via replaceState (back stack does not grow)", async ({ page }) => {
  // beforeEach already clicked README, which set follow=off and pushed a
  // history entry for /README.md. Re-enable follow, snapshot history.length,
  // then make a file-system change and assert the URL updates without
  // growing the back stack — that's the replaceState contract.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  const initialDepth = await page.evaluate(() => window.history.length);

  await fs.writeFile(
    workspacePath("guides", "setup.md"),
    "# Setup\n\nFollow auto-switch trigger.\n",
    "utf8",
  );

  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/guides/setup.md");

  const finalDepth = await page.evaluate(() => window.history.length);
  expect(finalDepth).toBe(initialDepth);
});

test("direct-link to a doc outside the file-scoped session renders the session-pinned message", async ({ page, request }) => {
  // The Pin UI affordance is gone, but the server-side file-scope mechanism
  // is preserved (CLI single-file watch still uses it; future workflows may
  // expose it again). Hit the /api/scope endpoint directly to put the
  // folder-scoped session into file-mode without restarting it.
  await request.post("/api/scope", {
    data: { scope: { kind: "file", documentId: workspacePath("README.md") } },
  });
  await page.goto("/");
  await expect(page.locator("#document-count")).toHaveText("1 file");

  // Now navigate to a doc outside the file-scope. The server returns the
  // SPA shell because the doc exists in the unscoped index (the original
  // folder watch); the SPA boots, sees scope.kind === "file" with a
  // different documentId, and renders the empty-preview state with a
  // "session pinned" message.
  await page.goto("/guides/setup.md");

  await expect(page.locator("#preview-title")).toHaveText("Session pinned");
  await expect(page.locator("#preview-path")).toContainText("Session pinned to README.md");
  await expect(page.locator("#preview")).toHaveClass(/empty/);

  // Sidebar still shows only the scoped file.
  await expect(page.locator("#document-count")).toHaveText("1 file");
  await expect(treeRow(page, "README.md")).toBeVisible();
  await expect(treeRow(page, "guides/setup.md")).toHaveCount(0);
});

test("direct-link with a fragment scrolls the matching heading into view", async ({ page, request }) => {
  // Use AsciiDoc — it generates `user-content-*` heading ids the SPA's
  // `scrollToFragment` is built around. The doc is intentionally long so the
  // bottom heading starts below the fold and the scroll has somewhere to go.
  const padding = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of filler text.`).join("\n\n");
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "deep.adoc": `= Deep Doc\n\n${padding}\n\n== Bottom\n\nThe bottom heading.\n`,
      },
    },
  });

  await page.goto("/deep.adoc#_bottom");
  await expect(page.locator("#preview-title")).toHaveText("Deep Doc");

  // The heading id in the rendered HTML is `user-content-_bottom` (sanitize
  // prefix + asciidoctor's own underscore-prefixed slug). The SPA's
  // `scrollToFragment` mirrors the `user-content-` prefix automatically.
  const target = page.locator("#preview h2[id='user-content-_bottom']");
  await expect(target).toBeInViewport();
});

test("direct link to an unknown path returns the static fallback 404", async ({ request }) => {
  // Browser-style Accept header — must NOT receive the SPA shell for a path
  // that does not resolve to any viewable doc (per design D4).
  const response = await request.get("/typo-not-a-real-doc.md", {
    headers: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    },
  });
  expect(response.status()).toBe(404);
  const body = await response.text();
  // The SPA shell is NOT served — body should NOT look like the SPA HTML.
  expect(body).not.toContain('id="preview"');
});

test("popstate to a deleted document renders the document-not-found empty preview", async ({ page }) => {
  // Build a back stack: /README.md (boot) → /links-demo.md (sidebar click).
  await treeRow(page, "links-demo.md").click();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");

  // Delete README.md from disk; wait for the SSE-driven sidebar refresh.
  await fs.rm(workspacePath("README.md"));
  await expect(treeRow(page, "README.md")).toHaveCount(0);

  // Press back — URL goes to /README.md but the doc no longer exists. The
  // popstate handler must fall through to the not-found empty preview.
  await page.goBack();
  await expect(page.locator("#preview-title")).toHaveText("Document not found");
  await expect(page.locator("#preview-path")).toContainText("Document not found at README.md");
  await expect(page.locator("#preview")).toHaveClass(/empty/);
});

test("URL pathname percent-encodes path segments with spaces", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "hello world.md": "# Hello World\n" } },
  });
  await page.goto("/");

  await treeRow(page, "hello world.md").click();
  await expect(page.locator("#preview-path")).toHaveText("hello world.md");
  expect(new URL(page.url()).pathname).toBe("/hello%20world.md");

  // The encoded URL must round-trip cleanly: refreshing it boots back into
  // the same document via the per-segment decode in the boot path.
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("hello world.md");
});

test("user can re-enable follow after a direct-link arrival and catch up to the latest file", async ({ page }) => {
  // Make setup.md strictly newer than every other file so the follow catch-up
  // has an unambiguous target.
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nFreshly touched.\n", "utf8");
  const fresher = new Date(Date.now() + 30_000);
  await fs.utimes(workspacePath("guides", "setup.md"), fresher, fresher);

  // Arrive via a direct link to a different doc; follow must be off (per D3).
  await page.goto("/links-demo.md");
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  // Wait for the polling watcher + SSE refresh to deliver the bumped mtime
  // to the SPA's local index. The previous `.tree-mtime[data-mtime]` data
  // attributes were retired with the live-mtime ticker, so this is a bounded
  // delay rather than a deterministic readiness probe.
  await page.waitForTimeout(800);

  // Re-enable follow — must catch up to setup.md immediately.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
});
