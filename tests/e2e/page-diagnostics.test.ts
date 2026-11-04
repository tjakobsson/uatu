import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { instrumentContext } from "./page-diagnostics";
import type { ScriptDiagnostics } from "./script-diagnostics";

const origin = "http://127.0.0.1:20000";
const asset = `${origin}/__uatu/asset/chunk-abcdefgh.js`;

async function fixture(basePath = "/") {
  const navigationUrl = origin + basePath;
  const scriptUrl = origin + basePath + asset.slice(origin.length + 1);
  const context = Object.assign(new EventEmitter(), { pages: () => [], addInitScript: async () => {} });
  const log = { started: Date.now(), lines: [] as string[], dropped: 0, scripts: new Set<ScriptDiagnostics>() };
  await instrumentContext(context as unknown as BrowserContext, log, "[test]");
  const page = () => {
    const page = Object.assign(new EventEmitter(), { mainFrame: () => frame });
    const frame = { parentFrame: () => null, page: () => page, url: () => navigationUrl };
    context.emit("page", page);
    return { page, frame };
  };
  const request = (owner: ReturnType<typeof page>, navigation = false) => {
    const request = { isNavigationRequest: () => navigation, frame: () => owner.frame,
      url: () => navigation ? navigationUrl : scriptUrl, resourceType: () => navigation ? "document" : "script", method: () => "GET" };
    context.emit("request", request);
    return request;
  };
  const navigate = (owner: ReturnType<typeof page>) => {
    request(owner, true);
    owner.page.emit("framenavigated", owner.frame);
  };
  const response = (requestToken: ReturnType<typeof request>, text: string, status = 200) => {
    const bytes = Buffer.from(text);
    context.emit("response", {request: () => requestToken, url: () => scriptUrl, headers: () => ({"content-length": String(bytes.length)}),
      status: () => status, body: async () => bytes});
  };
  const error = (owner: ReturnType<typeof page>) => context.emit("weberror", {page: () => owner.page,
    error: () => Object.assign(new Error("test"), {name:"SyntaxError", stack:`at ${scriptUrl}:2:3`})});
  const records = async () => {
    await Promise.all([...log.scripts].map(scripts => scripts.flush()));
    return log.lines.filter(line => line.includes("script-failure ")).map(line => JSON.parse(line.split("script-failure ")[1]!));
  };
  return {context, log, page, request, navigate, response, error, records};
}

test("context listeners hash the failed reload's response, not the same URL's earlier success", async () => {
  const f = await fixture(); const page = f.page();
  f.navigate(page); f.response(f.request(page), "old successful body");
  f.navigate(page); f.response(f.request(page), "new broken body"); f.error(page);
  expect(await f.records()).toMatchObject([{sha256:createHash("sha256").update("new broken body").digest("hex")}]);
});

test("concurrent pages with the same script URL retain distinct response ownership", async () => {
  const f = await fixture(); const first = f.page(); const second = f.page();
  f.navigate(first); f.navigate(second);
  const firstRequest = f.request(first); const secondRequest = f.request(second);
  f.response(secondRequest, "second page body"); f.response(firstRequest, "first page body");
  f.error(first); f.error(second);
  expect(await f.records()).toMatchObject([
    {sha256:createHash("sha256").update("first page body").digest("hex")},
    {sha256:createHash("sha256").update("second page body").digest("hex")},
  ]);
});

test("script redirects cannot occupy the final executable response's slot", async () => {
  const f = await fixture(); const page = f.page();
  f.navigate(page);
  f.response(f.request(page), "redirect body", 302);
  f.response(f.request(page), "final executable body"); f.error(page);
  expect(await f.records()).toMatchObject([{sha256:createHash("sha256").update("final executable body").digest("hex")}]);
});

test("late old responses cannot overwrite a new navigation and transition errors are unattributed", async () => {
  const f = await fixture(); const page = f.page();
  f.navigate(page); const oldRequest = f.request(page);
  f.request(page, true); f.error(page);
  page.page.emit("framenavigated", page.frame);
  f.response(oldRequest, "late old body");
  f.response(f.request(page), "current body"); f.error(page);
  expect(await f.records()).toMatchObject([{sha256:createHash("sha256").update("current body").digest("hex")}]);
});

test("unavailable request frames cannot escape the optional diagnostic listener", async () => {
  const f = await fixture();
  expect(() => f.context.emit("request", {isNavigationRequest: () => true, frame: () => {throw Error("early frame");},
    resourceType: () => "document", method: () => "GET", url: () => origin + "/"})).not.toThrow();
  expect(await f.records()).toEqual([]);
});

test("context listeners derive the Hub mount from navigation and sanitize the failure record", async () => {
  const f = await fixture("/s/PRIVATE-workspace/"); const page = f.page();
  f.navigate(page); f.response(f.request(page), "broken body"); f.error(page);
  const records = await f.records();
  expect(records).toMatchObject([{path:"/__uatu/asset/chunk-abcdefgh.js", outcome:"received"}]);
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
});

test("retired navigation collectors are released and pending captures finish on close", async () => {
  const f = await fixture(); const page = f.page();
  for (let i = 0; i < 30; i++) { f.navigate(page); f.response(f.request(page), "unused body"); }
  await Promise.all([...f.log.scripts].map(scripts => scripts.flush()));
  expect(f.log.scripts.size).toBe(1);
  f.error(page); page.page.emit("close");
  expect(await f.records()).toHaveLength(1);
  await Promise.all([...f.log.scripts].map(scripts => scripts.flush()));
  expect(f.log.scripts.size).toBe(0);
});
