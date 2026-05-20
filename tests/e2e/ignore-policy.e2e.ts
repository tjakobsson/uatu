import { expect, test } from "./fixtures";

import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test(".uatu.json tree.exclude patterns hide files from the tree", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      uatuConfig: { tree: { exclude: ["*.lock"] } },
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

test("--no-gitignore exposes a file that .gitignore would have excluded", async ({ page, request }) => {
  // First confirm the gitignored file is hidden by default.
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        ".gitignore": "secret.txt\n",
        "secret.txt": "hidden\n",
      },
    },
  });
  await page.goto("/");
  await expect(treeRow(page, "secret.txt")).toHaveCount(0);

  // Now reset with respectGitignore disabled.
  await request.post("/__e2e/reset", {
    data: {
      respectGitignore: false,
      extras: {
        ".gitignore": "secret.txt\n",
        "secret.txt": "hidden\n",
      },
    },
  });
  await page.goto("/");
  await expect(treeRow(page, "secret.txt")).toBeVisible();
});
