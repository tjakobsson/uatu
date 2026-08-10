// The legacy service-worker cleanup's identification rule.
//
// Tested as a pure function over registration facts rather than through a
// service worker environment, because the cases worth guarding are the
// NEGATIVE ones — a neighbour's worker on a shared hub origin must survive —
// and those are exactly the ones a fresh browser profile can never exercise.

import { describe, expect, it } from "bun:test";
import { isLegacyUatuWorker } from "./pwa";

const ORIGIN = "https://uatu.example";

function facts(scopePath: string, scriptPath: string | null) {
  return {
    scope: `${ORIGIN}${scopePath}`,
    scriptURL: scriptPath === null ? null : `${ORIGIN}${scriptPath}`,
  };
}

describe("isLegacyUatuWorker", () => {
  it("matches the origin-root registration a direct load left behind", () => {
    expect(isLegacyUatuWorker(facts("/", "/sw.js"), "/")).toBe(true);
  });

  it("matches a base-path registration a hub session left behind", () => {
    expect(isLegacyUatuWorker(facts("/s/uatu/", "/s/uatu/sw.js"), "/s/uatu/")).toBe(true);
  });

  it("matches an origin-root registration even when the page is under a base path", () => {
    // A worker scoped to "/" controls the session's pages too, so leaving it
    // installed would leave the contract broken at the URL being loaded.
    expect(isLegacyUatuWorker(facts("/", "/sw.js"), "/s/uatu/")).toBe(true);
  });

  it("leaves a sibling session's registration alone", () => {
    expect(isLegacyUatuWorker(facts("/s/other/", "/s/other/sw.js"), "/s/uatu/")).toBe(false);
  });

  it("leaves a neighbour's worker at the origin root alone", () => {
    // The identifying half of the rule: same scope, script uatu never
    // registered. A hub origin hosts more than uatu.
    expect(isLegacyUatuWorker(facts("/", "/service-worker.js"), "/")).toBe(false);
  });

  it("leaves a worker whose script merely mentions sw.js alone", () => {
    expect(isLegacyUatuWorker(facts("/", "/vendor/nosw.js"), "/")).toBe(false);
  });

  it("leaves a neighbour's sw.js in another directory alone", () => {
    // A worker served from /other/sw.js can legally claim scope "/" with a
    // Service-Worker-Allowed header. uatu never registered from any directory
    // but its own scope root, so this is somebody else's worker — and a
    // suffix match on "/sw.js" would have taken it.
    expect(isLegacyUatuWorker(facts("/", "/other/sw.js"), "/")).toBe(false);
    expect(isLegacyUatuWorker(facts("/s/uatu/", "/s/uatu/nested/sw.js"), "/s/uatu/")).toBe(false);
  });

  it("requires the script to belong to the scope it was registered for", () => {
    // The old call was register(appUrl("/sw.js"), { scope: appBasePath() }),
    // so the two halves were always paired. A mismatched pair is not ours.
    expect(isLegacyUatuWorker(facts("/", "/s/uatu/sw.js"), "/s/uatu/")).toBe(false);
  });

  it("ignores a registration with no worker attached", () => {
    expect(isLegacyUatuWorker(facts("/", null), "/")).toBe(false);
  });

  it("tolerates a base path given without its trailing slash", () => {
    expect(isLegacyUatuWorker(facts("/s/uatu/", "/s/uatu/sw.js"), "/s/uatu")).toBe(true);
  });

  it("ignores unparseable values rather than throwing", () => {
    expect(isLegacyUatuWorker({ scope: "not a url", scriptURL: `${ORIGIN}/sw.js` }, "/")).toBe(false);
    expect(isLegacyUatuWorker({ scope: `${ORIGIN}/`, scriptURL: "not a url" }, "/")).toBe(false);
  });
});
