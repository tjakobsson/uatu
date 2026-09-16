// Evidence a UI test produces for a reviewer: screenshots and measurement
// reports. Every capture lands in the test's Playwright output directory
// (test-results/, gitignored) and is attached to the HTML report. Tests
// never write into a change's planning folder: that folder moves to the
// archive when the change ships, and a test that named it broke CI for
// every later pull request. A change's screenshots folder is assembled at
// PR time instead, by running the relevant suite with
// UATU_E2E_SCREENSHOTS_DIR=<folder>, which copies every capture there too.
// tests/evidence-discipline.test.ts enforces the rule.

import { copyFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { Page, TestInfo } from "@playwright/test";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain",
};

/** Where a piece of evidence is written: the test's own output directory. */
export function evidencePath(testInfo: TestInfo, fileName: string): string {
  return testInfo.outputPath(fileName);
}

/** Attaches a written evidence file to the report and, when
 *  UATU_E2E_SCREENSHOTS_DIR is set, copies it there for the PR. */
export async function recordEvidence(testInfo: TestInfo, filePath: string): Promise<void> {
  const fileName = path.basename(filePath);
  const contentType = CONTENT_TYPES[path.extname(fileName)] ?? "application/octet-stream";
  await testInfo.attach(path.basename(fileName, path.extname(fileName)), { path: filePath, contentType });
  const dir = process.env.UATU_E2E_SCREENSHOTS_DIR;
  if (!dir) return;
  const resolved = path.resolve(dir);
  mkdirSync(resolved, { recursive: true });
  copyFileSync(filePath, path.join(resolved, fileName));
}

/** A screenshot once fonts have settled, with animations and the caret
 *  suppressed so before/after pairs line up. */
export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const target = evidencePath(testInfo, `${name}.png`);
  await page.screenshot({ path: target, animations: "disabled", caret: "hide" });
  await recordEvidence(testInfo, target);
}

/** A text report (frame traces, work measurements) kept as evidence. */
export async function saveEvidence(testInfo: TestInfo, fileName: string, content: string): Promise<void> {
  const target = evidencePath(testInfo, fileName);
  await writeFile(target, content);
  await recordEvidence(testInfo, target);
}
