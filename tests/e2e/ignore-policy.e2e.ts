import { expect, test } from "./fixtures";

import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test(".uatu.json ignore.exclude patterns hide files from the tree", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      uatuConfig: { ignore: { exclude: ["*.lock"] } },
      extras: {
        "bun.lock": "lockfile contents\n",
        "notes.txt": "visible text\n",
      },
    },
  });
  await page.goto("/");
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await page.reload();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

  await expect(treeRow(page, "notes.txt")).toBeVisible();
  await expect(treeRow(page, "bun.lock")).toHaveCount(0);
});

test("--no-gitignore overrides the explicit legacy initial-visibility default", async ({ page, request }) => {
  // An explicit legacy setting initially hides known ignored files.
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      uatuConfig: { ignore: { respectGitignore: true } },
      extras: {
        ".gitignore": "secret.txt\n",
        "secret.txt": "hidden\n",
      },
    },
  });
  await page.goto("/");
  await expect(page.locator("#files-show-ignored")).not.toBeChecked();
  await expect(treeRow(page, "secret.txt")).toHaveCount(0);

  // Now reset with respectGitignore disabled.
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      respectGitignore: false,
      uatuConfig: { ignore: { respectGitignore: true } },
      extras: {
        ".gitignore": "secret.txt\n",
        "secret.txt": "hidden\n",
      },
    },
  });
  await page.goto("/");
  await expect(page.locator("#files-show-ignored")).toBeChecked();
  await expect(treeRow(page, "secret.txt")).toBeVisible();
});

test("unconfigured ignored files show and a saved personal choice wins at next boot", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true, extras: { ".gitignore": "ignored.txt\n", "ignored.txt": "permitted output\n" } } });
  await page.goto("/");
  await expect(page.locator("#files-show-ignored")).toBeChecked();
  await expect(treeRow(page, "ignored.txt")).toBeVisible();
  await request.patch("/api/personal-state", { data: { showIgnored: false } });
  await page.reload();
  await expect(page.locator("#files-show-ignored")).not.toBeChecked();
  await expect(treeRow(page, "ignored.txt")).toHaveCount(0);
  // Direct delivery is independent of browsing visibility.
  const direct = await request.get("/ignored.txt", { headers: { accept: "text/plain" } });
  expect(direct.status()).toBe(200);
  expect(await direct.text()).toBe("permitted output\n");
});
