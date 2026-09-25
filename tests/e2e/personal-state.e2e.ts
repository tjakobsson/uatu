import { promises as fs } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { workspacePath } from "./config";
import { expect, test, standardBeforeEach } from "./fixtures";
import { attachPageDiagnosticsOnFailure, recordContextDiagnostics } from "./page-diagnostics";
import { clickTreeFile, treeRow } from "./tree-helpers";

attachPageDiagnosticsOnFailure(test);

async function expectSavedDocument(request: APIRequestContext, documentPath: string): Promise<void> {
  // The preview updates before the debounced PATCH completes. Read the
  // server's state before navigating or asking another browser to resume it.
  await expect.poll(async () => {
    const response = await request.get("/api/personal-state");
    expect(response.ok()).toBe(true);
    return (await response.json()).documentPath;
  }).toBe(documentPath);
}

test.describe("personal workspace resume state", () => {
  test("workspace root resumes the saved document while an explicit document URL wins", async ({
    page,
    request,
  }) => {
    await standardBeforeEach(page, request);
    await clickTreeFile(page, "guides/setup.md");
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expectSavedDocument(request, "guides/setup.md");

    await page.goto("/");
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");

    await page.goto("/README.md");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  test("open clients stay independent and a later browser restores the newest state", async ({
    browser,
    page,
    request,
    baseURL,
  }) => {
    await recordContextDiagnostics(page.context(), "first");
    await standardBeforeEach(page, request);
    await clickTreeFile(page, "guides/setup.md");
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expectSavedDocument(request, "guides/setup.md");

    const secondContext = await browser.newContext();
    await recordContextDiagnostics(secondContext, "second");
    const second = await secondContext.newPage();
    await second.goto(`${baseURL}/`);
    await expect(second.locator("#preview-path")).toHaveText("guides/setup.md");
    // Open means live, not merely booted: the second client's stream has
    // delivered its first state frame, which re-confirms the selection it
    // resumed. That frame must not re-save guides/setup.md; had it landed
    // after the navigation below, it used to overwrite the newer choice.
    await expect(second.locator("#connection-state .connection-label")).toHaveText("Connected");

    // The first client is still settled on guides/setup.md, with README.md
    // shown and not selected, when the user picks it.
    const readme = treeRow(page, "README.md");
    await expect(readme).toBeVisible();
    await expect(readme).toHaveAttribute("aria-selected", "false");
    await readme.click();
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expectSavedDocument(request, "README.md");
    await expect(second.locator("#preview-path")).toHaveText("guides/setup.md");

    // The second client stays open and keeps receiving watcher frames. One
    // that changes the document it shows reloads it in place; that is not the
    // user choosing it again, so it must not become the newest saved state.
    await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nEdited while the other client moved on.\n", "utf8");
    await expect(second.locator("#preview")).toContainText("Edited while the other client moved on.");
    await expect(second.locator("#preview-path")).toHaveText("guides/setup.md");

    const laterContext = await browser.newContext();
    await recordContextDiagnostics(laterContext, "later");
    const later = await laterContext.newPage();
    await later.goto(`${baseURL}/`);
    await expect(later.locator("#preview-path")).toHaveText("README.md");

    await laterContext.close();
    await secondContext.close();
  });

  test("a fragment-bearing root uses the session default instead of a saved document", async ({
    page,
    request,
  }) => {
    await request.post("/__e2e/reset");
    await request.patch("/api/personal-state", {
      data: { documentPath: "guides/setup.md", follow: true },
    });

    await page.goto("/#uatu");
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  });
});
