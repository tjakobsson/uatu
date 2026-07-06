import { expect, test, standardBeforeEach } from "./fixtures";

// Project identity (issues #101/#102): the tab title, favicon tint, and
// sidebar marker all derive from the watched roots so simultaneous uatu
// instances are distinguishable. The e2e workspace root is `watch-docs`
// with a per-worker suffix (e.g. `watch-docs-w0`), so labels are matched
// by prefix.

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("tab title carries the project label", async ({ page }) => {
  await expect(page).toHaveTitle(/^watch-docs.* — uatu$/);
});

test("dynamic favicon exists exactly once with the project initial and hue", async ({ page }) => {
  const favicon = page.locator("link#project-favicon");
  await expect(favicon).toHaveCount(1);
  const href = await favicon.getAttribute("href");
  expect(href).toContain("data:image/svg+xml");
  const svg = decodeURIComponent(href!);
  expect(svg).toContain(">w</text>");
  expect(svg).toContain("hsl(");
});

test("change overview names the repository with a hue badge and root-path tooltip", async ({ page }) => {
  const marker = page.locator("#change-overview .project-marker").first();
  await expect(marker).toBeVisible();

  // The badge text is the repository label (the enclosing git repo's name,
  // which for the default non-git-initialized e2e workspace is this repo
  // itself) — read the expectation from the same payload the app renders.
  const repositoryLabel = await page.evaluate(async () => {
    const state = (await (await fetch("/api/state")).json()) as {
      repositories: { label: string }[];
    };
    return state.repositories[0]?.label ?? "";
  });
  expect(repositoryLabel).not.toBe("");
  await expect(marker).toHaveText(repositoryLabel);

  // The tooltip carries the watched roots' full paths.
  const tooltip = await marker.getAttribute("title");
  expect(tooltip).toContain("watch-docs");

  // The marker's inline background and the favicon share the identity hue.
  const background = await marker.evaluate(el => (el as HTMLElement).style.backgroundColor);
  expect(background).not.toBe("");
  const hueFromBackground = await marker.evaluate(el => (el as HTMLElement).style.backgroundColor);
  const href = await page.locator("link#project-favicon").getAttribute("href");
  // Browsers normalize inline hsl() to rgb(); assert agreement by rendering
  // the favicon's hsl through the same normalization.
  const faviconHsl = decodeURIComponent(href!).match(/hsl\([^)]+\)/)?.[0];
  expect(faviconHsl).toBeTruthy();
  const normalizedFaviconColor = await page.evaluate(hsl => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = hsl!;
    return probe.style.backgroundColor;
  }, faviconHsl);
  expect(hueFromBackground).toBe(normalizedFaviconColor);
});
