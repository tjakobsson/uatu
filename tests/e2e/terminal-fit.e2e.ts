import { expect, test } from "./fixtures";

// Coverage for fix-pane-fit-padding-clip: the rendered character grid
// (`.xterm-screen`) must fit entirely inside its pane host's clip box at any
// panel size. Regression: padding on `.terminal-pane-host` inflated
// FitAddon's measurement (computed height includes padding under border-box)
// so the grid gained one extra row that `overflow: hidden` cut in half at
// the pane edge.
//
// The panel's size is driven by the `--terminal-panel-height` /
// `--terminal-panel-width` custom properties on <html> — the same mechanism
// the drag resizer uses — so the sweep sets those directly with awkward odd
// pixel values and lets the ResizeObserver → fit() pipeline react.

async function bootWithTerminalCookie(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  await request.post("/__e2e/reset");
  const tokenResp = await request.get("/__e2e/terminal-token");
  const tokenBody = await tokenResp.json();
  if (!tokenBody.enabled) {
    test.skip(true, "terminal backend unavailable on this platform");
  }
  await page.goto(`/?t=${encodeURIComponent(tokenBody.token)}`);
  await page.evaluate(() => {
    try {
      window.sessionStorage.removeItem("uatu:terminal-visible");
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
}

async function openTerminal(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#terminal-toggle").click();
  await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
    timeout: 5000,
  });
}

type FitReport = {
  pane: number;
  hostTop: number;
  hostBottom: number;
  hostLeft: number;
  hostRight: number;
  screenTop: number;
  screenBottom: number;
  screenLeft: number;
  screenRight: number;
  screenHeight: number;
};

function measureFits(page: import("@playwright/test").Page): Promise<FitReport[]> {
  return page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll(".terminal-pane-host"));
    return hosts.map((host, index) => {
      const screen = host.querySelector(".xterm-screen");
      const h = host.getBoundingClientRect();
      const s = screen ? screen.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
      return {
        pane: index,
        hostTop: h.top,
        hostBottom: h.bottom,
        hostLeft: h.left,
        hostRight: h.right,
        screenTop: s.top,
        screenBottom: s.bottom,
        screenLeft: s.left,
        screenRight: s.right,
        screenHeight: s.height,
      };
    });
  });
}

// The host's border box IS the clip box (`overflow: hidden`, no padding or
// border on the host). 1px epsilon absorbs subpixel rounding; the bug this
// guards against overflowed by a large fraction of a cell (~10-17px).
const EPSILON = 1;

async function expectGridFitsHosts(page: import("@playwright/test").Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const reports = await measureFits(page);
        if (reports.length === 0) return "no panes";
        for (const r of reports) {
          // Degenerate grid = vacuous pass; require a real grid first.
          if (r.screenHeight < 50) return `pane ${r.pane}: grid not rendered yet`;
          if (r.screenBottom > r.hostBottom + EPSILON) {
            return `pane ${r.pane}: screen bottom ${r.screenBottom} overflows host bottom ${r.hostBottom}`;
          }
          if (r.screenRight > r.hostRight + EPSILON) {
            return `pane ${r.pane}: screen right ${r.screenRight} overflows host right ${r.hostRight}`;
          }
          if (r.screenTop < r.hostTop - EPSILON) {
            return `pane ${r.pane}: screen top ${r.screenTop} above host top ${r.hostTop}`;
          }
          if (r.screenLeft < r.hostLeft - EPSILON) {
            return `pane ${r.pane}: screen left ${r.screenLeft} left of host left ${r.hostLeft}`;
          }
        }
        return "fits";
      },
      { timeout: 5000, message: "xterm screen must fit inside its pane host clip box" },
    )
    .toBe("fits");
}

async function setPanelSize(
  page: import("@playwright/test").Page,
  axis: "height" | "width",
  px: number,
): Promise<void> {
  await page.evaluate(
    ({ axis, px }) => {
      document.documentElement.style.setProperty(`--terminal-panel-${axis}`, `${px}px`);
    },
    { axis, px },
  );
}

// Awkward odd sizes on purpose: the regression fired whenever
// (height mod cellHeight) landed in the wrong window, ~75% of arbitrary
// positions at the default font.
const HEIGHT_SWEEP = [223, 241, 263, 287, 311];
const WIDTH_SWEEP = [317, 353, 389];

test.describe("terminal fit: grid never clips at pane edges", () => {
  test("bottom dock, single pane: grid fits across a height sweep", async ({
    page,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    for (const px of HEIGHT_SWEEP) {
      await setPanelSize(page, "height", px);
      await expectGridFitsHosts(page);
    }
  });

  test("bottom dock, split panes: both grids fit across a height sweep", async ({
    page,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane-host")).toHaveCount(2);
    for (const px of HEIGHT_SWEEP) {
      await setPanelSize(page, "height", px);
      await expectGridFitsHosts(page);
    }
  });

  test("right dock, split panes: both grids fit across a width sweep", async ({
    page,
    request,
  }) => {
    await bootWithTerminalCookie(page, request);
    await openTerminal(page);
    await page.locator("#terminal-dock-toggle").click();
    await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "right");
    await page.locator("#terminal-split").click();
    await expect(page.locator(".terminal-pane-host")).toHaveCount(2);
    for (const px of WIDTH_SWEEP) {
      await setPanelSize(page, "width", px);
      await expectGridFitsHosts(page);
    }
  });
});
