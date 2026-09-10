import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { confirmAuthenticatedHubContext, initHubNav, invalidateAuthenticatedHubContext, isHubAvailable } from "./hub-nav";
import { resetAppBasePathForTests } from "../shared/app-url";

test("authenticated context is immediate and a pre-confirmation probe 401 cannot revoke it", async () => {
  const originals = new Map(["document", "window", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const dom = parseHTML('<html><head><meta name="uatu-base-path" content="/s/atlas/"></head><body><div id="hub-control"><button id="hub-toggle"></button><div id="hub-menu"></div><span id="hub-current"></span></div></body></html>');
  const pending: Array<(response: Response) => void> = [];
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: dom.document });
    Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => new Promise<Response>(resolve => pending.push(resolve)) });
    resetAppBasePathForTests();
    invalidateAuthenticatedHubContext();
    initHubNav();
    expect(pending.length).toBeGreaterThan(0);
    expect(isHubAvailable()).toBe(false);
    confirmAuthenticatedHubContext();
    expect(isHubAvailable()).toBe(true);
    for (const resolve of pending) resolve(new Response(null, { status: 401 }));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(isHubAvailable()).toBe(true);
    // A current authentication rejection still revokes the confirmed context.
    pending.length = 0;
    initHubNav();
    for (const resolve of pending) resolve(new Response(null, { status: 401 }));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(isHubAvailable()).toBe(false);
    confirmAuthenticatedHubContext();
    invalidateAuthenticatedHubContext();
    expect(isHubAvailable()).toBe(false);
  } finally {
    invalidateAuthenticatedHubContext();
    resetAppBasePathForTests();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
