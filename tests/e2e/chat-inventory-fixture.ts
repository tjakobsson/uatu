import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";

export type ChatInventoryFixtureState = {
  unseenCount: number;
  announce?: boolean;
  selectedConversationDeleted?: boolean;
};

const execFileAsync = promisify(execFile);
let driverSource: Promise<string> | undefined;

async function bundledDriverSource(): Promise<string> {
  driverSource ??= (async () => {
    const entrypoint = path.resolve(process.cwd(), "tests/e2e/chat-inventory-fixture-driver.ts");
    const script = `
      const result = await Bun.build({
        entrypoints: [${JSON.stringify(entrypoint)}],
        target: "browser",
        format: "iife",
        write: false,
      });
      if (!result.success) {
        for (const log of result.logs) console.error(log.message);
        process.exit(1);
      }
      const output = result.outputs.find(candidate => candidate.kind === "entry-point");
      if (!output) throw new Error("fixture bundle did not produce an entry point");
      process.stdout.write(await output.text());
    `;
    const { stdout } = await execFileAsync("bun", ["-e", script], {
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  })();
  return driverSource;
}

export async function applyChatInventoryFixture(page: Page, state: ChatInventoryFixtureState): Promise<void> {
  await page.locator("html").evaluate((root, fixture) => {
    root.setAttribute("data-e2e-chat-inventory-fixture", JSON.stringify(fixture));
  }, state);
  await page.addScriptTag({ content: await bundledDriverSource() });
}
