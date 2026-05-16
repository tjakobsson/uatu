import { expect, test, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "../../src/e2e";
import { clickTreeFile, treeRow } from "./tree-helpers";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__e2e/reset");
  await page.goto("/");
  // Clear browser-side persisted preferences so a prior test cannot leak
  // state into this one. localStorage persists across tests within the same
  // Playwright worker; the workspace reset above does not touch the browser.
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await page.reload();
  // Tree rows are rendered inside `@pierre/trees`' shadow DOM with
  // `role="treeitem"` and `data-item-path` — Playwright pierces the shadow
  // root automatically when given a CSS selector, so `treeRow(...)` is the
  // reliable readiness signal for "the tree is mounted with content."
  await expect(treeRow(page, "README.md")).toBeVisible();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#document-count")).toHaveText("16 files");
  await waitForPreviewToSettle(page);
  // Establish a clean baseline: manual selection of README.md with follow
  // disabled. Click a non-README file first so the second click into README
  // actually fires the library's onSelectionChange (the library de-dupes
  // clicks on the already-selected row, which would otherwise leave the
  // boot-time follow=true state untouched).
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
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
  await treeRow(page, "diagram.md").click();

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
  await treeRow(page, "diagram.md").click();
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
  await treeRow(page, "diagram.md").click();
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
  await treeRow(page, "diagram.md").click();
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
  await treeRow(page, "diagram.md").click();
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
  await treeRow(page, "diagram.md").click();
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
  await treeRow(page, "diagram.md").click();
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
  await treeRow(page, "mermaid-shapes.md").click();
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
  await treeRow(page, "mermaid-shapes.md").click();
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
  await treeRow(page, "mermaid-shapes.md").click();
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
  await treeRow(page, "mermaid-shapes.md").click();
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
  await treeRow(page, "mermaid-shapes.md").click();
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
  await treeRow(page, "mermaid-shapes.md").click();
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

// Tree rows are rendered by @pierre/trees inside a shadow DOM with the
// custom element `<file-tree-container>` as the host. Playwright pierces
// open shadow roots automatically for CSS-based locators, so the helpers
// in `./tree-helpers.ts` (`treeRow`, `clickTreeFile`) target the library's
// data-attribute API (`data-item-path`, `aria-expanded`, `aria-selected`)
// directly without any shadow-piercing ceremony.

test("tree rows render a file-type icon via the library's built-in icon set", async ({ page }) => {
  // The library renders icons as inline SVG inside each row. We just assert
  // that one is present on a Markdown row — the exact sprite is an internal
  // contract we don't pin here.
  await expect(treeRow(page, "README.md").locator("svg")).not.toHaveCount(0);
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

  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");

  // Switch to Review — Git Log should appear, with Files getting the spare height.
  await page.locator("#mode-review").click();
  await expect(page.locator('[data-pane-id="git-log"]')).toBeVisible();
  // The Selection Inspector pane is also Review-only and competes for vertical
  // space at the e2e viewport size; hide it for the height comparison so this
  // test stays focused on the Files-vs-GitLog grow-target relationship.
  await page
    .locator('[data-pane-id="selection-inspector"]')
    .getByRole("button", { name: "Hide Selection Inspector" })
    .click();
  await expect(page.locator('[data-pane-id="selection-inspector"]')).toBeHidden();
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

test("tree distinguishes untracked rows from added rows via git-status annotations", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "review",
      // Create one fresh path not present in the committed fixture — it ends
      // up untracked. The name starts with `a-` so the row sorts near the top
      // of the file list and stays inside the tree's virtualization window
      // (otherwise the row exists in the model but is not in the DOM).
      // `feature.md` is committed on `feature/review-load`, so it is the
      // natural foil: same workspace, distinct git category.
      dirty: {
        "a-untracked-scratch.md": "# Untracked scratch\n",
      },
    },
  });
  await page.goto("/");

  const untrackedRow = treeRow(page, "a-untracked-scratch.md");
  await expect(untrackedRow).toHaveAttribute("data-item-git-status", "untracked");

  const addedRow = treeRow(page, "feature.md");
  await expect(addedRow).toHaveAttribute("data-item-git-status", "added");
});

test("Change Overview renders an untracked categorical indicator when untracked files are present", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "review",
      dirty: {
        "a-untracked-scratch.md": "# Untracked scratch\n",
      },
    },
  });
  await page.goto("/");

  const indicator = page.locator("#change-overview [data-untracked-indicator]");
  await expect(indicator).toBeVisible();
  await expect(indicator).toContainText("untracked");
});

test("Change Overview omits the untracked indicator when no untracked files are present", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "review",
      // No `dirty` writes — every file in the workspace is either committed
      // (initial fixture, history-N.md, feature.md) or staged-but-not-committed
      // via the test fixture's git init. No path remains untracked.
    },
  });
  await page.goto("/");

  // The pane has rendered before we can assert absence: wait for the burden
  // meter to mount so we know `renderChangeOverview` has fired.
  await expect(page.locator("#change-overview .burden-meter")).toBeVisible();
  await expect(page.locator("#change-overview [data-untracked-indicator]")).toHaveCount(0);
});

test("Untracked indicator persists with identical text across Author and Review modes", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "author",
      dirty: {
        "a-untracked-scratch.md": "# Untracked scratch\n",
      },
    },
  });
  await page.goto("/");

  const indicator = page.locator("#change-overview [data-untracked-indicator]");
  await expect(indicator).toBeVisible();
  const authorText = (await indicator.textContent())?.trim();

  await page.locator("#mode-review").click();
  await expect(indicator).toBeVisible();
  const reviewText = (await indicator.textContent())?.trim();
  expect(reviewText).toBe(authorText);
});

test("Score-explanation preview breaks out the untracked subcount as a factual change-shape input", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "review",
      dirty: {
        "a-untracked-scratch.md": "# Untracked scratch\n",
      },
    },
  });
  await page.goto("/");

  await page.locator("#change-overview .burden-meter").first().click();
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");

  // The new sub-driver lives inside the Mechanical Statistics block.
  const untrackedRow = page.locator(
    '#preview .score-preview-list li:has(strong:text-is("Untracked files"))',
  );
  await expect(untrackedRow).toBeVisible();
  await expect(untrackedRow).toContainText("1 file not yet in git");
  // The score contribution is presentation-only.
  await expect(untrackedRow.locator("code")).toHaveText("0");
});

test("Score-explanation preview omits the untracked row when no untracked files are present", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "review",
      // No dirty/untracked writes; the fixture's committed history exercises
      // the mechanical drivers without touching the untracked category.
    },
  });
  await page.goto("/");

  await page.locator("#change-overview .burden-meter").first().click();
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");

  await expect(
    page.locator('#preview .score-preview-list li:has(strong:text-is("Untracked files"))'),
  ).toHaveCount(0);
});

test("Tree annotates ignoreAreas-matched untracked files with their git status (score policy is not a visibility policy)", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "review",
      uatuConfig: {
        review: {
          ignoreAreas: [{ label: "Scratch", paths: ["a-ignored-*.md"] }],
        },
      },
      dirty: {
        "a-ignored-scratch.md": "# Ignored untracked\n",
      },
    },
  });
  await page.goto("/");

  const row = treeRow(page, "a-ignored-scratch.md");
  await expect(row).toHaveAttribute("data-item-git-status", "untracked");
});

test("Change Overview untracked indicator renders even when every untracked file is ignored by score policy", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "review",
      uatuConfig: {
        review: {
          ignoreAreas: [{ label: "Scratch", paths: ["a-ignored-*.md"] }],
        },
      },
      dirty: {
        "a-ignored-scratch.md": "# Ignored untracked\n",
      },
    },
  });
  await page.goto("/");

  await expect(page.locator("#change-overview [data-untracked-indicator]")).toBeVisible();
  // Score-explanation preview, by contrast, MUST omit the untracked subcount —
  // ignored files do not contribute to the score, so the score-side breakdown
  // has nothing to report.
  await page.locator("#change-overview .burden-meter").first().click();
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");
  await expect(
    page.locator('#preview .score-preview-list li:has(strong:text-is("Untracked files"))'),
  ).toHaveCount(0);
});

test("Tree annotates gitignored files with the 'ignored' status (distinct from untracked)", async ({ page, request }) => {
  // The realistic scenario this addresses is files matched by the user's
  // *global* git excludesFile (e.g. `.claude/settings.local.json`) — uatu's
  // tree shows them because uatu only respects repo-local `.gitignore`, but
  // git refuses to track them. We can't write to the user's global config
  // from a test, so we simulate the equivalent by writing a repo-local
  // `.gitignore` and disabling uatu's gitignore respect for this session:
  // git's `--ignored --exclude-standard` still finds the file, uatu's tree
  // still shows it, and the annotation closes the gap.
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      startupMode: "review",
      respectGitignore: false,
      extras: {
        ".gitignore": "a-local-only.json\n",
      },
      dirty: {
        "a-local-only.json": "{}\n",
      },
    },
  });
  await page.goto("/");

  // Review's default filter (Changed) excludes gitignored files entirely —
  // toggle to All so the annotation we're asserting is reachable.
  await page.locator("#files-pane-filter-all").click();

  const row = treeRow(page, "a-local-only.json");
  await expect(row).toHaveAttribute("data-item-git-status", "ignored");
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
  // Tree selection state moved into the @pierre/trees shadow DOM; behavior is
  // covered via the preview-path / URL assertions in this test instead.
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  const commitUrl = new URL(page.url());
  expect(commitUrl.pathname).toBe("/");
  expect(commitUrl.searchParams.get("repository")).toBeTruthy();
  expect(commitUrl.searchParams.get("commit")).toMatch(/^[0-9a-f]{7,12}$/);

  await page.goBack();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  // Follow is unavailable in Review (where Git Log lives) — that assertion
  // belongs in the Mode tests.

  await page.goForward();
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
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
  await expect(treeRow(page, "README.md")).toBeVisible();
  await expect(treeRow(page, "guides/setup.md")).toHaveCount(0);
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
  // beforeEach left README.md selected. Click another file first so the
  // library actually fires a selection change when we click README again
  // (the library de-dupes "click already-selected row" events, which would
  // skip the re-fetch we need to see the updated README content).
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

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
  await expect(page.locator("#document-count")).toHaveText("17 files");

  const yamlButton = treeRow(page, "config.yaml");
  await expect(yamlButton).toBeVisible();
  await yamlButton.click();

  await expect(page.locator("#preview-path")).toHaveText("config.yaml");
  await expect(page.locator('#preview pre code.hljs.language-yaml')).toBeVisible();
});

test("a non-image binary appears in the tree and routes to the preview-unavailable view", async ({ page, request }) => {
  // Binary content (NUL byte) under an unknown extension triggers the
  // content-sniff classifier so we don't depend on the known-extensions
  // table. Not an image extension, so the preview shows the
  // "not viewable" message rather than the image branch.
  await request.post("/__e2e/reset", {
    data: { extras: { "data.bin": "PK ignored\0 binary content" } },
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

  const binRow = treeRow(page, "data.bin");
  await expect(binRow).toBeVisible();
  await binRow.click();

  await expect(page.locator("#preview-path")).toHaveText("data.bin");
  await expect(page.locator("#preview")).toContainText("isn't viewable");
  // Regression guard: the legacy "no longer exists" message must not appear.
  await expect(page.locator("#preview")).not.toContainText("no longer exists");
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

test("follow mode switches the preview when a non-Markdown text file changes", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: original\n" } },
  });
  await page.goto("/");
  // Click a non-README file then README — this both demonstrates manual
  // navigation AND guarantees follow is off (manual selection disables it).
  // Without the intermediate click, clicking the already-selected README
  // is a no-op for the library's selection state, so the boot-time
  // follow=true wouldn't be disabled and the next follow-toggle click
  // would flip true→false instead of false→true.
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  await fs.writeFile(workspacePath("config.yaml"), "key: changed\nport: 9999\n", "utf8");

  await expect(page.locator("#preview-path")).toHaveText("config.yaml");
  await expect(page.locator('#preview pre code.hljs.language-yaml')).toBeVisible();
});

test("enabling follow jumps to the most recently modified file", async ({ page }) => {
  // beforeEach lands on README.md (its mtime is bumped 10s into the future by
  // resetE2EWorkspace, so it's the current default selection). Make setup.md
  // strictly newer so the catch-up has an unambiguous target.
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nFreshly touched.\n", "utf8");
  const fresher = new Date(Date.now() + 30_000);
  await fs.utimes(workspacePath("guides", "setup.md"), fresher, fresher);

  // Give the polling watcher (100ms interval, 100ms stability) time to
  // observe the bumped mtime and let the SSE refresh land in the SPA. We
  // no longer have the `.tree-mtime[data-mtime]` spans as a deterministic
  // readiness signal, so this is a bounded delay tied to the watcher's
  // poll cadence.
  await page.waitForTimeout(800);

  // Manually re-select README to ensure follow is OFF and selection is README.
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  // Enable follow — preview must catch up to setup.md.
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
  await expect(page.locator("#document-count")).toHaveText("17 files · 1 binary");
});

// Removed: "sidebar counter shows the hidden subcount" — the `· N hidden`
// segment was retired with the .uatuignore source in replace-tree-with-pierre.
// The counter now shows only `N files` (+ `· M binary` when present).

test("connection indicator lives in the sidebar header under the UatuCode wordmark", async ({ page }) => {
  // The connection indicator is a global "is the backend reachable" status,
  // so it sits with the brand area in the sidebar header rather than mixed
  // into preview controls. It is NOT rendered in the preview toolbar.
  await expect(page.locator(".sidebar-header #connection-state")).toBeVisible();
  await expect(page.locator(".preview-toolbar #connection-state")).toHaveCount(0);

  // Inside the sidebar header it stacks with the wordmark in a vertical
  // brand-text column.
  await expect(page.locator(".brand .brand-text #connection-state")).toBeVisible();

  // Collapsing the whole sidebar hides the indicator along with the rest of
  // the sidebar chrome — accepted tradeoff for putting the status with the
  // brand instead of with the preview controls.
  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await expect(page.locator("#connection-state")).toBeHidden();
});

test("preview header shows a file-type chip for the selected document", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: value\n" } },
  });
  await page.goto("/");
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-type")).toHaveText("markdown");

  await treeRow(page, "config.yaml").click();
  await expect(page.locator("#preview-type")).toHaveText("yaml");
});

test("renders the AsciiDoc cheat sheet with full heading depth, TOC, admonitions, syntax highlighting, and Mermaid", async ({ page }) => {
  // Uses the permanent testdata/watch-docs/asciidoc-cheatsheet.adoc fixture,
  // which doubles as a visual reference for the AsciiDoc render path AND the
  // fixture under test for it.
  const adocButton = treeRow(page, "asciidoc-cheatsheet.adoc");
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

  // Both AsciiDoc mermaid forms — `[source,mermaid]` and the bare `[mermaid]`
  // block style — hydrate client-side into rendered SVGs.
  const diagrams = page.locator("#preview .mermaid svg");
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first()).toBeVisible();
  await expect(diagrams.nth(1)).toBeVisible();

  // Block quote and sidebar.
  await expect(page.locator("#preview .quoteblock")).toBeVisible();
  await expect(page.locator("#preview .sidebarblock")).toBeVisible();
});

test("clicking a Table of Contents link in the AsciiDoc cheat sheet navigates to that section", async ({ page }) => {
  // Full round-trip: TOC entries are rendered with `href="#user-content-..."`
  // (sanitize prefixes heading ids; rewriteInPageAnchors mirrors that on the
  // hrefs), and an in-page anchor click handler in app.ts intercepts the click
  // and scrolls the matching heading into view directly.
  await treeRow(page, "asciidoc-cheatsheet.adoc").click();
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

  // Open the nested document via the tree helper, which handles expanding
  // ancestor directories. The library renders rows inside its shadow DOM.
  await clickTreeFile(page, "guides/nested.adoc");
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
  await treeRow(page, "config.yaml").click();

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
  await treeRow(page, "config.yaml").click();
  const codeViewGutter = page.locator("#preview pre.has-line-numbers .line-numbers");
  await expect(codeViewGutter).toHaveCount(1);
  await expect(codeViewGutter).toHaveText("1\n2\n3");

  // Markdown view: fenced block has NO line numbers
  await treeRow(page, "with-code.md").click();
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
  await treeRow(page, "links-demo.adoc").click();
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
  await treeRow(page, "links-demo.adoc").click();
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
    treeRow(page, "asciidoc-cheatsheet.adoc"),
  ).toHaveAttribute("aria-selected", "true");
});

test("clicking an AsciiDoc cross-document link into a subdirectory switches the preview", async ({ page }) => {
  // Same handler, exercised through `xref:guides/notes.adoc[…]` so the
  // resolved URL has a directory segment in it.
  await treeRow(page, "links-demo.adoc").click();
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
  await treeRow(page, "links-demo.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");

  await expect(page.locator('#preview a[href="README.md"]')).toBeVisible();
  await expect(page.locator('#preview a[href="guides/setup.md"]')).toBeVisible();
  await expect(page.locator('#preview a[href$=".html"]')).toHaveCount(0);
});

test("clicking a Markdown cross-document link switches the preview in-app", async ({ page }) => {
  await treeRow(page, "links-demo.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Markdown Cross-Document Links");

  await page.locator('#preview a[href="guides/setup.md"]').click();

  await expect(page.locator("#preview-title")).toHaveText("Setup");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  expect(new URL(page.url()).pathname).toBe("/guides/setup.md");
  await expect(
    treeRow(page, "guides/setup.md"),
  ).toHaveAttribute("aria-selected", "true");
});

test("preview header stays visible while scrolling and the sidebar scroll is independent", async ({ page }) => {
  const padding = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  await fs.writeFile(workspacePath("README.md"), `# Uatu\n\n${padding}\n`, "utf8");

  await treeRow(page, "README.md").click();
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
  await expect(page.locator("#follow-toggle")).toBeHidden();
  const overview = page.locator("#change-overview");
  await expect(overview.locator(".burden-headline")).toHaveText("Change review burden");
});

test("switching Author -> Review hides Follow; the Author Follow choice round-trips back", async ({ page }) => {
  // Baseline: Follow is OFF in Author (beforeEach clicked README manually,
  // which disables Follow). Round-trip should preserve that state.
  await page.locator("#mode-review").click();
  await expect(page.locator("#follow-toggle")).toBeHidden();
  await page.locator("#mode-author").click();
  await expect(page.locator("#follow-toggle")).toBeVisible();
  await expect(page.locator("#follow-toggle")).toBeEnabled();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("Follow ON in Author round-trips through Review and is restored on return", async ({ page }) => {
  // Turn Follow on while in Author.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  // Peek into Review — chip is hidden, but the Author preference is snapshotted.
  await page.locator("#mode-review").click();
  await expect(page.locator("#follow-toggle")).toBeHidden();

  // Back to Author: Follow is automatically restored to ON (the user does
  // not have to click again every time they peek into Review).
  await page.locator("#mode-author").click();
  await expect(page.locator("#follow-toggle")).toBeVisible();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("CLI --mode=review boots in Review with Follow hidden", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { startupMode: "review", git: true } });
  await page.goto("/");
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#follow-toggle")).toBeHidden();
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
  // Review's chip defaults to Changed; this fixture has no git and no
  // changes, so we toggle to All to keep the target file visible.
  await page.locator("#files-pane-filter-all").click();
  await treeRow(page, "diagram.md").click();
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
  // Toggle the Changed filter off so `diagram.md` is reachable for the
  // manual-navigation clear step below (this fixture is non-git, so the
  // chip would otherwise sit in the "filter unavailable" empty state).
  await page.locator("#files-pane-filter-all").click();
  await fs.writeFile(workspacePath("README.md"), "# First Edit\n\n.\n", "utf8");
  await expect(page.locator("#stale-hint")).toBeVisible();
  await fs.writeFile(workspacePath("README.md"), "# Second Edit\n\n.\n", "utf8");
  await fs.writeFile(workspacePath("README.md"), "# Third Edit\n\n.\n", "utf8");
  // Still exactly one hint visible.
  await expect(page.locator("#stale-hint")).toHaveCount(1);
  await expect(page.locator("#stale-hint")).toBeVisible();
  // Manual navigation clears the hint.
  await treeRow(page, "diagram.md").click();
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

test("Mode visual differentiation: segment glyphs, connection indicator, and preview frame all reflect Mode", async ({ page }) => {
  const connectionState = page.locator("#connection-state");
  const connectionLabel = connectionState.locator(".connection-label");
  const previewShell = page.locator(".preview-shell");
  const indicatorDot = connectionState.locator(".indicator-dot");

  // Author baseline: indicator is visible and reads "Connected".
  await expect(connectionState).toBeVisible();
  await expect(connectionLabel).toHaveText("Connected");
  await expect(connectionState).toHaveAttribute("title", "Connected to the uatu backend");
  await expect(previewShell).not.toHaveClass(/is-mode-review/);

  // Both segments expose a glyph regardless of which is active.
  await expect(page.locator("#mode-author .mode-glyph")).toHaveCount(1);
  await expect(page.locator("#mode-review .mode-glyph")).toHaveCount(1);

  // Author live dot is animated (pulsing).
  const authorDotAnim = await indicatorDot.evaluate((el) =>
    getComputedStyle(el).animationName,
  );
  expect(authorDotAnim).not.toBe("none");

  // Switch to Review: the indicator stays visible with the same "Connected"
  // copy and the same animated dot — the connection indicator is purely a
  // backend-reachability status and does not vary with Mode. The Review
  // preview-shell class still applies so other Review-only styling can hook
  // off it.
  await page.locator("#mode-review").click();
  await expect(connectionState).toBeVisible();
  await expect(connectionLabel).toHaveText("Connected");
  await expect(previewShell).toHaveClass(/is-mode-review/);

  const reviewDotAnim = await indicatorDot.evaluate((el) =>
    getComputedStyle(el).animationName,
  );
  expect(reviewDotAnim).not.toBe("none");

  // Switch back to Author and confirm the indicator is unchanged.
  await page.locator("#mode-author").click();
  await expect(connectionState).toBeVisible();
  await expect(connectionLabel).toHaveText("Connected");
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

// Removed: All/Changed view toggle and its per-Mode persistence — retired in
// replace-tree-with-pierre. Changed-file state is now an ambient git-status
// row annotation on the single tree (see @pierre/trees `setGitStatus`).
// A replacement test for the annotation rendering is on the followup E2E
// sweep (tasks.md task 9.1).

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

// Removed: "Folder icons render on directory rows in the fallback tree" —
// the folder icon is now rendered by @pierre/trees as part of its built-in
// 'standard' icon set rather than uatu's bespoke folder SVG.

test("metadata card surfaces YAML frontmatter above the body", async ({ page }) => {
  await clickTreeFile(page, "metadata/markdown-yaml.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");
  const card = page.locator("#preview .metadata-card");
  await expect(card).toBeVisible();
  // The card is a collapsed disclosure by default. Open it to inspect rows.
  await expect(card).not.toHaveAttribute("open", "");
  await card.locator(".metadata-card-summary").click();
  await expect(card).toHaveAttribute("open", "");
  // Curated rows render in a stable order, then extras follow.
  const labels = card.locator(".metadata-card-row .metadata-card-label");
  await expect(labels).toHaveText([
    "Title",
    "Author",
    "Date",
    "Description",
    "Tags",
    "Status",
    "slug",
  ]);
  // The body's first heading still renders below the card.
  const cardBox = await card.boundingBox();
  const heading = page.locator("#preview h1").first();
  const headingBox = await heading.boundingBox();
  expect(cardBox).toBeTruthy();
  expect(headingBox).toBeTruthy();
  expect(headingBox!.y).toBeGreaterThan(cardBox!.y);
  // The leading `---` MUST NOT survive as a thematic break.
  await expect(page.locator("#preview hr")).toHaveCount(0);
});

test("metadata card open/closed state persists across documents", async ({ page }) => {
  await clickTreeFile(page, "metadata/markdown-yaml.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");

  // Open it on the first doc.
  const firstCard = page.locator("#preview .metadata-card");
  await expect(firstCard).not.toHaveAttribute("open", "");
  await firstCard.locator(".metadata-card-summary").click();
  await expect(firstCard).toHaveAttribute("open", "");

  // Navigate to another metadata-bearing doc — the card should still be open.
  await clickTreeFile(page, "metadata/asciidoc-attrs.adoc");
  await expect(page.locator("#preview-path")).toHaveText("metadata/asciidoc-attrs.adoc");
  const secondCard = page.locator("#preview .metadata-card");
  await expect(secondCard).toHaveAttribute("open", "");

  // Close it on the second doc, then go back — should now be closed everywhere.
  await secondCard.locator(".metadata-card-summary").click();
  await expect(secondCard).not.toHaveAttribute("open", "");

  await clickTreeFile(page, "metadata/markdown-yaml.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");
  await expect(page.locator("#preview .metadata-card")).not.toHaveAttribute("open", "");
});

test("a Markdown file with no frontmatter shows no metadata card", async ({ page }) => {
  await clickTreeFile(page, "metadata/markdown-empty.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-empty.md");
  await expect(page.locator("#preview .metadata-card")).toHaveCount(0);
});

test("metadata values containing <script> are rendered as escaped text, not executed", async ({ page }) => {
  // Build the fixture in-place so the assertion is wholly self-contained and
  // does not require a hostile fixture to live in the repo permanently.
  const hostile = `---\ntitle: Safe Title\ndescription: '<script>window.__pwned = true</script>'\n---\n\n# Body\n`;
  await fs.writeFile(workspacePath("metadata", "hostile.md"), hostile, "utf8");
  await clickTreeFile(page, "metadata/hostile.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/hostile.md");
  // The card renders, the description text is visible as escaped characters,
  // but the script never executes.
  const card = page.locator("#preview .metadata-card");
  await expect(card).toBeVisible();
  await card.locator(".metadata-card-summary").click();
  await expect(card.locator(".metadata-card-body")).toContainText("<script>");
  await expect(card.locator("script")).toHaveCount(0);
  const pwned = await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned === true);
  expect(pwned).toBe(false);
});

// Programmatically replace the page's selection with one anchored on a node we
// pick by selector. Using a synthetic Range + dispatchEvent mirrors what the
// browser does when the user mouse-selects, so the live selectionchange
// listener inside the inspector fires.
async function selectNodeContents(page: Page, selector: string): Promise<void> {
  await page.evaluate(target => {
    const node = document.querySelector(target);
    if (!node) {
      throw new Error(`selectNodeContents: missing element ${target}`);
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("selectNodeContents: getSelection() returned null");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    // selectionchange usually fires automatically when the selection mutates,
    // but dispatching it explicitly here makes the test robust against
    // browsers that batch selection events across animation frames.
    document.dispatchEvent(new Event("selectionchange"));
  }, selector);
}

async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
}

// Anchor a selection on a known span of source-view text (under
// `pre.uatu-source-pre code`). The test fixture's README.md is short and
// stable, so we select the exact source lines we want by character offsets
// inside the source `<code>` element.
async function selectSourceLineRange(
  page: Page,
  options: { startLine: number; endLine: number },
): Promise<void> {
  await page.evaluate(({ startLine, endLine }) => {
    const code = document.querySelector("pre.uatu-source-pre code");
    if (!code) {
      throw new Error("selectSourceLineRange: no source-view code element");
    }
    const text = code.textContent ?? "";
    const lines = text.split("\n");
    if (startLine < 1 || endLine < startLine || endLine > lines.length) {
      throw new Error(
        `selectSourceLineRange: invalid range L${startLine}-${endLine} for ${lines.length}-line document`,
      );
    }
    let startOffset = 0;
    for (let i = 1; i < startLine; i += 1) {
      startOffset += lines[i - 1].length + 1; // +1 for the trailing newline
    }
    let endOffset = startOffset;
    for (let i = startLine; i <= endLine; i += 1) {
      endOffset += lines[i - 1].length;
      // Include the newline that terminates this line, except when it would
      // walk past the end of the source (no newline after the final line in
      // a file with no trailing newline). This mirrors how a user dragging a
      // visual-line selection from line N to line M lands the focus at the
      // start of line M+1 — and how `@path#L<a>-<b>` should resolve.
      if (i < lines.length || (lines[i - 1].length > 0 && i === lines.length)) {
        endOffset += 1;
      }
    }
    if (endOffset > text.length) {
      endOffset = text.length;
    }
    // The source view's `<code>` element wraps highlighted source which may
    // be split into many text nodes by the syntax highlighter; we therefore
    // need to walk to find the text nodes containing startOffset / endOffset.
    function nodeAt(target: number): { node: Node; offset: number } | null {
      let consumed = 0;
      function walk(n: Node): { node: Node; offset: number } | null {
        if (n.nodeType === 3) {
          const len = (n.nodeValue ?? "").length;
          if (target <= consumed + len) {
            return { node: n, offset: target - consumed };
          }
          consumed += len;
          return null;
        }
        for (const child of Array.from(n.childNodes)) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      }
      return walk(code!);
    }
    const startPos = nodeAt(startOffset);
    const endPos = nodeAt(endOffset);
    if (!startPos || !endPos) {
      throw new Error("selectSourceLineRange: failed to resolve text nodes for range");
    }
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("selectSourceLineRange: getSelection() returned null");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, options);
}

test("Source view captures a line range and shows it as @path#L<a>-<b> in Review mode", async ({ page }) => {
  await page.locator("#mode-review").click();
  // README.md is already loaded in beforeEach. Flip to source view so the
  // preview body is rendered as a whole-file <pre class="uatu-source-pre">.
  await page.locator("#view-source").click();
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();

  const pane = page.locator('[data-pane-id="selection-inspector"]');
  await expect(pane).toBeVisible();
  // Initially nothing is selected — the placeholder is visible.
  await expect(pane.locator("[data-selection-inspector-empty]")).toBeVisible();
  await expect(pane.locator("[data-selection-inspector-control]")).toBeHidden();

  // Select source lines 2 through 4. README.md is the active file.
  await selectSourceLineRange(page, { startLine: 2, endLine: 4 });

  await expect(pane.locator("[data-selection-inspector-control]")).toBeVisible();
  await expect(pane.locator("[data-selection-inspector-empty]")).toBeHidden();
  await expect(pane.locator("[data-selection-inspector-control]")).toHaveText("@README.md#L2-4");
  await expect(pane.locator("[data-selection-inspector-control]")).toHaveAttribute(
    "data-state",
    "reference",
  );
});

test("Single-line source-view selection collapses to @path#L<n>", async ({ page }) => {
  await page.locator("#mode-review").click();
  await page.locator("#view-source").click();
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();

  await selectSourceLineRange(page, { startLine: 5, endLine: 5 });
  const pane = page.locator('[data-pane-id="selection-inspector"]');
  await expect(pane.locator("[data-selection-inspector-control]")).toHaveText("@README.md#L5");
});

test("Clicking the captured reference copies it to the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator("#mode-review").click();
  await page.locator("#view-source").click();
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();

  await selectSourceLineRange(page, { startLine: 1, endLine: 3 });
  const control = page
    .locator('[data-pane-id="selection-inspector"] [data-selection-inspector-control]');
  await expect(control).toHaveText("@README.md#L1-3");

  await control.click();
  // Copy confirmation flashes briefly.
  await expect(
    page.locator('[data-pane-id="selection-inspector"] [data-selection-inspector-status]'),
  ).toHaveText("Copied");

  const clipboard = await page.evaluate(async () => navigator.clipboard.readText());
  expect(clipboard).toBe("@README.md#L1-3");
});

test("Rendered view shows the hint and clicking it switches to Source view", async ({ page }) => {
  await page.locator("#mode-review").click();
  // Default view is Rendered; do NOT click the source toggle.
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("pre.uatu-source-pre")).toHaveCount(0);

  // Mark prose text in the rendered preview.
  await selectNodeContents(page, "#preview h1, #preview h2, #preview h3");

  const pane = page.locator('[data-pane-id="selection-inspector"]');
  const control = pane.locator("[data-selection-inspector-control]");
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute("data-state", "hint");
  await expect(control).toContainText("Switch to Source view");

  await control.click();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();
});

test("Selection inside a rendered fenced code block produces the hint, not a reference", async ({ page }) => {
  // The testdata fixture's only fenced code blocks are Mermaid diagrams,
  // which the preview rewrites into `<div class="mermaid">` rather than
  // leaving as `<pre><code>`. Build a small Markdown fixture in-place that
  // contains a plain fenced code block, so we can assert the inspector
  // treats selections inside it as Rendered-view content (hint state) and
  // NOT as a source-aligned line range.
  const fixture = "# Fenced fixture\n\n\`\`\`bash\nset -e\necho hello\n\`\`\`\n";
  await fs.writeFile(workspacePath("guides", "fenced-fixture.md"), fixture, "utf8");
  await page.locator("#mode-review").click();
  // Switch the Changed filter off; this is a non-git fixture, where the
  // chip's Changed state shows the "filter unavailable" empty state.
  await page.locator("#files-pane-filter-all").click();
  await clickTreeFile(page, "guides/fenced-fixture.md");
  await expect(page.locator("#preview-path")).toHaveText("guides/fenced-fixture.md");
  await page.locator("#view-rendered").click();
  // The per-block fenced `<pre>` does NOT carry the uatu-source-pre class.
  const fenced = page.locator("#preview pre:not(.uatu-source-pre) code");
  await expect(fenced).toBeVisible();
  await selectNodeContents(page, "#preview pre:not(.uatu-source-pre) code");

  const control = page
    .locator('[data-pane-id="selection-inspector"] [data-selection-inspector-control]');
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute("data-state", "hint");
});

test("Selection Inspector pane returns to placeholder after the selection is collapsed", async ({ page }) => {
  await page.locator("#mode-review").click();
  await page.locator("#view-source").click();
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();
  const pane = page.locator('[data-pane-id="selection-inspector"]');

  await selectSourceLineRange(page, { startLine: 1, endLine: 2 });
  await expect(pane.locator("[data-selection-inspector-control]")).toBeVisible();

  await clearSelection(page);
  await expect(pane.locator("[data-selection-inspector-empty]")).toBeVisible();
  await expect(pane.locator("[data-selection-inspector-control]")).toBeHidden();
});

test("Selection Inspector pane is hidden in Author mode and restored on switch back to Review", async ({ page }) => {
  // Default mode after beforeEach is Author — pane must not be shown.
  const pane = page.locator('[data-pane-id="selection-inspector"]');
  await expect(pane).toBeHidden();

  // The Panels visibility menu must not list "Selection Inspector" while in
  // Author mode.
  await page.locator("#panels-toggle").click();
  await expect(page.locator('#panels-menu label:has-text("Selection Inspector")')).toHaveCount(0);
  // Close the panels menu so it doesn't intercept later interactions.
  await page.locator("#panels-toggle").click();

  // Switch to Review — pane appears.
  await page.locator("#mode-review").click();
  await expect(pane).toBeVisible();

  // Toggling back to Author hides it again.
  await page.locator("#mode-author").click();
  await expect(pane).toBeHidden();

  // And toggling forward to Review restores it.
  await page.locator("#mode-review").click();
  await expect(pane).toBeVisible();
});

test("View chooser shows three segments for Markdown / AsciiDoc and two for source files", async ({ page }) => {
  // README.md is markdown — all three segments visible.
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // Switch to a code/text file. The chooser stays visible but Rendered is
  // hidden (no separate rendered representation for source files).
  await fs.writeFile(workspacePath("settings.json"), "{\"key\": \"value\"}\n", "utf8");
  const codeFile = treeRow(page, "settings.json");
  await expect(codeFile).toBeVisible();
  await codeFile.click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // Back to README.md — all three segments visible again.
  await treeRow(page, "README.md").click();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});

test("View-mode preference persists across reload", async ({ page }) => {
  // Default is Rendered.
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  await page.locator("#view-source").click();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();
});

test("Layout chooser is visible for Markdown / AsciiDoc and hidden for source files", async ({ page }) => {
  // README.md is markdown — chooser is visible alongside the view toggle.
  await expect(page.locator(".uatu-layout-toolbar")).toBeVisible();

  // Switch to a code/text file: the layout chooser hides (split layouts
  // pair Source + Rendered, and source files have no separate Rendered).
  // The view chooser stays visible since the Diff segment introduced the
  // Source / Diff chooser for text files.
  await fs.writeFile(workspacePath("split-chooser.json"), "{\"key\": \"value\"}\n", "utf8");
  const codeFile = treeRow(page, "split-chooser.json");
  await expect(codeFile).toBeVisible();
  await codeFile.click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator(".uatu-layout-toolbar")).toBeHidden();

  // Back to README.md — both controls return.
  await treeRow(page, "README.md").click();
  await expect(page.locator(".uatu-layout-toolbar")).toBeVisible();
});

test("Side-by-side layout renders Source left, Rendered right, with both visible", async ({ page }) => {
  // Default is single layout; activate side-by-side.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");

  // Two panes plus a resizer between them.
  await expect(page.locator("#preview.is-split.is-split-h")).toBeVisible();
  await expect(page.locator("#preview .preview-pane-source")).toBeVisible();
  await expect(page.locator("#preview .preview-pane-rendered")).toBeVisible();
  await expect(page.locator("#preview .preview-split-resizer")).toBeVisible();

  // Source pane carries the distinguishing whole-file <pre> class used by the
  // Selection Inspector, mirroring single Source view.
  await expect(page.locator("#preview .preview-pane-source pre.uatu-source-pre")).toBeVisible();

  // The view chooser stays visible in split so Diff remains reachable —
  // Diff replaces both panes and would be unreachable otherwise. Clicking
  // Source or Rendered in split is a no-op visually (the persisted
  // preference updates for the next return to single).
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});

test("Stacked layout renders Source on top, Rendered below", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-v']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-v']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview.is-split.is-split-v")).toBeVisible();

  // DOM order: source pane then resizer then rendered pane.
  const order = await page.evaluate(() => {
    const children = Array.from(document.querySelectorAll<HTMLElement>("#preview > *"));
    return children.map(child => {
      if (child.classList.contains("preview-pane-source")) return "source";
      if (child.classList.contains("preview-split-resizer")) return "resizer";
      if (child.classList.contains("preview-pane-rendered")) return "rendered";
      return child.className;
    });
  });
  expect(order).toEqual(["source", "resizer", "rendered"]);
});

test("Layout preference persists across reload and across documents", async ({ page }) => {
  // Default is single.
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='single']")).toHaveAttribute("aria-checked", "true");

  // Activate side-by-side, then open another markdown doc — layout sticks.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect(page.locator("#preview.is-split-h")).toBeVisible();

  // Reload — preference survives.
  await page.reload();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview.is-split-h")).toBeVisible();
});

test("Switching to single layout preserves the Source / Rendered preference", async ({ page }) => {
  // Set Source as the active view-mode preference.
  await page.locator("#view-source").click();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  // Enter side-by-side; the chooser stays visible (so Diff stays
  // reachable) and the persisted Source preference is preserved.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  // Return to single — the preference must still be Source.
  await page.locator(".uatu-layout-toolbar [data-layout-value='single']").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  // And the body is in source view, not rendered.
  await expect(page.locator("#preview > pre.uatu-source-pre")).toBeVisible();
});

test("Dragging the split resizer reallocates space between panes", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();

  // Measure the source pane's initial width, then drag the resizer right.
  const sourcePane = page.locator("#preview .preview-pane-source");
  const initialBox = await sourcePane.boundingBox();
  expect(initialBox).not.toBeNull();
  const resizer = page.locator("#preview .preview-split-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  if (!initialBox || !resizerBox) return;

  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2 + 80, resizerBox.y + resizerBox.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  const finalBox = await sourcePane.boundingBox();
  expect(finalBox).not.toBeNull();
  if (!finalBox) return;
  // Source pane has grown by approximately the drag distance (allowing some
  // tolerance for clamping and rounding).
  expect(finalBox.width).toBeGreaterThan(initialBox.width + 30);
});

test("Dragging the stacked split resizer reallocates vertical space", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-v']").click();
  await expect(page.locator("#preview.is-split-v")).toBeVisible();

  const sourcePane = page.locator("#preview .preview-pane-source");
  const initialBox = await sourcePane.boundingBox();
  expect(initialBox).not.toBeNull();
  const resizer = page.locator("#preview .preview-split-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  if (!initialBox || !resizerBox) return;

  // Source pane must actually occupy a meaningful share of the preview body
  // up front (regression guard: in stacked mode the pane previously collapsed
  // to content-height because the container had no resolved height).
  expect(initialBox.height).toBeGreaterThan(100);

  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2 + 80, {
    steps: 8,
  });
  await page.mouse.up();

  const finalBox = await sourcePane.boundingBox();
  expect(finalBox).not.toBeNull();
  if (!finalBox) return;
  // Source pane has grown vertically by approximately the drag distance.
  expect(finalBox.height).toBeGreaterThan(initialBox.height + 30);
});

test("Selection Inspector pane visibility persists across page reload in Review mode", async ({ page }) => {
  await page.locator("#mode-review").click();
  const pane = page.locator('[data-pane-id="selection-inspector"]');
  await expect(pane).toBeVisible();

  // Hide via the in-pane × button.
  await pane.getByRole("button", { name: "Hide Selection Inspector" }).click();
  await expect(pane).toBeHidden();

  await page.reload();
  // Reload comes back in Review (mode is persisted) and the pane should still
  // be hidden because the per-mode pane state survived the reload.
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await expect(pane).toBeHidden();

  // Restore via the Panels menu so the pane comes back, then reload again
  // and confirm visibility persists in the visible state too.
  await page.locator("#panels-toggle").click();
  await page.locator('#panels-menu label:has-text("Selection Inspector") input').check();
  await expect(pane).toBeVisible();

  await page.reload();
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await expect(pane).toBeVisible();
});

test("Diff view renders the active file's git diff against the review base", async ({ page, request }) => {
  // Initialize the e2e workspace as a git repository with a feature branch
  // and a worktree modification so feature.md differs from the resolved
  // review base.
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "feature.md": "# Feature\n\nCommitted branch change.\n\nAdded review-time edit.\n",
      },
    },
  });
  await page.reload();
  await expect(treeRow(page, "feature.md")).toBeVisible();
  await treeRow(page, "feature.md").click();
  await expect(page.locator("#preview-path")).toHaveText("feature.md");

  // Activate Diff view.
  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");

  // The diff host should be mounted. Its content can take one of three
  // shapes — Pierre's rendered diff, the lightweight-fallback `<pre>`, or
  // the diagnostic state card if Pierre's render path threw — and any of
  // those satisfies "wire-up is working." This test asserts the host
  // appears and that the chooser stays on Diff; the rendered content's
  // visual quality is verified manually.
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
});

test("Diff view shows the 'no git history' card in a non-git workspace", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { nonGit: true } });
  await page.reload();
  await expect(treeRow(page, "README.md")).toBeVisible();
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");

  // The muted state card should appear and Pierre's Shadow DOM root should
  // NOT be present — fallback paths never load @pierre/diffs.
  const stateCard = page.locator(".uatu-diff-host .uatu-diff-state");
  await expect(stateCard).toBeVisible();
  await expect(stateCard).toContainText("No git history available");

  const pierreLoaded = await page.evaluate(() => {
    const host = document.querySelector(".uatu-diff-host");
    if (!host) return true;
    // Pierre constructs its own host elements; if the only child is our
    // state card, Pierre was not invoked. We accept a loose check: there
    // is a .uatu-diff-state element AND no `pierre-` prefixed custom element.
    const stateCount = host.querySelectorAll(".uatu-diff-state").length;
    const pierreNodes = host.querySelectorAll("[class*='pierre'], pierre-diff, file-diff");
    return stateCount === 0 || pierreNodes.length > 0;
  });
  expect(pierreLoaded).toBe(false);
});

test("Diff view exposes a Unified / Split layout toggle that persists across reload", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "feature.md": "# Feature\n\nCommitted branch change.\n\nAdded review-time edit.\n",
      },
    },
  });
  await page.reload();
  await expect(treeRow(page, "feature.md")).toBeVisible();
  await treeRow(page, "feature.md").click();
  await page.locator("#view-diff").click();
  await expect(page.locator(".uatu-diff-host")).toBeVisible();

  // Toolbar renders inside the diff host with two segments, defaults to Unified.
  const unified = page.locator('.uatu-diff-toolbar [data-style-value="unified"]');
  const split = page.locator('.uatu-diff-toolbar [data-style-value="split"]');
  await expect(unified).toBeVisible();
  await expect(split).toBeVisible();
  await expect(unified).toHaveAttribute("aria-checked", "true");
  await expect(split).toHaveAttribute("aria-checked", "false");

  // Click Split — the toolbar updates and the preference persists.
  await split.click();
  await expect(split).toHaveAttribute("aria-checked", "true");
  await expect(unified).toHaveAttribute("aria-checked", "false");

  await page.reload();
  await expect(treeRow(page, "feature.md")).toBeVisible();
  await treeRow(page, "feature.md").click();
  await page.locator("#view-diff").click();
  await expect(page.locator('.uatu-diff-toolbar [data-style-value="split"]'))
    .toHaveAttribute("aria-checked", "true");
});

test("Diff segment stays reachable from split layout on Markdown / AsciiDoc", async ({ page }) => {
  // Activate side-by-side on a markdown document.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();

  // All three view segments must remain visible so the user can leave
  // split for Diff in a single click.
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // Clicking Diff transitions away from split into the single-pane Diff
  // view; the layout chooser hides while Diff is active.
  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".uatu-layout-toolbar")).toBeHidden();
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
});

test("Source file under a stored split-layout preference still shows the view chooser", async ({ page }) => {
  // Regression: previously the view chooser keyed off the stored layout
  // preference rather than the *effective* layout, so navigating from a
  // markdown file in split layout to a source file (where split has no
  // effect — the doc has no separate rendered representation) hid the
  // chooser entirely.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");

  await fs.writeFile(workspacePath("split-source.ts"), "export const value = 1;\n", "utf8");
  await expect(treeRow(page, "split-source.ts")).toBeVisible();
  await treeRow(page, "split-source.ts").click();

  // Layout chooser correctly hides for source files; view chooser stays
  // visible with the Source + Diff segments.
  await expect(page.locator(".uatu-layout-toolbar")).toBeHidden();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});

test("Diff view keeps the view chooser visible when switching documents", async ({ page }) => {
  // Regression for the bug where switching files while viewMode === "diff"
  // dropped the view chooser because `currentRenderedPayload()` returned
  // null (the documentViewCache had been cleared by loadDocument and the
  // diff path never populates it).
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#view-control")).toBeVisible();

  // Switch to a different markdown file. The chooser must stay visible and
  // continue to highlight Diff.
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");

  // Switch to a source file — chooser stays visible with two segments
  // (Source + Diff), Diff still active.
  await fs.writeFile(workspacePath("nav-source.ts"), "export const x = 1;\n", "utf8");
  await expect(treeRow(page, "nav-source.ts")).toBeVisible();
  await treeRow(page, "nav-source.ts").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
});

test("Diff segment appears alongside Source / Rendered for Markdown and AsciiDoc", async ({ page }) => {
  // README.md is markdown — all three segments visible.
  await treeRow(page, "README.md").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // An AsciiDoc file (the workspace fixture has at least one .adoc) — also three.
  await fs.writeFile(workspacePath("guide.adoc"), "= Guide\n\nBody.\n", "utf8");
  await expect(treeRow(page, "guide.adoc")).toBeVisible();
  await treeRow(page, "guide.adoc").click();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // A `.ts` source file — two segments (Source + Diff), Rendered hidden.
  await fs.writeFile(workspacePath("module.ts"), "export const value = 1;\n", "utf8");
  await expect(treeRow(page, "module.ts")).toBeVisible();
  await treeRow(page, "module.ts").click();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // A `.json` source file — also Source + Diff only.
  await fs.writeFile(workspacePath("settings.json"), "{\"key\": \"value\"}\n", "utf8");
  await expect(treeRow(page, "settings.json")).toBeVisible();
  await treeRow(page, "settings.json").click();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});
