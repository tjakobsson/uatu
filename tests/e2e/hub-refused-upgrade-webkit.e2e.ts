// A WebSocket upgrade the Hub refuses, from WebKit. Chromium drops a refused
// upgrade's connection; WebKit keeps it and sends its next request on it.
// The media boundary used to keep that connection as a raw tunnel tied to the
// refused upgrade, so the next fetch was answered as the upgrade's URL. A
// source-run Hub's dev bundle hit it on every boot: its HMR client's refused
// `/_bun/hmr` took the shell's state fetch with it, and the shell never
// booted.
//
// `browserName` cannot be overridden per describe (it forces a new worker),
// so this journey lives in its own file.

import { test, expect } from "./hub-fixtures";

test.use({ browserName: "webkit" });

test("after a refused WebSocket upgrade, the page's next fetches get their own answers", async ({ hub, hubContext }) => {
  const page = await hubContext.newPage();
  const sessionUrl = hub.workspaces[0]!.sessionUrl;
  await page.goto(sessionUrl);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

  const statuses = await page.evaluate(async stateUrl => {
    const answers: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise<void>(resolve => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/_bun/hmr`);
        socket.onerror = socket.onclose = () => resolve();
      });
      answers.push((await fetch(stateUrl, { cache: "no-store" })).status);
    }
    return answers;
  }, new URL("api/state", sessionUrl).href);
  expect(statuses).toEqual([200, 200, 200]);
});
