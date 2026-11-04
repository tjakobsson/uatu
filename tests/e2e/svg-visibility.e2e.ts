import { promises as fs } from "node:fs";
import { test, expect, standardBeforeEach } from "./fixtures";
import { workspacePath } from "./config";
import { openTreeFile } from "./tree-helpers";
import { afterAnimationFrames, flushPageRequests, naturalWidth, recordDocumentFrames, waitForAppliedDocumentFrame } from "./sync-helpers";

const animatedSvg = (width = 80) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="80"><rect width="${width}" height="80" fill="red"><animate attributeName="fill" values="red;blue;red" dur="1s" repeatCount="indefinite"/></rect></svg>`;

test.beforeEach(async ({ page, request, isMobile }) => {
  if (!isMobile) await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("SVGs in the file tree are not fetched until opened", async ({ page, request }) => {
  const extras = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`animation-${i}.svg`, animatedSvg()]));
  await request.post("/__e2e/reset", { data: { extras } });
  const requests: string[] = [];
  page.on("request", request => {
    if (/\/animation-\d+\.svg/.test(request.url())) requests.push(new URL(request.url()).pathname);
  });
  await page.goto("/");
  await openTreeFile(page, "README.md");
  await afterAnimationFrames(page);
  await flushPageRequests(page);
  expect(requests).toEqual([]);

  await openTreeFile(page, "animation-0.svg");
  await expect.poll(() => naturalWidth(page, "#preview .image-preview img")).toBe(80);
  await flushPageRequests(page);
  expect([...new Set(requests)]).toEqual(["/animation-0.svg"]);
});

for (const browserName of ["chromium", "webkit"] as const) test.describe(browserName, () => {
  test.use({ page: async ({ playwright, baseURL, viewport, hasTouch, isMobile }, use) => {
    const browser = await playwright[browserName].launch();
    try {
      await use(await browser.newPage({ baseURL, viewport, hasTouch, isMobile }));
    } finally {
      await browser.close();
    }
  } });

  for (const layout of ["single", "split"] as const) test(`embedded SVGs load only on screen and unload when scrolled away in ${layout} layout`, async ({ page, request }) => {
    const padding = Array.from({ length: 120 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
    await request.post("/__e2e/reset", { data: { extras: {
      "top.svg": animatedSvg(),
      "bottom.svg": animatedSvg(),
      "images.md": `# Images\n\n![top](./top.svg)\n\n${padding}\n\n![bottom](./bottom.svg)\n`,
    } } });
    const requests: string[] = [];
    page.on("request", request => {
      if (/\/(top|bottom)\.svg/.test(request.url())) requests.push(new URL(request.url()).pathname);
    });
    await page.goto("/");
    await openTreeFile(page, "images.md");
    if (layout === "split") {
      await page.locator('.uatu-layout-toolbar [data-layout-value="split-h"]').click();
      await expect(page.locator("#preview .preview-pane-rendered")).toBeVisible();
    }
    const top = page.locator('#preview img[alt="top"]');
    const bottom = page.locator('#preview img[alt="bottom"]');
    await expect.poll(() => naturalWidth(page, '#preview img[alt="top"]')).toBe(80);
    await afterAnimationFrames(page);
    const topSize = await top.boundingBox();
    await flushPageRequests(page);
    expect(requests).not.toContain("/bottom.svg");

    await bottom.scrollIntoViewIfNeeded();
    await expect(bottom).toHaveAttribute("src", /\/bottom\.svg\?revision=/);
    await expect.poll(() => naturalWidth(page, '#preview img[alt="bottom"]')).toBe(80);
    await expect(top).not.toHaveAttribute("src", /\/top\.svg/);
    const hiddenSize = await top.boundingBox();
    expect(hiddenSize?.width).toBe(topSize?.width);
    expect(hiddenSize?.height).toBe(topSize?.height);

    await top.scrollIntoViewIfNeeded();
    await expect(top).toHaveAttribute("src", /\/top\.svg\?revision=/);
    await expect(bottom).not.toHaveAttribute("src", /\/bottom\.svg/);
  });

  test("source-only image discovery does not load the SVGs it finds", async ({ page, request }) => {
    await request.post("/__e2e/reset", { data: { extras: {
      "hero.svg": animatedSvg(),
      "images.md": "# Images\n\n![hero](./hero.svg)\n",
    } } });
    await page.goto("/");
    await openTreeFile(page, "README.md");
    await page.locator("#view-source").click();
    const requests: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/hero.svg") requests.push(request.url());
    });
    const learned = page.waitForResponse(response => response.url().includes("images.md&view=rendered"));
    await openTreeFile(page, "images.md");
    await learned;
    await expect(page.locator("#preview .uatu-source-pre")).toBeVisible();
    await afterAnimationFrames(page);
    await flushPageRequests(page);
    expect(requests).toEqual([]);
  });

  test("an SVG at the clipping boundary loads when it enters the viewport", async ({ page, request }) => {
    const padding = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
    await request.post("/__e2e/reset", { data: { extras: {
      "edge.svg": animatedSvg(),
      "edge.md": `# Edge\n\n${padding}\n\n![edge](./edge.svg)\n`,
    } } });
    await page.goto("/");
    await openTreeFile(page, "edge.md");
    const image = page.locator('#preview img[alt="edge"]');
    const boundary = await image.evaluate(async element => {
      const image = element as HTMLImageElement;
      image.style.display = "block";
      image.style.width = "80px";
      image.style.height = "80px";
      const shell = document.querySelector<HTMLElement>(".preview-shell")!;
      const bottom = shell.getBoundingClientRect().top + shell.clientTop + shell.clientHeight;
      shell.scrollTop += image.getBoundingClientRect().top - bottom;
      // Correct fractional scroll rounding so the first intersection has
      // exactly zero area, rather than a sliver of visible pixels.
      image.style.transform = `translateY(${bottom - image.getBoundingClientRect().top}px)`;
      return await new Promise<{ intersecting: boolean; ratio: number }>(resolve => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect();
          resolve({ intersecting: entry!.isIntersecting, ratio: entry!.intersectionRatio });
        });
        observer.observe(image);
      });
    });
    expect(boundary).toEqual({ intersecting: true, ratio: 0 });
    await page.locator(".preview-shell").evaluate(shell => { shell.scrollTop += 1; });
    await expect(image).toHaveAttribute("src", /\/edge\.svg\?revision=/);
    await expect.poll(() => naturalWidth(page, '#preview img[alt="edge"]')).toBe(80);
  });

  test.describe("touch preview", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("a hidden touch preview unloads its SVG and restores the latest revision", async ({ page, request }) => {
      await request.post("/__e2e/reset", { data: { extras: { "hero.svg": animatedSvg() } } });
      await recordDocumentFrames(page);
      const requests: string[] = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/hero.svg") requests.push(request.url());
      });
      await page.goto("/");
      await page.locator("#touch-tab-files").click();
      await openTreeFile(page, "hero.svg");
      const image = page.locator("#preview .image-preview img");
      await expect.poll(() => naturalWidth(page, "#preview .image-preview img")).toBe(80);
      await image.evaluate(el => { el.dataset.e2eMounted = "1"; });
      await page.locator("#touch-tab-files").click();
      await expect(image).not.toHaveAttribute("src", /\/hero\.svg/);

      await flushPageRequests(page);
      const before = requests.length;
      await fs.writeFile(workspacePath("hero.svg"), animatedSvg(120));
      await waitForAppliedDocumentFrame(page, { changed: "hero.svg" });
      await flushPageRequests(page);
      expect(requests).toHaveLength(before);
      await expect(image).not.toHaveAttribute("src", /\/hero\.svg/);

      await page.locator("#touch-tab-preview").click();
      await expect(image).toHaveAttribute("src", /\/hero\.svg\?revision=/);
      await expect.poll(() => naturalWidth(page, "#preview .image-preview img")).toBe(120);
      await expect(image).toHaveAttribute("data-e2e-mounted", "1");
    });
  });
});
