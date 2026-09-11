import { expect, test } from "bun:test";
import { mobileHubDetail, mobileHubPath, mobileHubRoute } from "./coordinator";

const url = (path: string) => new URL(path, "https://example.invalid");
test("Hub/detail routes are distinct from workspace document, hash and commit routes", () => {
  expect(mobileHubRoute(url("/"))).toBe("hub");
  expect(mobileHubRoute(url("/settings"))).toBe("settings");
  expect(mobileHubRoute(url("/clone"))).toBe("hub");
  expect(mobileHubDetail(url("/clone"))).toEqual({ kind: "clone" });
  for (const path of ["/s/atlas/README.md#section", "/s/atlas/?repository=repo&commit=abc", "/settings.md", "/s/other/"]) expect(mobileHubRoute(url(path))).toBeNull();
});
test("detail round trips allow only known kinds and bounded stable identity", () => {
  const detail = { kind: "credential" as const, id: "ssh-key:123" };
  expect(mobileHubDetail(url(mobileHubPath("settings", detail)))).toEqual(detail);
  expect(mobileHubDetail(url("/?detail=workspace&id=atlas"))).toEqual({ kind: "workspace", id: "atlas" });
  expect(mobileHubPath("hub", { kind: "folders" })).toBe("/?detail=folders");
  expect(mobileHubDetail(url("/?detail=folders"))).toEqual({ kind: "folders" });
  expect(mobileHubDetail(url("/?detail=folders&id=/private/path"))).toBeUndefined();
  expect(mobileHubDetail(url("/?detail=folders&detail=folders"))).toBeUndefined();
  for (const path of ["/settings?detail=unknown", "/settings?detail=credential", "/settings?detail=credential&id=/host/path", "/settings?detail=devices&id=secret", "/settings?detail=devices&detail=tools", "/s/atlas/?detail=devices"]) expect(mobileHubDetail(url(path))).toBeUndefined();
});
