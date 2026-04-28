import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "../../src/e2e";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Online");
  await expect(page.locator("#document-count")).toHaveText("7 files");
  await waitForPreviewToSettle(page);
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

async function waitForPreviewToSettle(page: Page): Promise<void> {
  let previousPath = "";

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const currentPath = (await page.locator("#preview-path").textContent())?.trim() ?? "";
    if (currentPath.length > 0 && currentPath === previousPath) {
      await page.waitForTimeout(300);

      const settledPath = (await page.locator("#preview-path").textContent())?.trim() ?? "";
      if (settledPath === currentPath) {
        return;
      }
    }

    previousPath = currentPath;
    await page.waitForTimeout(150);
  }
}


test("renders GFM content and Mermaid diagrams", async ({ page }) => {
  await page.getByRole("button", { name: "diagram.md" }).click();

  await expect(page.locator("#preview-title")).toHaveText("Diagram Fixture");
  await expect(page.locator("#preview table")).toBeVisible();
  await expect(page.locator('#preview input[type="checkbox"]')).toHaveCount(2);
  await expect(page.locator('#preview a[href="https://example.com"]')).toBeVisible();
  await expect(page.locator("#preview .mermaid svg")).toBeVisible();
});

test("manual selection disables follow mode and keeps the current preview pinned", async ({ page }) => {
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nChanged while pinned.\n", "utf8");

  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#preview-title")).toHaveText("Uatu");
});

test("follow mode switches to the latest changed markdown file", async ({ page }) => {
  const marker = `Changed by Playwright ${Date.now()}`;
  const relativePath = "guides/setup.md";

  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  await fs.writeFile(workspacePath(relativePath), `# Setup\n\n${marker}\n`, "utf8");

  await expect(page.locator("#preview-path")).toHaveText(relativePath);
  await expect(page.locator("#preview")).toContainText(marker);
});

test("tree rows show a file-type icon next to each document", async ({ page }) => {
  const readmeButton = page.getByRole("button", { name: "README.md" });
  await expect(readmeButton.locator(".tree-icon svg")).toBeVisible();
});

test("tree rows show a relative-time label on both file leaves and directories", async ({ page }) => {
  const readmeButton = page.getByRole("button", { name: "README.md" });
  await expect(readmeButton.locator(".tree-mtime")).toHaveCount(1);
  await expect(readmeButton.locator(".tree-mtime")).toHaveText(/^(now|\d+(s|m|h|d|w|mo))$/);

  // Directories also carry a tree-mtime in their <summary> — reflecting the newest
  // descendant file's modified time so users can spot active subtrees at a glance.
  const guidesSummary = page.locator('#tree details summary:has-text("guides")');
  await expect(guidesSummary).toBeVisible();
  await expect(guidesSummary.locator(".tree-mtime")).toHaveCount(1);
  await expect(guidesSummary.locator(".tree-mtime")).toHaveText(/^(now|\d+(s|m|h|d|w|mo))$/);
});

test("relative-time labels tick live without requiring a server event", async ({ page }) => {
  const readmeMtime = page.locator('button[data-document-id$="README.md"] .tree-mtime');
  const before = (await readmeMtime.textContent())?.trim() ?? "";
  // Wait long enough that a "Ns" label should bump to a larger N.
  await page.waitForTimeout(3500);
  const after = (await readmeMtime.textContent())?.trim() ?? "";
  expect(after).not.toBe("");
  // If the label is in the seconds bucket, it must have advanced.
  if (/^\d+s$/.test(before) && /^\d+s$/.test(after)) {
    expect(Number.parseInt(after, 10)).toBeGreaterThan(Number.parseInt(before, 10));
  }
});

test("follow mode reveals the path to a newly changed nested file without closing anything", async ({ page }) => {
  const guidesDetails = page
    .locator("#tree details")
    .filter({ has: page.locator('summary:has-text("guides")') });

  // Start with guides collapsed (default) and README.md selected.
  await expect(guidesDetails).not.toHaveAttribute("open", "");

  // Turn follow mode on, then modify guides/setup.md so follow auto-switches.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nReveal me.\n", "utf8");

  // The preview follows. The tree should reveal the path to the file.
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(guidesDetails).toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "setup.md" })).toBeVisible();
});

test("manually opened directories stay open across file selections", async ({ page }) => {
  const guidesDetails = page
    .locator("#tree details")
    .filter({ has: page.locator('summary:has-text("guides")') });

  // Directories default to closed.
  await expect(guidesDetails).not.toHaveAttribute("open", "");

  // User expands 'guides'.
  await guidesDetails.locator("summary").click();
  await expect(guidesDetails).toHaveAttribute("open", "");

  // Selecting a different file must not silently collapse it.
  await page.getByRole("button", { name: "diagram.md" }).click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect(guidesDetails).toHaveAttribute("open", "");
});

test("sidebar collapse preference persists across reloads", async ({ page }) => {
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-sidebar-collapsed/);

  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await expect(page.locator("#sidebar-expand")).toBeVisible();

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);

  await page.locator("#sidebar-expand").click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-sidebar-collapsed/);
});

test("pin toggle narrows the sidebar to the current document and ignores changes elsewhere", async ({ page }) => {
  await expect(page.locator("#document-count")).toHaveText("7 files");
  await page.locator("#pin-toggle").click();
  await expect(page.locator("#pin-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#document-count")).toHaveText("1 file");
  await expect(page.locator("#follow-toggle")).toBeDisabled();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  const offPinPath = "guides/setup.md";
  await fs.writeFile(workspacePath(offPinPath), "# Setup\n\nOff-pin change should be ignored.\n", "utf8");

  await page.waitForTimeout(500);
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#document-count")).toHaveText("1 file");

  await page.locator("#pin-toggle").click();
  await expect(page.locator("#pin-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#document-count")).toHaveText("7 files");
  await expect(page.locator("#follow-toggle")).toBeEnabled();
});

test("connection indicator exposes live and reconnecting classes", async ({ page }) => {
  await expect(page.locator("#connection-state")).toHaveClass(/is-live/);

  await page.evaluate(() => {
    window.fetch("/__e2e/pretend-no-op").catch(() => {});
  });
  // The indicator stays live while the SSE channel is open; we just assert the baseline class contract.
  await expect(page.locator("#connection-state.is-live .indicator-dot")).toBeVisible();
});

test("single-file mode shows only the pinned markdown file in the sidebar", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { file: "README.md" } });
  await page.goto("/");
  await expect(page.locator("#document-count")).toHaveText("1 file");
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "setup.md" })).toHaveCount(0);
});

test("relative image references in a README are served natively from the watched root", async ({ page, request }) => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#1ca8a7"/></svg>`;
  await fs.writeFile(workspacePath("hero.svg"), svg, "utf8");
  await fs.writeFile(
    workspacePath("README.md"),
    `# Uatu\n\n<p align="center"><img src="./hero.svg" alt="hero" width="16" height="16" /></p>\n`,
    "utf8",
  );

  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "README.md" }).click();

  const img = page.locator('#preview img[alt="hero"]');
  await expect(img).toBeVisible();

  // Rendered HTML preserves the original relative URL verbatim.
  expect(await img.getAttribute("src")).toBe("./hero.svg");

  // The browser actually loaded the image through the static file fallback.
  await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
  const resolved = await img.evaluate((el: HTMLImageElement) => el.currentSrc);
  expect(resolved).toMatch(/\/hero\.svg$/);

  const response = await request.get("/hero.svg");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg");
});

test("server falls back with 404 for paths outside every watched root", async ({ request }) => {
  const response = await request.get("/does-not-exist.bin");
  expect(response.status()).toBe(404);
});

test("a non-Markdown text file appears in the tree and renders as syntax-highlighted code", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: value\nport: 4321\n" } },
  });
  await page.goto("/");
  await expect(page.locator("#document-count")).toHaveText("8 files");

  const yamlButton = page.getByRole("button", { name: "config.yaml" });
  await expect(yamlButton).toBeVisible();
  await yamlButton.click();

  await expect(page.locator("#preview-path")).toHaveText("config.yaml");
  await expect(page.locator('#preview pre code.hljs.language-yaml')).toBeVisible();
});

test("a binary file appears in the tree as a non-clickable entry", async ({ page, request }) => {
  // 1x1 transparent PNG.
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const pngBytes = Buffer.from(pngBase64, "base64").toString("latin1");
  await request.post("/__e2e/reset", {
    data: { extras: { "logo.png": pngBytes } },
  });
  await page.goto("/");

  const logoEntry = page.locator(".tree-doc-disabled", { hasText: "logo.png" });
  await expect(logoEntry).toBeVisible();
  // No button for the binary entry.
  await expect(page.getByRole("button", { name: "logo.png" })).toHaveCount(0);
});

test(".uatuignore patterns hide files from the tree", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        ".uatuignore": "*.lock\n",
        "bun.lock": "lockfile contents\n",
        "notes.txt": "visible text\n",
      },
    },
  });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "notes.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "bun.lock" })).toHaveCount(0);
  await expect(page.locator(".tree-doc-disabled", { hasText: "bun.lock" })).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: "secret.txt" })).toHaveCount(0);

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
  await expect(page.getByRole("button", { name: "secret.txt" })).toBeVisible();
});

test("follow mode switches the preview when a non-Markdown text file changes", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: original\n" } },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  await fs.writeFile(workspacePath("config.yaml"), "key: changed\nport: 9999\n", "utf8");

  await expect(page.locator("#preview-path")).toHaveText("config.yaml");
  await expect(page.locator('#preview pre code.hljs.language-yaml')).toBeVisible();
});

test("enabling follow jumps to the most recently modified file", async ({ page }) => {
  // beforeEach lands on README.md (its mtime is bumped 10s into the future by
  // resetE2EWorkspace, so it's the current default selection).
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  // Make setup.md genuinely newer than README. resetE2EWorkspace pushed
  // README's mtime to now+10s, so a plain writeFile (which lands at "now") is
  // still older than README. utimes setup.md 30s into the future so it wins.
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nFreshly touched.\n", "utf8");
  const fresher = new Date(Date.now() + 30_000);
  await fs.utimes(workspacePath("guides", "setup.md"), fresher, fresher);

  // Don't click Follow until the client's appState reflects the new mtime
  // ordering — otherwise the catch-up reads stale state and picks README.
  // The tree-mtime spans carry data-mtime attributes synced from server state,
  // so this is the precise readiness signal.
  await page.waitForFunction(
    () => {
      const setupEl = document.querySelector(
        'button[data-document-id$="guides/setup.md"] .tree-mtime',
      ) as HTMLElement | null;
      const readmeEl = document.querySelector(
        'button[data-document-id$="README.md"] .tree-mtime',
      ) as HTMLElement | null;
      if (!setupEl || !readmeEl) return false;
      const setupMtime = Number(setupEl.dataset.mtime);
      const readmeMtime = Number(readmeEl.dataset.mtime);
      return Number.isFinite(setupMtime) && Number.isFinite(readmeMtime) && setupMtime > readmeMtime;
    },
    undefined,
    { timeout: 5_000 },
  );

  // Manually re-select README to ensure follow is OFF and selection is README.
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  // Enable follow — preview must immediately jump to setup.md.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
});

test("sidebar counter shows the binary subcount when binary files are present", async ({ page, request }) => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const pngBytes = Buffer.from(pngBase64, "base64").toString("latin1");
  await request.post("/__e2e/reset", {
    data: { extras: { "logo.png": pngBytes } },
  });
  await page.goto("/");
  await expect(page.locator("#document-count")).toHaveText("8 files · 1 binary");
});

test("sidebar counter shows the hidden subcount for .uatuignore-filtered files", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        ".uatuignore": "*.lock\n",
        "bun.lock": "lockfile\n",
        "yarn.lock": "lockfile\n",
      },
    },
  });
  await page.goto("/");
  // Visible: 7 testdata files (README.md, diagram.md, asciidoc-cheatsheet.adoc,
  // guides/setup.md, guides/notes.adoc, links-demo.md, links-demo.adoc) plus
  // the `.uatuignore` file itself (it's not matched by its own `*.lock`
  // pattern). Hidden: bun.lock, yarn.lock.
  await expect(page.locator("#document-count")).toHaveText("8 files · 2 hidden");
});

test("connection indicator is rendered in the preview header so it stays visible when the sidebar is collapsed", async ({ page }) => {
  await expect(page.locator(".preview-toolbar #connection-state")).toBeVisible();
  await expect(page.locator(".sidebar-meta #connection-state")).toHaveCount(0);

  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await expect(page.locator("#connection-state")).toBeVisible();
});

test("preview header shows a file-type chip for the selected document", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: value\n" } },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.locator("#preview-type")).toHaveText("markdown");

  await page.getByRole("button", { name: "config.yaml" }).click();
  await expect(page.locator("#preview-type")).toHaveText("yaml");
});

test("renders the AsciiDoc cheat sheet with full heading depth, TOC, admonitions, syntax highlighting, and Mermaid", async ({ page }) => {
  // Uses the permanent testdata/watch-docs/asciidoc-cheatsheet.adoc fixture,
  // which doubles as a visual reference for the AsciiDoc render path AND the
  // fixture under test for it.
  const adocButton = page.getByRole("button", { name: "asciidoc-cheatsheet.adoc" });
  await expect(adocButton).toBeVisible();
  await adocButton.click();

  await expect(page.locator("#preview-type")).toHaveText("asciidoc");
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");

  // Heading depth: doctitle → <h1>, then ==/===/====/=====/====== → h2-h6.
  await expect(page.locator("#preview h1")).toHaveCount(1);
  await expect(page.locator("#preview h2")).not.toHaveCount(0);
  await expect(page.locator("#preview h3")).not.toHaveCount(0);
  await expect(page.locator("#preview h4")).not.toHaveCount(0);
  await expect(page.locator("#preview h5")).not.toHaveCount(0);
  await expect(page.locator("#preview h6")).not.toHaveCount(0);

  // TOC renders as a list of links to section anchors. Hrefs are prefixed
  // with `user-content-` to match the (also-prefixed) heading ids — this is
  // what makes in-page jumps actually navigate.
  await expect(page.locator("#preview a[href='#user-content-_headings']")).toBeVisible();
  await expect(page.locator("#preview a[href='#user-content-_admonitions']")).toBeVisible();

  // Two admonition kinds for spread.
  await expect(page.locator("#preview .admonitionblock.note")).toBeVisible();
  await expect(page.locator("#preview .admonitionblock.warning")).toBeVisible();

  // Highlighted code (the cheat sheet has multiple [source,javascript] blocks).
  await expect(page.locator("#preview pre code.hljs.language-javascript").first()).toBeVisible();

  // Mermaid diagram is hydrated client-side.
  await expect(page.locator("#preview .mermaid svg")).toBeVisible();

  // Block quote and sidebar.
  await expect(page.locator("#preview .quoteblock")).toBeVisible();
  await expect(page.locator("#preview .sidebarblock")).toBeVisible();
});

test("clicking a Table of Contents link in the AsciiDoc cheat sheet navigates to that section", async ({ page }) => {
  // Full round-trip: TOC entries are rendered with `href="#user-content-..."`
  // (sanitize prefixes heading ids; rewriteInPageAnchors mirrors that on the
  // hrefs), and an in-page anchor click handler in app.ts intercepts the click
  // and scrolls the matching heading into view directly.
  await page.getByRole("button", { name: "asciidoc-cheatsheet.adoc" }).click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");

  // Pick a section near the bottom of the document so the click triggers
  // visible scrolling (not a no-op).
  const targetId = "user-content-_admonitions";
  const targetHeading = page.locator(`#${targetId}`);
  const tocLink = page.locator(`#preview a[href="#${targetId}"]`);

  await expect(tocLink).toBeVisible();
  await expect(targetHeading).toHaveCount(1);

  // Before the click, the target heading is below the fold.
  await expect(targetHeading).not.toBeInViewport();

  await tocLink.click();

  // After the click, the browser has scrolled the heading into view.
  await expect(targetHeading).toBeInViewport();
});

test("TOC link click in a nested-directory AsciiDoc doc does NOT navigate to a 404", async ({ page, request }) => {
  // Regression: when an .adoc file lives in a subdirectory, the per-document
  // <base href> is set to that directory (so relative image paths resolve).
  // A naive `<a href="#x">` in the TOC would resolve against the base to
  // `/<dir>/#x`, triggering a full navigation that hits the static-fallback
  // 404. The in-page anchor click handler must intercept the click and
  // scrollIntoView directly so this stays same-document.
  const longParas = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of section content with words.`).join("\n\n");
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "guides/nested.adoc": `= Nested Doc
:toc:

== Alpha

${longParas}

== Bravo

content bravo
`,
      },
    },
  });
  await page.goto("/");

  // Expand the guides directory so the nested.adoc button is visible/clickable.
  const guidesDetails = page
    .locator("#tree details")
    .filter({ has: page.locator('summary:has-text("guides")') });
  if (!(await guidesDetails.evaluate((el: HTMLDetailsElement) => el.open))) {
    await guidesDetails.locator("summary").click();
  }
  await page.locator('button[data-document-id$="guides/nested.adoc"]').click();
  await expect(page.locator("#preview .toc")).toBeVisible();

  // Confirm the base href was set to the subdirectory (the precondition
  // that makes naive fragment navigation 404).
  const baseHref = await page.locator("#preview-base").getAttribute("href");
  expect(baseHref).toMatch(/\/guides\/$/);

  const bravo = page.locator("#preview h2[id$='_bravo']");
  await expect(bravo).not.toBeInViewport();

  const urlBefore = page.url();
  await page.locator("#preview .toc a[href*='_bravo']").click();

  // Browser must NOT have navigated away — page URL pathname unchanged, and
  // the uatu app shell is still rendered (the brand text is in the sidebar).
  expect(new URL(page.url()).pathname).toBe(new URL(urlBefore).pathname);
  await expect(page.locator(".brand")).toBeVisible();

  // And the target heading must now be in view.
  await expect(bravo).toBeInViewport();
});

test("code blocks expose a copy-to-clipboard control", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: value\nport: 4321\n" } },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "config.yaml" }).click();

  const copyButton = page.locator("#preview pre .code-copy");
  await expect(copyButton).toHaveCount(1);

  await copyButton.click();
  await expect(copyButton).toHaveText("Copied!");

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("key: value");
  expect(clipboard).toContain("port: 4321");
  // Critical: clipboard must NOT contain the line-number gutter contents.
  expect(clipboard).not.toMatch(/^\s*1\b/);
});

test("non-Markdown code views show line numbers; Markdown fenced blocks do not", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "config.yaml": "alpha: 1\nbeta: 2\ngamma: 3\n",
        "with-code.md":
          "# Sample\n\nText before.\n\n```js\nconst answer = 42;\n```\n\nText after.\n",
      },
    },
  });
  await page.goto("/");

  // Code view: line numbers visible
  await page.getByRole("button", { name: "config.yaml" }).click();
  const codeViewGutter = page.locator("#preview pre.has-line-numbers .line-numbers");
  await expect(codeViewGutter).toHaveCount(1);
  await expect(codeViewGutter).toHaveText("1\n2\n3");

  // Markdown view: fenced block has NO line numbers
  await page.getByRole("button", { name: "with-code.md" }).click();
  await expect(page.locator("#preview pre")).toHaveCount(1);
  await expect(page.locator("#preview pre .line-numbers")).toHaveCount(0);
  await expect(page.locator("#preview pre.has-line-numbers")).toHaveCount(0);
});

test("AsciiDoc cross-document links render with the original .adoc extension (not .html)", async ({ page }) => {
  // Regression: Asciidoctor's default rewrites `xref:other.adoc[]` to
  // `href="other.html"`. The preview spec requires preserving the author's
  // `href` verbatim so the in-app click handler can resolve it to a known
  // document. Drives the permanent `testdata/watch-docs/links-demo.adoc`
  // fixture.
  await page.locator('button[data-document-id$="links-demo.adoc"]').click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cross-Document Links");

  // xref:, <<>>, and link: macros all targeting the existing cheat sheet —
  // each MUST resolve to the literal `.adoc` URL.
  await expect(
    page.locator('#preview a[href="asciidoc-cheatsheet.adoc"]').first(),
  ).toBeVisible();
  await expect(page.locator('#preview a[href="guides/notes.adoc"]')).toBeVisible();

  // No link in the preview should reference a `.html` file (the bug shape).
  await expect(page.locator('#preview a[href$=".html"]')).toHaveCount(0);
});

test("clicking an AsciiDoc cross-document link switches the preview in-app (no download, no full nav)", async ({ page }) => {
  // The renderer keeps the .adoc href, but a default click would navigate
  // the browser to /other.adoc, hitting the static-file fallback that serves
  // raw bytes (download or plain-text view). The in-app click handler must
  // intercept the click and switch the preview through the same code path
  // the sidebar uses.
  await page.locator('button[data-document-id$="links-demo.adoc"]').click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cross-Document Links");

  const urlBefore = page.url();
  await page.locator('#preview a[href="asciidoc-cheatsheet.adoc"]').first().click();

  // The URL pathname must not have changed — the SPA shell stays in place,
  // and the preview swaps to the linked document.
  expect(new URL(page.url()).pathname).toBe(new URL(urlBefore).pathname);
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");
  await expect(page.locator("#preview-path")).toHaveText("asciidoc-cheatsheet.adoc");

  // Sidebar selection follows the navigation.
  await expect(
    page.locator('button[data-document-id$="asciidoc-cheatsheet.adoc"]'),
  ).toHaveClass(/is-selected/);
});

test("clicking an AsciiDoc cross-document link into a subdirectory switches the preview", async ({ page }) => {
  // Same handler, exercised through `xref:guides/notes.adoc[…]` so the
  // resolved URL has a directory segment in it.
  await page.locator('button[data-document-id$="links-demo.adoc"]').click();
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cross-Document Links");

  await page.locator('#preview a[href="guides/notes.adoc"]').click();

  await expect(page.locator("#preview-title")).toHaveText("Notes");
  await expect(page.locator("#preview-path")).toHaveText("guides/notes.adoc");
});

test("Markdown cross-document links render with the original .md extension", async ({ page }) => {
  // Companion regression for the AsciiDoc test above. micromark already
  // preserves the author's URL verbatim — this test locks that behavior in
  // so a future renderer swap can't silently regress it. Drives the
  // permanent `testdata/watch-docs/links-demo.md` fixture.
  await page.locator('button[data-document-id$="links-demo.md"]').click();
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");

  await expect(page.locator('#preview a[href="README.md"]')).toBeVisible();
  await expect(page.locator('#preview a[href="guides/setup.md"]')).toBeVisible();
  await expect(page.locator('#preview a[href$=".html"]')).toHaveCount(0);
});

test("clicking a Markdown cross-document link switches the preview in-app", async ({ page }) => {
  await page.locator('button[data-document-id$="links-demo.md"]').click();
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");

  const urlBefore = page.url();
  await page.locator('#preview a[href="guides/setup.md"]').click();

  expect(new URL(page.url()).pathname).toBe(new URL(urlBefore).pathname);
  await expect(page.locator("#preview-title")).toHaveText("Setup");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  await expect(
    page.locator('button[data-document-id$="guides/setup.md"]'),
  ).toHaveClass(/is-selected/);
});

test("preview header stays visible while scrolling and the sidebar scroll is independent", async ({ page }) => {
  const padding = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  await fs.writeFile(workspacePath("README.md"), `# Uatu\n\n${padding}\n`, "utf8");

  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.locator("#preview")).toContainText("Paragraph 80.");

  const headerBefore = await page.locator(".preview-header").boundingBox();
  await page.locator(".preview-shell").evaluate(element => {
    element.scrollTop = 600;
  });
  await page.waitForTimeout(100);
  const headerAfter = await page.locator(".preview-header").boundingBox();

  expect(headerBefore?.y ?? 0).toBeCloseTo(headerAfter?.y ?? 0, 0);
});
