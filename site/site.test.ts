import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "astro";
import { parse } from "yaml";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
let output = "";

beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "uatu-api-site-"));
  await build({ root: new URL(`file://${resolve(root, "site")}/`), outDir: output });
});

afterAll(async () => {
  if (output) await rm(output, { recursive: true, force: true });
});

describe("static API site", () => {
  test("renders essential product, guide, and API content", async () => {
    expect(await readFile(join(output, "index.html"), "utf8")).toContain("UatuCode helps you follow the files agents are changing");
    expect(await readFile(join(output, "docs/guides/index.html"), "utf8")).toContain("Integration guides");
    expect(await readFile(join(output, "docs/api/index.html"), "utf8")).toContain("Search operations");
  });

  test("publishes readable raw edge artifacts", async () => {
    const metadata = JSON.parse(await readFile(join(output, "api/edge/contract.json"), "utf8"));
    expect(metadata.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(metadata.artifacts.openapi).toBe("openapi.yaml");
    expect(await readFile(join(output, "api/edge/openapi.yaml"), "utf8")).toContain("openapi: 3.1");
    expect(await readFile(join(output, "api/edge/streaming.yaml"), "utf8")).toContain("channels:");
    expect(await readFile(join(output, "api/edge/agent.md"), "utf8")).toContain("Artifact precedence");
    expect(await readFile(join(output, "api/edge/contract.schema.json"), "utf8")).toContain("UatuCode API contract metadata");
    expect(await readFile(join(output, "api/edge/operations.yaml"), "utf8")).toContain("operations:");
    expect(await readFile(join(output, "api/edge/exclusions.yaml"), "utf8")).toContain("exclusions:");
    const hashes = JSON.parse(await readFile(join(output, "api/edge/SHA256SUMS.json"), "utf8"));
    expect(hashes.sourceCommit).toBe(metadata.sourceCommit);
    expect(hashes.files["openapi.yaml"]).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(output, "llms.txt"), "utf8")).toContain("Current edge artifacts");
  });

  test("renders every canonical operation ID", async () => {
    const contract = parse(await readFile(join(root, "api/openapi.yaml"), "utf8")) as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ids = Object.values(contract.paths).flatMap(path => Object.values(path).map(operation => operation?.operationId).filter(Boolean));
    const html = await readFile(join(output, "docs/api/index.html"), "utf8");
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(html).toContain(`data-operation-id="${id}"`);
    expect(html.match(/data-operation-id=/g)?.length).toBe(ids.length);
  });

  test("uses the GitHub Pages base for local absolute URLs", async () => {
    const htmlFiles = ["index.html", "docs/guides/index.html", "docs/api/index.html"];
    for (const file of htmlFiles) {
      const html = await readFile(join(output, file), "utf8");
      const localAbsolute = [...html.matchAll(/(?:href|src)="(\/[^"#]+)"/g)].map(match => match[1]);
      expect(localAbsolute.every(url => url.startsWith("/uatu/"))).toBe(true);
    }
  });
});
