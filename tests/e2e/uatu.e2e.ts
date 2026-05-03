import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "../../src/e2e";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Online");
  await expect(page.locator("#document-count")).toHaveText("8 files");
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

function sidebarPanesFitVisibleHeight(page: Page): () => Promise<boolean> {
  return async () =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".sidebar-body");
      const panes = Array.from(document.querySelectorAll<HTMLElement>(".sidebar-pane:not([hidden])"));
      if (!body || panes.length === 0) {
        return false;
      }
      const bodyBox = body.getBoundingClientRect();
      const lastPaneBox = panes.at(-1)?.getBoundingClientRect();
      return Boolean(lastPaneBox && lastPaneBox.bottom <= bodyBox.bottom + 1);
    });
}


test("renders GFM content and Mermaid diagrams", async ({ page }) => {
  await page.getByRole("button", { name: "diagram.md" }).click();

  await expect(page.locator("#preview-title")).toHaveText("Diagram Fixture");
  await expect(page.locator("#preview table")).toBeVisible();
  await expect(page.locator('#preview input[type="checkbox"]')).toHaveCount(2);
  await expect(page.locator('#preview a[href="https://example.com"]')).toBeVisible();
  await expect(page.locator("#preview .mermaid svg")).toBeVisible();
});

test("inline Mermaid diagrams render within the preview width and are centered", async ({
  page,
}) => {
  // We honor Mermaid's intended sizing — each diagram renders at the width
  // the library chose, capped to the preview content width if larger. This
  // test guards two invariants: (a) no horizontal overflow, (b) the trigger
  // is horizontally centered within the preview column.
  await page.getByRole("button", { name: "diagram.md" }).click();
  const trigger = page.locator("#preview .mermaid-trigger");
  await expect(trigger).toBeVisible();

  const layout = await page.evaluate(() => {
    const triggerEl = document.querySelector<HTMLElement>("#preview .mermaid-trigger");
    const previewEl = document.querySelector<HTMLElement>("#preview");
    if (!triggerEl || !previewEl) return null;
    const tr = triggerEl.getBoundingClientRect();
    const pr = previewEl.getBoundingClientRect();
    const previewStyle = getComputedStyle(previewEl);
    const padL = Number.parseFloat(previewStyle.paddingLeft);
    const padR = Number.parseFloat(previewStyle.paddingRight);
    const contentLeft = pr.left + padL;
    const contentRight = pr.right - padR;
    const contentCenter = (contentLeft + contentRight) / 2;
    const triggerCenter = tr.left + tr.width / 2;
    return {
      triggerWidth: tr.width,
      contentWidth: contentRight - contentLeft,
      centerOffset: Math.abs(triggerCenter - contentCenter),
    };
  });

  expect(layout).not.toBeNull();
  // No horizontal overflow.
  expect(layout!.triggerWidth).toBeLessThanOrEqual(layout!.contentWidth + 1);
  // Trigger center within ~4px of preview content center.
  expect(layout!.centerOffset).toBeLessThan(4);
});

test("clicking a Mermaid diagram opens the fullscreen viewer with a cloned svg", async ({ page }) => {
  await page.getByRole("button", { name: "diagram.md" }).click();
  const trigger = page.locator("#preview .mermaid-trigger");
  await expect(trigger).toBeVisible();

  await trigger.click();

  await expect(page.locator("dialog.mermaid-viewer")).toHaveAttribute("open", "");
  await expect(page.locator("dialog.mermaid-viewer .mermaid-viewer-stage svg")).toBeVisible();
  // Toolbar exposes the documented controls.
  await expect(page.locator(".mermaid-viewer-toolbar [aria-label='Zoom in']")).toBeVisible();
  await expect(page.locator(".mermaid-viewer-toolbar [aria-label='Zoom out']")).toBeVisible();
  await expect(page.locator(".mermaid-viewer-toolbar [aria-label='Fit to screen']")).toBeVisible();
});

test("Escape closes the diagram viewer and returns focus to the trigger", async ({ page }) => {
  await page.getByRole("button", { name: "diagram.md" }).click();
  const trigger = page.locator("#preview .mermaid-trigger");
  await trigger.click();
  const dialog = page.locator("dialog.mermaid-viewer");
  await expect(dialog).toHaveAttribute("open", "");

  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");

  const focusedClass = await page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.className ?? "",
  );
  expect(focusedClass).toContain("mermaid-trigger");
});

test("the diagram viewer fills the entire browser canvas", async ({ page }) => {
  await page.getByRole("button", { name: "diagram.md" }).click();
  await page.locator("#preview .mermaid-trigger").click();
  const dialog = page.locator("dialog.mermaid-viewer");
  await expect(dialog).toHaveAttribute("open", "");

  const dimensions = await page.evaluate(() => {
    const dlg = document.querySelector<HTMLElement>("dialog.mermaid-viewer");
    if (!dlg) return null;
    const rect = dlg.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    };
  });

  expect(dimensions).not.toBeNull();
  // Modal fills the full viewport (within sub-pixel tolerance).
  expect(dimensions!.width).toBeCloseTo(dimensions!.windowWidth, 0);
  expect(dimensions!.height).toBeCloseTo(dimensions!.windowHeight, 0);
});

test("wheel scrolling inside the diagram viewer changes the stage transform", async ({ page }) => {
  await page.getByRole("button", { name: "diagram.md" }).click();
  await page.locator("#preview .mermaid-trigger").click();
  await expect(page.locator("dialog.mermaid-viewer")).toHaveAttribute("open", "");

  // Allow the initial fit-to-screen RAF to run and settle.
  await page.waitForTimeout(50);
  const stage = page.locator(".mermaid-viewer-stage");
  const before = await stage.evaluate(el => (el as HTMLElement).style.transform);

  const viewport = page.locator(".mermaid-viewer-viewport");
  const box = await viewport.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
  await page.mouse.wheel(0, -300);

  await expect
    .poll(async () => stage.evaluate(el => (el as HTMLElement).style.transform))
    .not.toBe(before);
});

test("editing the watched file while the diagram viewer is open closes the viewer", async ({ page }) => {
  await page.getByRole("button", { name: "diagram.md" }).click();
  await page.locator("#preview .mermaid-trigger").click();
  const dialog = page.locator("dialog.mermaid-viewer");
  await expect(dialog).toHaveAttribute("open", "");

  await fs.writeFile(
    workspacePath("diagram.md"),
    "# Diagram Fixture\n\nText only — no diagram here.\n",
    "utf8",
  );

  await expect(dialog).not.toHaveAttribute("open", "");
});

test("each Mermaid shape (flowchart, sequence, C4, wide, component-interaction) renders an inline SVG", async ({ page }) => {
  await page.getByRole("button", { name: "mermaid-shapes.md" }).click();
  await expect(page.locator("#preview-title")).toHaveText("Mermaid Shapes");

  // Wait until all five diagrams have rendered (Mermaid hydration is async).
  await expect.poll(async () => page.locator("#preview .mermaid svg").count()).toBe(5);

  // Each diagram must end up wrapped in a trigger button, so all five are openable.
  await expect(page.locator("#preview .mermaid-trigger")).toHaveCount(5);
});

test("inline diagrams render at Mermaid's intended size and never overflow the preview", async ({
  page,
}) => {
  // The "honor Mermaid" contract: each rendered SVG's width matches
  // min(Mermaid's intended width, preview content width). The intended width
  // is exposed by Mermaid as the `width="W"` attribute on the emitted SVG —
  // we keep that attribute (it gives the SVG an explicit intrinsic size)
  // and CSS `max-width: 100%` caps it on narrow containers.
  //
  // This test is the real regression for the "tiny diagrams" bug: stripping
  // the `width` attribute caused the SVG to fall back to ~300x150 and the
  // inline-block trigger to shrink with it, so every diagram rendered
  // microscopic. The earlier "no overflow + centered" assertions passed
  // happily at any non-zero width — this one fails fast if rendered width
  // doesn't match the library's intent.
  await page.getByRole("button", { name: "mermaid-shapes.md" }).click();
  await expect.poll(async () => page.locator("#preview .mermaid svg").count()).toBe(5);

  const sizes = await page.evaluate(() => {
    const previewEl = document.querySelector<HTMLElement>("#preview");
    const svgs = Array.from(document.querySelectorAll<SVGElement>("#preview .mermaid svg"));
    if (!previewEl) return null;
    const previewStyle = getComputedStyle(previewEl);
    const contentWidth =
      previewEl.clientWidth -
      Number.parseFloat(previewStyle.paddingLeft) -
      Number.parseFloat(previewStyle.paddingRight);
    return {
      contentWidth,
      diagrams: svgs.map(svg => {
        const intendedAttr = svg.getAttribute("width");
        const intended = intendedAttr ? Number.parseFloat(intendedAttr) : Number.NaN;
        return {
          intended,
          rendered: svg.getBoundingClientRect().width,
        };
      }),
    };
  });

  expect(sizes).not.toBeNull();
  expect(sizes!.diagrams.length).toBe(5);
  for (const { intended, rendered } of sizes!.diagrams) {
    expect(Number.isFinite(intended)).toBe(true);
    expect(intended).toBeGreaterThan(0);
    // Rendered width matches min(intended, container) within a small
    // sub-pixel rounding tolerance. This is the real "honor Mermaid"
    // assertion — the previous bug (width="100%" attribute, 300px UA
    // fallback) made every rendered width ~300 regardless of intended
    // size, so this check fails fast when that regresses.
    const expected = Math.min(intended, sizes!.contentWidth);
    expect(Math.abs(rendered - expected)).toBeLessThan(2);
  }
});

test("the diagram viewer preserves Mermaid's internal id references after cloning", async ({
  page,
}) => {
  // Regression for the all-black-fills bug: the modal cloned the SVG and
  // stripped every id, which broke `url(#someGradient)`, `<use href="#x">`,
  // arrowhead markers, and clipPaths. The clone must keep references intact
  // by remapping ids, not removing them.
  await page.getByRole("button", { name: "mermaid-shapes.md" }).click();
  await expect.poll(async () => page.locator("#preview .mermaid svg").count()).toBe(5);

  // Use the C4 diagram (third) since it relies most heavily on internal
  // references (markers, gradients, arrowheads).
  await page.locator("#preview .mermaid-trigger").nth(2).click();
  await expect(page.locator("dialog.mermaid-viewer")).toHaveAttribute("open", "");

  const refsResolve = await page.evaluate(() => {
    const svg = document.querySelector<SVGElement>("dialog.mermaid-viewer .mermaid-viewer-stage svg");
    if (!svg) return null;
    const ids = new Set<string>();
    for (const el of svg.querySelectorAll<Element>("[id]")) {
      const id = el.getAttribute("id");
      if (id) ids.add(id);
    }
    const refs: string[] = [];
    const collectFrom = (el: Element) => {
      for (const attr of Array.from(el.attributes)) {
        const m = attr.value.match(/url\(#([^)]+)\)/);
        if (m) refs.push(m[1]);
        if ((attr.name === "href" || attr.localName === "href") && attr.value.startsWith("#")) {
          refs.push(attr.value.slice(1));
        }
      }
    };
    collectFrom(svg);
    for (const el of svg.querySelectorAll("*")) collectFrom(el);
    return { totalRefs: refs.length, unresolved: refs.filter(r => !ids.has(r)) };
  });

  expect(refsResolve).not.toBeNull();
  // Every internal `url(#x)` and `href="#x"` reference resolves inside the clone.
  expect(refsResolve!.unresolved).toEqual([]);
});

test("the diagram viewer's cloned SVG keeps Mermaid's themed fills (not all black)", async ({
  page,
}) => {
  // Regression for the second wave of all-black-fills bugs: id remapping fixed
  // attribute references but Mermaid also embeds a `<style>` block scoped by
  // the SVG root id (e.g. `#mermaid-12345 .node rect { fill: #ECECFF; }`).
  // If those selectors are not rewritten alongside the id, the cloned SVG
  // renders with default fills (the boxes look solid black). This test
  // exercises every shape in the fixture so flowchart, sequence, C4, wide,
  // and component-interaction are all covered.
  await page.getByRole("button", { name: "mermaid-shapes.md" }).click();
  await expect.poll(async () => page.locator("#preview .mermaid svg").count()).toBe(5);

  const triggers = page.locator("#preview .mermaid-trigger");
  for (let i = 0; i < 5; i += 1) {
    await triggers.nth(i).click();
    const dialog = page.locator("dialog.mermaid-viewer");
    await expect(dialog).toHaveAttribute("open", "");

    const fills = await page.evaluate(() => {
      const svg = document.querySelector<SVGElement>(
        "dialog.mermaid-viewer .mermaid-viewer-stage svg",
      );
      if (!svg) return null;
      // Check every element's computed fill — at least one rect, polygon,
      // or path should be a recognizable, non-black, non-transparent fill.
      const shapes = Array.from(svg.querySelectorAll<SVGElement>("rect, polygon, path"));
      const themed = shapes.filter(el => {
        const fill = getComputedStyle(el).fill;
        if (!fill || fill === "none") return false;
        // rgb(0, 0, 0) signals broken styles; the default Mermaid theme uses
        // light, non-black fills throughout.
        return fill !== "rgb(0, 0, 0)" && fill !== "rgba(0, 0, 0, 1)";
      });
      return { totalShapes: shapes.length, themedShapes: themed.length };
    });

    expect(fills).not.toBeNull();
    expect(fills!.totalShapes).toBeGreaterThan(0);
    // At least 30% of shapes carry a non-black themed fill — generous bound
    // because some shapes (arrows, lines) are legitimately black/none.
    expect(fills!.themedShapes / fills!.totalShapes).toBeGreaterThan(0.3);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toHaveAttribute("open", "");
  }
});

test("the diagram viewer centers the diagram inside the modal viewport", async ({ page }) => {
  // Regression for the off-position bug: the viewport used to flex-center
  // the stage, and `fit()` then *also* added a center-offset translate.
  // The two composed and pushed non-square shapes off-screen. Exercises every
  // shape in the fixture (flowchart, sequence, C4, wide, component-interaction).
  await page.getByRole("button", { name: "mermaid-shapes.md" }).click();
  await expect.poll(async () => page.locator("#preview .mermaid svg").count()).toBe(5);

  const triggers = page.locator("#preview .mermaid-trigger");
  for (let i = 0; i < 5; i += 1) {
    await triggers.nth(i).click();
    await expect(page.locator("dialog.mermaid-viewer")).toHaveAttribute("open", "");
    // Allow the deferred fit to settle.
    await page.waitForTimeout(80);

    const offset = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".mermaid-viewer-stage");
      const viewport = document.querySelector<HTMLElement>(".mermaid-viewer-viewport");
      if (!stage || !viewport) return null;
      const sb = stage.getBoundingClientRect();
      const vb = viewport.getBoundingClientRect();
      const stageCenterX = sb.left + sb.width / 2;
      const stageCenterY = sb.top + sb.height / 2;
      const viewportCenterX = vb.left + vb.width / 2;
      const viewportCenterY = vb.top + vb.height / 2;
      return {
        dx: Math.abs(stageCenterX - viewportCenterX),
        dy: Math.abs(stageCenterY - viewportCenterY),
        viewportWidth: vb.width,
        viewportHeight: vb.height,
      };
    });

    expect(offset).not.toBeNull();
    // Stage center should be within ~20px of viewport center.
    expect(offset!.dx).toBeLessThan(20);
    expect(offset!.dy).toBeLessThan(20);
    // And the stage must be inside (not off-screen): center within the viewport.
    expect(offset!.dx).toBeLessThan(offset!.viewportWidth / 2);
    expect(offset!.dy).toBeLessThan(offset!.viewportHeight / 2);

    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.mermaid-viewer")).not.toHaveAttribute("open", "");
  }
});

test("the diagram viewer scales the diagram to a meaningful fraction of the modal", async ({
  page,
}) => {
  // Regression for the diagram-tiny-in-modal bug: stripping width/height
  // from the inline SVG made the cloned SVG render at default 300x150, and
  // the inline-block stage shrank with it. Restoring viewBox-based dimensions
  // and centering after fit() must produce a stage box that fills most of
  // the modal viewport.
  await page.getByRole("button", { name: "mermaid-shapes.md" }).click();
  await expect.poll(async () => page.locator("#preview .mermaid svg").count()).toBe(5);

  await page.locator("#preview .mermaid-trigger").first().click();
  await expect(page.locator("dialog.mermaid-viewer")).toHaveAttribute("open", "");

  // Allow the deferred fit-to-viewport (RAF) to settle.
  await page.waitForTimeout(100);

  const ratios = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".mermaid-viewer-stage");
    const viewport = document.querySelector<HTMLElement>(".mermaid-viewer-viewport");
    if (!stage || !viewport) return null;
    const stageBox = stage.getBoundingClientRect();
    const viewportBox = viewport.getBoundingClientRect();
    return {
      stageArea: stageBox.width * stageBox.height,
      viewportArea: viewportBox.width * viewportBox.height,
      stageWidth: stageBox.width,
      stageHeight: stageBox.height,
    };
  });

  expect(ratios).not.toBeNull();
  // Stage occupies a meaningful chunk of the modal viewport — the fit math
  // is working. We use a generous 15% lower bound to allow for narrow-tall
  // and wide-short shapes whose fit area is naturally smaller than the viewport.
  const occupancy = ratios!.stageArea / ratios!.viewportArea;
  expect(occupancy).toBeGreaterThan(0.15);
  // Stage isn't the default 300x150 fallback either way.
  expect(ratios!.stageWidth).toBeGreaterThan(200);
  expect(ratios!.stageHeight).toBeGreaterThan(100);
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

test("Author Mode sidebar shows Change Overview and Files only; Review Mode adds Git Log", async ({ page }) => {
  // Default Mode is Author — Git Log is intentionally hidden because past
  // commits aren't an Author concern.
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeVisible();
  await expect(page.locator('[data-pane-id="files"]')).toBeVisible();
  await expect(page.locator('[data-pane-id="git-log"]')).toBeHidden();
  await expect(page.locator('[data-pane-id="files"] #tree')).toBeVisible();
  await expect.poll(sidebarPanesFitVisibleHeight(page)).toBe(true);
  await expect(page.locator(".sidebar-body")).toHaveCSS("overflow-y", "hidden");

  await page.locator('[data-pane-id="files"]').getByRole("button", { name: "diagram.md" }).click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");

  // Switch to Review — Git Log should appear, with Files getting the spare height.
  await page.locator("#mode-review").click();
  await expect(page.locator('[data-pane-id="git-log"]')).toBeVisible();
  const filesHeight = (await page.locator('[data-pane-id="files"]').boundingBox())?.height ?? 0;
  const gitLogHeight = (await page.locator('[data-pane-id="git-log"]').boundingBox())?.height ?? 0;
  expect(filesHeight).toBeGreaterThan(gitLogHeight);
});

test("sidebar panes can be hidden, restored, resized, and survive whole-sidebar collapse", async ({ page }) => {
  const overviewPane = page.locator('[data-pane-id="change-overview"]');
  await expect(overviewPane).toBeVisible();

  await overviewPane.getByRole("button", { name: "Hide Change Overview" }).click();
  await expect(overviewPane).toBeHidden();

  await page.locator("#panels-toggle").click();
  await page.locator('#panels-menu label:has-text("Change Overview") input').check();
  await expect(overviewPane).toBeVisible();

  const before = (await overviewPane.boundingBox())?.height ?? 0;
  const resizer = page.locator('[data-pane-resizer="change-overview"]');
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move((box?.x ?? 0) + 4, (box?.y ?? 0) + 3);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + 4, (box?.y ?? 0) + 45);
  await page.mouse.up();
  const after = (await overviewPane.boundingBox())?.height ?? 0;
  expect(after).toBeGreaterThan(before + 20);
  await expect.poll(sidebarPanesFitVisibleHeight(page)).toBe(true);

  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await page.locator("#sidebar-expand").click();
  await expect(overviewPane).toBeVisible();

  const sidebarBefore = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  const sidebarResizerBox = await page.locator("#sidebar-resizer").boundingBox();
  expect(sidebarResizerBox).not.toBeNull();
  await page.mouse.move((sidebarResizerBox?.x ?? 0) + 3, (sidebarResizerBox?.y ?? 0) + 20);
  await page.mouse.down();
  await page.mouse.move((sidebarResizerBox?.x ?? 0) + 85, (sidebarResizerBox?.y ?? 0) + 20);
  await page.mouse.up();
  const sidebarAfter = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  expect(sidebarAfter).toBeGreaterThan(sidebarBefore + 50);

  await page.reload();
  await expect(overviewPane).toBeVisible();
  const reloaded = (await overviewPane.boundingBox())?.height ?? 0;
  expect(reloaded).toBeGreaterThan(before + 20);
  const sidebarReloaded = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  expect(sidebarReloaded).toBeGreaterThan(sidebarBefore + 50);
});

test("Change Overview and Git Log render git-backed review load with configured explanations", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      // Git Log is a Review-mode pane; boot in Review so this test can assert
      // against it.
      startupMode: "review",
      uatuConfig: {
        review: {
          baseRef: "main",
          thresholds: { medium: 8, high: 20 },
          riskAreas: [{ label: "Auth", paths: ["src/auth/**"], score: 12, perFile: 1, max: 20 }],
          supportAreas: [{ label: "Docs", paths: ["**/*.md"], score: -2, maxDiscount: 4 }],
          ignoreAreas: [{ label: "Generated", paths: ["dist/**"] }],
        },
      },
      dirty: {
        "src/auth/session.ts": "export const changed = true;\n",
        "dist/generated.js": "generated\n",
      },
    },
  });
  await page.goto("/");

  const overview = page.locator("#change-overview");
  await expect(overview).toContainText("feature/review-load");
  await expect(overview).toContainText("configured base");
  // Test boots in Review (so Git Log assertions work), so the headline reads
  // "Change review burden" rather than the Author-mode forecast label.
  await expect(overview).toContainText("Change review burden");
  await expect(overview).toContainText("Auth");
  await expect(overview).toContainText("Generated");
  await expect(overview).toContainText("src/auth/session.ts");
  await expect(overview).not.toContainText("Changed files");
  await expect(overview).not.toContainText("Touched lines");
  await expect(overview).not.toContainText("Diff hunks");
  await expect(overview).not.toContainText("Directory spread");

  await overview.locator("button[title='Show score explanation']").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => new URL(page.url()).searchParams.has("reviewScore")).toBe(true);
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");
  await expect(page.locator("#preview")).toContainText("additive review-burden index");
  await expect(page.locator("#preview")).toContainText("Mechanical Statistics");
  await expect(page.locator("#preview")).toContainText("Changed files");
  await expect(page.locator("#preview h2", { hasText: "Changed Files" })).toHaveCount(0);
  await expect(page.locator("#preview")).toContainText("High");
  await expect(page.locator(".score-preview-total")).toHaveCSS("background-color", "rgb(255, 241, 240)");
  await expect(page.locator(".score-preview dl .is-low")).toHaveCSS("background-color", "rgb(239, 250, 242)");
  await expect(page.locator(".score-preview dl .is-medium")).toHaveCSS("background-color", "rgb(255, 248, 220)");
  await expect(page.locator(".score-preview dl .is-high")).toHaveCSS("background-color", "rgb(255, 241, 240)");
  await expect(page.locator("#preview")).not.toContainText("Commits");
  const diffHunksHelp = page.locator(".score-term-help", { hasText: "?" }).filter({ has: page.locator(".score-term-tooltip", { hasText: "separate changed spots" }) });
  await diffHunksHelp.hover();
  await expect(diffHunksHelp.locator(".score-term-tooltip")).toBeVisible();
  const directorySpreadHelp = page.locator(".score-term-help", { has: page.locator(".score-term-tooltip", { hasText: "top-level parts of the project" }) });
  await directorySpreadHelp.hover();
  await expect(directorySpreadHelp.locator(".score-term-tooltip")).toBeVisible();
  const scoreUrl = page.url();
  await page.reload();
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");
  expect(page.url()).toBe(scoreUrl);
  await fs.writeFile(workspacePath("README.md"), "# Uatu\n\nScore view should stay open.\n", "utf8");
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");
  await expect.poll(() => new URL(page.url()).searchParams.has("reviewScore")).toBe(true);

  const gitLog = page.locator("#git-log");
  await expect(gitLog).toContainText("add feature doc");
  await expect(gitLog.locator(".commit-log code").first()).toHaveText(/[0-9a-f]{7,12}/);
  await expect(page.locator("#git-log-limit")).toHaveValue("25");
  await page.locator("#git-log-limit").selectOption("10");
  await expect(gitLog.locator(".commit-log a")).toHaveCount(10);
  await expect(gitLog).toHaveCSS("overflow-y", "auto");

  const featureCommit = gitLog.locator(".commit-log a", { hasText: "add feature doc" });
  await page.locator("#git-log-limit").selectOption("25");
  await expect(featureCommit).toHaveAttribute("href", /^\/\?repository=.+&commit=[0-9a-f]{7,12}$/);
  await featureCommit.click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => new URL(page.url()).searchParams.has("commit")).toBe(true);
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#preview")).toContainText("Full commit message body for review-load hover.");
});

test("Git Log commit links support URL history and reloads", async ({ page, request }) => {
  // Git Log lives in the Review-mode pane catalog only.
  await request.post("/__e2e/reset", { data: { git: true, startupMode: "review" } });
  await page.goto("/");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  const gitLog = page.locator("#git-log");
  await expect(gitLog).toContainText("add feature doc");
  const featureCommit = gitLog.locator(".commit-log a", { hasText: "add feature doc" });
  await expect(featureCommit).toHaveAttribute("href", /^\/\?repository=.+&commit=[0-9a-f]{7,12}$/);

  await featureCommit.click();
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#preview")).toContainText("Full commit message body for review-load hover.");
  await expect(page.locator("#tree .tree-doc-button.is-selected")).toHaveCount(0);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  const commitUrl = new URL(page.url());
  expect(commitUrl.pathname).toBe("/");
  expect(commitUrl.searchParams.get("repository")).toBeTruthy();
  expect(commitUrl.searchParams.get("commit")).toMatch(/^[0-9a-f]{7,12}$/);

  await page.goBack();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator('button[data-document-id$="README.md"]')).toHaveClass(/is-selected/);

  // Follow is unavailable in Review (where Git Log lives) — that assertion
  // belongs in the Mode tests.

  await page.goForward();
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#tree .tree-doc-button.is-selected")).toHaveCount(0);
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#preview")).toContainText("Full commit message body for review-load hover.");
  expect(page.url()).toBe(commitUrl.toString());

  await page.goto(`${commitUrl.pathname}${commitUrl.search}`);
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#preview")).toContainText("Full commit message body for review-load hover.");
});

test("commit preview URLs show an unavailable state when data is missing", async ({ page, request }) => {
  // Git Log assertion only meaningful in Review.
  await request.post("/__e2e/reset", { data: { git: true, startupMode: "review" } });
  await page.goto("/?repository=missing-repo&commit=deadbeef");

  await expect(page.locator("#preview-title")).toHaveText("Commit preview unavailable");
  await expect(page.locator("#preview-path")).toContainText("Repository data is not available for commit deadbeef.");
  await expect(page.locator("#preview")).toHaveClass(/empty/);
  await expect(page.locator("#git-log")).toContainText("add feature doc");
});

test("Change Overview displays non-git and invalid settings fallback states", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { nonGit: true } });
  await page.goto("/");
  await expect(page.locator("#change-overview")).toContainText("No git repository is available");

  await request.post("/__e2e/reset", {
    data: {
      git: true,
      extras: { ".uatu.json": "{ nope" },
      dirty: { "README.md": "# Changed\n" },
    },
  });
  await page.goto("/");
  await expect(page.locator("#change-overview")).toContainText("Invalid .uatu.json");
  await expect(page.locator("#change-overview")).toContainText("Reviewer burden forecast");
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
  await expect(page.locator("#document-count")).toHaveText("9 files");

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
  await expect(page.locator("#document-count")).toHaveText("9 files · 1 binary");
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
  // Visible: 8 testdata files (README.md, diagram.md, mermaid-shapes.md,
  // asciidoc-cheatsheet.adoc, guides/setup.md, guides/notes.adoc,
  // links-demo.md, links-demo.adoc) plus the `.uatuignore` file itself (it
  // is not matched by its own `*.lock` pattern). Hidden: bun.lock, yarn.lock.
  await expect(page.locator("#document-count")).toHaveText("9 files · 2 hidden");
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

  await page.locator('#preview a[href="asciidoc-cheatsheet.adoc"]').first().click();

  // The browser stays inside the SPA — preview swaps and the sidebar
  // selection follows. The URL pathname now mirrors the active document
  // (history-tracking behavior added in the direct-links change).
  await expect(page.locator("#preview-title")).toHaveText("AsciiDoc Cheat Sheet");
  await expect(page.locator("#preview-path")).toHaveText("asciidoc-cheatsheet.adoc");
  expect(new URL(page.url()).pathname).toBe("/asciidoc-cheatsheet.adoc");

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

  await page.locator('#preview a[href="guides/setup.md"]').click();

  await expect(page.locator("#preview-title")).toHaveText("Setup");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  expect(new URL(page.url()).pathname).toBe("/guides/setup.md");
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
    page.locator('button[data-document-id$="guides/setup.md"]'),
  ).toHaveClass(/is-selected/);
});

test("in-app cross-doc clicks push history; back restores the previous document", async ({ page }) => {
  // Start on the markdown links demo and click into another doc.
  await page.locator('button[data-document-id$="links-demo.md"]').click();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");

  await page.locator('#preview a[href="guides/setup.md"]').click();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  expect(new URL(page.url()).pathname).toBe("/guides/setup.md");

  await page.goBack();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");
  expect(new URL(page.url()).pathname).toBe("/links-demo.md");
  await expect(
    page.locator('button[data-document-id$="links-demo.md"]'),
  ).toHaveClass(/is-selected/);
});

test("browser back disables follow mode so the next file change does not undo the navigation", async ({ page }) => {
  // Build a back stack: README → links-demo → README (the second README entry
  // comes from clicking Follow, which catches up to the most recently
  // modified file — README.md — and pushes its URL).
  await page.locator('button[data-document-id$="links-demo.md"]').click();
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
  await page.locator('button[data-document-id$="links-demo.md"]').click();
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
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "setup.md" })).toHaveCount(0);
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
  await page.locator('button[data-document-id$="links-demo.md"]').click();
  await expect(page.locator("#preview-path")).toHaveText("links-demo.md");

  // Delete README.md from disk; wait for the SSE-driven sidebar refresh.
  await fs.rm(workspacePath("README.md"));
  await expect(page.getByRole("button", { name: "README.md" })).toHaveCount(0);

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

  await page.getByRole("button", { name: "hello world.md" }).click();
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

  // Wait until the SPA's local index reflects setup.md's bumped mtime so the
  // catch-up resolves to it (rather than racing the SSE refresh).
  await page.waitForFunction(
    () => {
      const setup = document.querySelector(
        'button[data-document-id$="guides/setup.md"] .tree-mtime',
      ) as HTMLElement | null;
      const linksDemo = document.querySelector(
        'button[data-document-id$="links-demo.md"] .tree-mtime',
      ) as HTMLElement | null;
      if (!setup || !linksDemo) return false;
      return Number(setup.dataset.mtime) > Number(linksDemo.dataset.mtime);
    },
    undefined,
    { timeout: 5_000 },
  );

  // Re-enable follow — must catch up to setup.md immediately.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
});

test("default Mode is Author with the forecast headline label", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  await expect(page.locator("#mode-author")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#follow-toggle")).toBeEnabled();
  const overview = page.locator("#change-overview");
  await expect(overview.locator(".burden-headline")).toHaveText("Reviewer burden forecast");
});

test("Mode persists across reload via localStorage", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  await page.locator("#mode-review").click();
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#mode-author")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#follow-toggle")).toBeDisabled();
  const overview = page.locator("#change-overview");
  await expect(overview.locator(".burden-headline")).toHaveText("Change review burden");
});

test("switching Author -> Review disables Follow and switching back leaves it off", async ({ page }) => {
  await page.locator("#mode-review").click();
  await expect(page.locator("#follow-toggle")).toBeDisabled();
  await expect(page.locator("#follow-toggle")).toHaveClass(/is-mode-disabled/);
  await page.locator("#mode-author").click();
  await expect(page.locator("#follow-toggle")).toBeEnabled();
  // Author should NOT auto-enable Follow — the user must opt back in.
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("CLI --mode=review boots in Review with Follow off", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { startupMode: "review", git: true } });
  await page.goto("/");
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#follow-toggle")).toBeDisabled();
  const overview = page.locator("#change-overview");
  await expect(overview.locator(".burden-headline")).toHaveText("Change review burden");
});

test("CLI --mode flag overrides persisted preference at startup", async ({ page, request }) => {
  // First boot: persist Review.
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  await page.locator("#mode-review").click();
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  // Second boot with CLI override to author — must win at startup.
  await request.post("/__e2e/reset", { data: { startupMode: "author", git: true } });
  await page.reload();
  await expect(page.locator("#mode-author")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "false");
});

test("Review mode does not switch active preview when a different file changes", async ({ page }) => {
  await page.locator("#mode-review").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nReview suppresses switching.\n", "utf8");
  // Wait long enough that any auto-switch would have landed (debounced to ~150ms server-side).
  await page.waitForTimeout(700);
  await expect(page.locator("#preview-path")).toHaveText("README.md");
});

test("Review mode allows manual file selection from the Files pane", async ({ page }) => {
  await page.locator("#mode-review").click();
  await page.getByRole("button", { name: "diagram.md" }).click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
});

test("Review mode shows a stale-content hint when the active file changes on disk", async ({ page }) => {
  await page.locator("#mode-review").click();
  // Capture the rendered title BEFORE the disk change so we can prove the
  // preview did not auto-re-render.
  const titleBefore = await page.locator("#preview h1, #preview h2, #preview h3").first().textContent();
  await fs.writeFile(workspacePath("README.md"), "# Renamed Heading\n\nNew content.\n", "utf8");
  await expect(page.locator("#stale-hint")).toBeVisible();
  await expect(page.locator("#stale-hint")).toHaveClass(/is-changed/);
  await expect(page.locator("#stale-hint-message")).toHaveText("This file has changed on disk.");
  await expect(page.locator("#stale-hint-action")).toHaveText("Refresh");
  // Stale content still showing.
  const titleStillStale = await page.locator("#preview h1, #preview h2, #preview h3").first().textContent();
  expect(titleStillStale).toBe(titleBefore);
  // Refresh acts on the hint.
  await page.locator("#stale-hint-action").click();
  await expect(page.locator("#stale-hint")).toBeHidden();
  await expect(page.locator("#preview h1").first()).toHaveText("Renamed Heading");
});

test("Review hint coalesces multiple changes and clears on manual navigation", async ({ page }) => {
  await page.locator("#mode-review").click();
  await fs.writeFile(workspacePath("README.md"), "# First Edit\n\n.\n", "utf8");
  await expect(page.locator("#stale-hint")).toBeVisible();
  await fs.writeFile(workspacePath("README.md"), "# Second Edit\n\n.\n", "utf8");
  await fs.writeFile(workspacePath("README.md"), "# Third Edit\n\n.\n", "utf8");
  // Still exactly one hint visible.
  await expect(page.locator("#stale-hint")).toHaveCount(1);
  await expect(page.locator("#stale-hint")).toBeVisible();
  // Manual navigation clears the hint.
  await page.getByRole("button", { name: "diagram.md" }).click();
  await expect(page.locator("#stale-hint")).toBeHidden();
});

test("Switching to Author clears the hint and re-renders to current on-disk content", async ({ page }) => {
  await page.locator("#mode-review").click();
  await fs.writeFile(workspacePath("README.md"), "# Mode Switch Refresh\n\n.\n", "utf8");
  await expect(page.locator("#stale-hint")).toBeVisible();
  await page.locator("#mode-author").click();
  await expect(page.locator("#stale-hint")).toBeHidden();
  await expect(page.locator("#preview h1").first()).toHaveText("Mode Switch Refresh");
});

test("Stale hint never appears in Author mode", async ({ page }) => {
  // Default test setup leaves us in Author. Modify the active file.
  await fs.writeFile(workspacePath("README.md"), "# Author Inline Refresh\n\n.\n", "utf8");
  // Wait for the in-place refresh path to land.
  await expect(page.locator("#preview h1").first()).toHaveText("Author Inline Refresh");
  await expect(page.locator("#stale-hint")).toBeHidden();
});

test("Active file deleted on disk in Review shows the deleted hint variant", async ({ page }) => {
  await page.locator("#mode-review").click();
  // Capture pre-deletion content marker.
  const before = await page.locator("#preview h1").first().textContent();
  await fs.unlink(workspacePath("README.md"));
  await expect(page.locator("#stale-hint")).toBeVisible();
  await expect(page.locator("#stale-hint")).toHaveClass(/is-deleted/);
  await expect(page.locator("#stale-hint-message")).toHaveText("This file no longer exists on disk.");
  await expect(page.locator("#stale-hint-action")).toHaveText("Close");
  // Stale rendered content is still visible until the user acts.
  const stillVisible = await page.locator("#preview h1").first().textContent();
  expect(stillVisible).toBe(before);
});

test("Mode visual differentiation: subtitle, pill, segment glyphs, connection indicator, and preview frame all reflect Mode", async ({ page }) => {
  const subtitle = page.locator("#mode-subtitle");
  const pill = page.locator("#mode-pill");
  const connectionLabel = page.locator("#connection-state .connection-label");
  const previewShell = page.locator(".preview-shell");
  const indicatorDot = page.locator("#connection-state .indicator-dot");

  // Author baseline.
  await expect(subtitle).toHaveText("Authoring session");
  await expect(pill).toHaveText("Authoring");
  await expect(pill).toHaveAttribute("data-mode-pill", "author");
  await expect(connectionLabel).toHaveText("Online");
  await expect(previewShell).not.toHaveClass(/is-mode-review/);

  // Both segments expose a glyph regardless of which is active.
  await expect(page.locator("#mode-author .mode-glyph")).toHaveCount(1);
  await expect(page.locator("#mode-review .mode-glyph")).toHaveCount(1);

  // Author live dot is animated (pulsing).
  const authorDotAnim = await indicatorDot.evaluate((el) =>
    getComputedStyle(el).animationName,
  );
  expect(authorDotAnim).not.toBe("none");

  // Switch to Review.
  await page.locator("#mode-review").click();
  await expect(subtitle).toHaveText("Review session");
  await expect(pill).toHaveText("Reviewing");
  await expect(pill).toHaveAttribute("data-mode-pill", "review");
  await expect(connectionLabel).toHaveText("Reading — auto-refresh paused");
  await expect(previewShell).toHaveClass(/is-mode-review/);

  // Review live dot is steady (animation cleared).
  const reviewDotAnim = await indicatorDot.evaluate((el) =>
    getComputedStyle(el).animationName,
  );
  expect(reviewDotAnim).toBe("none");

  // Switch back to Author and confirm everything restores.
  await page.locator("#mode-author").click();
  await expect(subtitle).toHaveText("Authoring session");
  await expect(pill).toHaveText("Authoring");
  await expect(connectionLabel).toHaveText("Online");
  await expect(previewShell).not.toHaveClass(/is-mode-review/);
});

test("Score number and level are identical across Mode switches; only the headline label differs", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  const overview = page.locator("#change-overview");
  const meter = overview.locator(".burden-meter").first();
  const headline = meter.locator(".burden-headline");
  const level = meter.locator(".burden-level");
  const score = meter.locator("strong");

  await expect(headline).toHaveText("Reviewer burden forecast");
  const authorLevel = await level.textContent();
  const authorScore = await score.textContent();
  const meterClassAuthor = await meter.getAttribute("class");

  await page.locator("#mode-review").click();
  await expect(headline).toHaveText("Change review burden");
  expect(await level.textContent()).toBe(authorLevel);
  expect(await score.textContent()).toBe(authorScore);
  expect(await meter.getAttribute("class")).toBe(meterClassAuthor);
});

test("Mode toggle is rendered in the sidebar, not the preview toolbar", async ({ page }) => {
  // Sidebar contains it.
  await expect(page.locator(".sidebar-mode-row #mode-control")).toBeVisible();
  // Preview toolbar does not.
  await expect(page.locator(".preview-toolbar #mode-control")).toHaveCount(0);
});

test("Pin UI affordance is removed", async ({ page }) => {
  await expect(page.locator("#pin-toggle")).toHaveCount(0);
});

test("Files pane: View toggle is hidden when no git base is detected", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { nonGit: true } });
  await page.goto("/");
  await expect(page.locator("#files-view-toggle")).toBeHidden();
  // Tree fallback still renders normally.
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
});

test("Files pane: View toggle defaults to All and switches to Changed when git is available", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true, dirty: { "README.md": "# Modified\n" } } });
  await page.goto("/");
  await expect(page.locator("#files-view-toggle")).toBeVisible();
  // Default = All — README.md (and other fixture files) are listed in the tree.
  await expect(page.locator("#files-view-all")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#files-view-changed")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  // Switch to Changed.
  await page.locator("#files-view-changed").click();
  await expect(page.locator("#files-view-changed")).toHaveAttribute("aria-checked", "true");
  // The Changed view replaces the tree with the changed-file list. Status
  // glyph + path appear; line counts appear when git reports adds/dels.
  const changedList = page.locator(".changed-file-list");
  await expect(changedList).toBeVisible();
  await expect(changedList).toContainText("README.md");
  // Switch back to All — tree comes back.
  await page.locator("#files-view-all").click();
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
});

test("Files pane: View choice persists separately per Mode", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true, dirty: { "README.md": "# Modified\n" } } });
  await page.goto("/");
  // Author defaults All — switch to Changed and verify persistence.
  await page.locator("#files-view-changed").click();
  await expect(page.locator("#files-view-changed")).toHaveAttribute("aria-checked", "true");
  // Switch to Review (which defaults All) and confirm Review didn't inherit Author's Changed pick.
  await page.locator("#mode-review").click();
  await expect(page.locator("#files-view-all")).toHaveAttribute("aria-checked", "true");
  // Flip back to Author — Changed restores.
  await page.locator("#mode-author").click();
  await expect(page.locator("#files-view-changed")).toHaveAttribute("aria-checked", "true");
});

test("Per-mode pane state: hiding Change Overview in Author does not hide it in Review", async ({ page }) => {
  // Hide Change Overview while in Author.
  await page.locator('[data-pane-id="change-overview"]').getByRole("button", { name: "Hide Change Overview" }).click();
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeHidden();
  // Switch to Review — Change Overview should still be visible (separate pane state).
  await page.locator("#mode-review").click();
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeVisible();
  // Switch back to Author — still hidden.
  await page.locator("#mode-author").click();
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeHidden();
});

test("Panels-restore menu does not list Git Log in Author Mode", async ({ page }) => {
  await page.locator("#panels-toggle").click();
  await expect(page.locator('#panels-menu label:has-text("Change Overview")')).toBeVisible();
  await expect(page.locator('#panels-menu label:has-text("Files")')).toBeVisible();
  await expect(page.locator('#panels-menu label:has-text("Git Log")')).toHaveCount(0);
  // Close menu, switch to Review — Git Log appears.
  await page.locator("#panels-toggle").click();
  await page.locator("#mode-review").click();
  await page.locator("#panels-toggle").click();
  await expect(page.locator('#panels-menu label:has-text("Git Log")')).toBeVisible();
});

test("Folder icons render on directory rows in the fallback tree", async ({ page }) => {
  // The default fixture has a `guides/` directory.
  const guides = page.locator(".tree-dir", { has: page.locator("text=guides") }).first();
  await expect(guides.locator(".tree-folder-icon svg")).toBeVisible();
});
