import { expect, test, standardBeforeEach } from "./fixtures";
import { clickTreeFile, treeRow } from "./tree-helpers";

test.describe("personal workspace resume state", () => {
  test("workspace root resumes the saved document while an explicit document URL wins", async ({
    page,
    request,
  }) => {
    await standardBeforeEach(page, request);
    await clickTreeFile(page, "guides/setup.md");
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await page.waitForTimeout(75);

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
    await standardBeforeEach(page, request);
    await clickTreeFile(page, "guides/setup.md");
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await page.waitForTimeout(75);

    const secondContext = await browser.newContext();
    const second = await secondContext.newPage();
    await second.goto(`${baseURL}/`);
    await expect(second.locator("#preview-path")).toHaveText("guides/setup.md");

    await treeRow(page, "README.md").click();
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    await page.waitForTimeout(75);
    await expect(second.locator("#preview-path")).toHaveText("guides/setup.md");

    const laterContext = await browser.newContext();
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
