import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";

test("replacement batch action wraps enlarged fallback text within Pending", async ({ page }) => {
  // Linux and macOS resolve system-ui differently. Arial also exposes the
  // intrinsic-width failure on macOS without depending on the host's UI font.
  await page.setViewportSize({ width: 320, height: 844 });
  await page.setContent(`<html data-ui-mode="touch"><body>
    <div class="chat-queue-content" style="width:286px;font:30px Arial,sans-serif">
      <div class="chat-queue-batch"><button class="chat-queued-action">Send 1 paused steer now</button></div>
    </div>
  </body></html>`);
  await page.addStyleTag({ content: await readFile("src/styles.css", "utf8") });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const pane = page.locator(".chat-queue-content");
  const action = pane.getByRole("button", { name: "Send 1 paused steer now" });
  expect(await pane.evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(await pane.evaluate(node => node.clientWidth));
  const box = (await action.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await action.focus();
  await expect(action).toBeFocused();
  expect(await action.evaluate(node => {
    const box = node.getBoundingClientRect();
    return [box.left + 2, box.right - 2].every(x => node.contains(document.elementFromPoint(x, box.top + box.height / 2)));
  })).toBe(true);
});
