import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
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

// Lazy mermaid rendering only draws diagrams near the viewport, and an
// instant jump to the bottom can skip PAST middle diagrams without the
// IntersectionObserver ever seeing them intersect. Sweep the preview shell
// one viewport per poll pass (wrapping back to the top) so every diagram
// gets a frame within the observation margin, and wait until all rendered.
async function expectAllDiagramsRendered(page: Page, count: number): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>(".preview-shell");
        if (shell) {
          const atBottom = shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 4;
          shell.scrollTop = atBottom ? 0 : shell.scrollTop + shell.clientHeight;
        }
        return document.querySelectorAll("#preview .mermaid svg").length;
      }),
    )
    .toBe(count);
}

test("off-screen diagrams stay pending until scrolled toward, then render", async ({ page, request }) => {
  // A diagram at the top, a long text run, and a diagram far below the
  // fold — well past the observer's ahead-of-viewport margin.
  const filler = Array.from({ length: 220 }, (_, i) => `Filler paragraph ${i} keeps the second diagram far below the fold.`).join("\n\n");
  await request.post("/__e2e/reset", {
    data: {
      dirty: {
        "lazy-diagrams.md": [
          "# Lazy Diagrams",
          "```mermaid",
          "graph TD; Top-->Rendered;",
          "```",
          filler,
          "```mermaid",
          "graph TD; Bottom-->Lazy;",
          "```",
          "",
        ].join("\n\n"),
      },
    },
  });
  await page.reload();
  await treeRow(page, "lazy-diagrams.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Lazy Diagrams");

  // The top diagram renders; the bottom one stays a pending placeholder.
  await expect(page.locator("#preview .mermaid").first().locator("svg")).toBeVisible();
  const bottom = page.locator("#preview .mermaid").last();
  await expect(bottom).toHaveClass(/mermaid-pending/);
  expect(await bottom.locator("svg").count()).toBe(0);

  // Scrolling the placeholder toward the viewport renders it.
  await bottom.scrollIntoViewIfNeeded();
  await expect(bottom.locator("svg")).toBeVisible();
  await expect(bottom).not.toHaveClass(/mermaid-pending/);
  await expect(bottom.locator("button.mermaid-trigger")).toBeVisible();
});

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
  await expectAllDiagramsRendered(page, 5);

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
  await expectAllDiagramsRendered(page, 5);

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
  await expectAllDiagramsRendered(page, 5);

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
  await expectAllDiagramsRendered(page, 5);

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
  await expectAllDiagramsRendered(page, 5);

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
  await expectAllDiagramsRendered(page, 5);

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
