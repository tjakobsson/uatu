import { expect, test } from "bun:test";
import { reviewHostingOptions, validatePublicOrigin } from "./hosting";
import { buildEvidenceAssets, evidenceSelection } from "./hosting-evidence";

// Synthetic parser fixture only, never a default or a live review address.
const origin = "https://review-fixture.example-tailnet.ts.net:8445";
test("hosting configuration is explicit, dedicated, canonical and loopback-only", () => {
  expect(reviewHostingOptions([], {})).toEqual({ port: 4703, publicOrigin: undefined });
  expect(reviewHostingOptions(["--port", "0", "--public-origin", origin], {})).toEqual({ port: 0, publicOrigin: origin });
  expect(reviewHostingOptions([], { UATU_MOBILE_REVIEW_PORT: "4703", UATU_MOBILE_REVIEW_PUBLIC_ORIGIN: origin }).publicOrigin).toBe(origin);
  for (const value of ["https://evil.example:8445", origin + "/", origin + "?x", origin.replace("https", "http"), origin.replace("8445", "8444"), origin.replace("8445", "443"), origin.replace("8445", "0"), "https://*.example-tailnet.ts.net:8445", "https://user@host.tail.ts.net:8445"]) expect(() => validatePublicOrigin(value)).toThrow();
  for (const args of [["--host", "0.0.0.0"], ["--port", "4700"], ["--port", "4701"], ["--port", "4702"], ["--port", "-1"], ["--port", "65536"], ["--port"], ["--port", "0", "--port", "0"]]) expect(() => reviewHostingOptions(args, {})).toThrow();
});

test("evidence is an immutable byte snapshot of explicit safe selections", async () => {
  const assets = await buildEvidenceAssets();
  expect(assets.size).toBeGreaterThanOrEqual(evidenceSelection.length + 3);
  expect(assets.has("/review/evidence/baseline.json")).toBe(false);
  expect(assets.get("/review/evidence/visual/corrected/index.html")!.type).toBe("text/plain; charset=utf-8");
  const manifest = JSON.parse(assets.get("/review/evidence/manifest.json")!.body as string);
  for (const file of manifest.files) {
    const asset = assets.get(`/review/evidence/${file.path}`)!;
    expect(new Bun.CryptoHasher("sha256").update(await (asset.body as Blob).arrayBuffer()).digest("hex")).toBe(file.sha256);
  }
});
