import { expect, test } from "bun:test";

test("composer has one real picker, no Options or delivery menus, and described keyboard access", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(html).not.toContain('id="chat-options-');
  expect(html).not.toContain('id="chat-header-options"');
  expect(html).not.toContain('id="chat-delivery-');
  expect(html.match(/id="chat-configuration-trigger"/g)).toHaveLength(1);
  expect(html).toContain('aria-describedby="chat-send-help"');
  expect(html).toContain('id="chat-send-help"');
  expect(html).not.toContain('id="chat-continue-workers"');
  expect(html).not.toContain("What continues?");
  expect(html).toContain('id="chat-plan-usage"');
});
