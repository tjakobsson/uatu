import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { hubReturnBar, hubReturnKey, mountHubReturn } from "./hub-return";

const key = hubReturnKey("alice");

async function mounted(stored: unknown, workspaces: unknown[]) {
  const { document, window } = parseHTML(`<main>${hubReturnBar}<nav></nav></main>`);
  const values = new Map<string, string>(stored === undefined ? [] : [[key, JSON.stringify(stored)]]);
  Object.assign(window, {
    localStorage: { getItem: (name: string) => values.get(name) ?? null },
    fetch: async () => Response.json({ workspaces }),
  });
  mountHubReturn(document as unknown as Document, window as unknown as Window, key);
  // The control renders once the Hub's state has answered.
  await new Promise(resolve => setTimeout(resolve, 10));
  return [...document.querySelectorAll("[data-hub-return]")] as unknown as HTMLElement[];
}

const location = { workspace: "atlas", name: "atlas", label: "atlas · #642 Add review", href: "/s/atlas/?pr=642&tab=files" };

test("shows the remembered location of a registered workspace, and says when it is stopped", async () => {
  const running = await mounted(location, [{ id: "atlas", running: true }]);
  for (const slot of running) {
    expect(slot.hidden).toBe(false);
    const link = slot.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(location.href);
    expect(link.getAttribute("aria-label")).toBe("Back to atlas · #642 Add review");
    expect(link.querySelector<HTMLElement>("[data-hub-return-stopped]")!.hidden).toBe(true);
  }
  const stopped = await mounted(location, [{ id: "atlas", running: false }]);
  expect(stopped[0]!.querySelector("a")!.getAttribute("aria-label")).toBe("Back to atlas · #642 Add review (stopped)");
  expect(stopped[0]!.querySelector<HTMLElement>("[data-hub-return-stopped]")!.hidden).toBe(false);
});

test("stays hidden with nothing remembered, a workspace gone or missing on disk, or a path outside its session", async () => {
  for (const control of await mounted(undefined, [])) expect(control.hidden).toBe(true);
  for (const control of await mounted(location, [{ id: "beacon", running: true }])) expect(control.hidden).toBe(true);
  for (const control of await mounted(location, [{ id: "atlas", running: false, availability: "missing" }])) expect(control.hidden).toBe(true);
  for (const href of ["https://evil.test/s/atlas/", "//evil.test/s/atlas/", "/s/beacon/", "/settings"]) {
    for (const control of await mounted({ ...location, href }, [{ id: "atlas", running: true }])) expect(control.hidden).toBe(true);
  }
});

test("the user scope keys the record per Hub user", () => {
  expect(hubReturnKey("alice")).not.toBe(hubReturnKey("bob"));
  expect(hubReturnKey("alice")).toBe(`uatu.hub.return-v1:${Buffer.from("alice").toString("base64url")}`);
});
