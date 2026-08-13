import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReleaseBundle } from "./release-bundle";
import { publish } from "./publish";

const commit = "0123456789abcdef0123456789abcdef01234567";
const roots: string[] = [];

async function fixture(): Promise<{ root: string; site: string; history: string; source: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-contract-publication-"));
  roots.push(root);
  const site = path.join(root, "site");
  const history = path.join(root, "history");
  const source = path.join(root, "source");
  await mkdir(path.join(site, "api", "edge"), { recursive: true });
  await mkdir(path.join(history, "api", "latest"), { recursive: true });
  await mkdir(path.join(history, "api", "revisions", "hub-1_workspace-1"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(site, "index.html"), "site");
  await writeFile(path.join(site, "api", "edge", "contract.json"), JSON.stringify({ sourceCommit: commit }));
  await writeFile(path.join(history, "api", "latest", "marker"), "released");
  await writeFile(path.join(history, "api", "revisions", "hub-1_workspace-1", "marker"), "immutable");
  for (const file of ["openapi.yaml", "streaming.yaml", "contract.schema.json", "CHANGELOG.md", "agent.md", "operations.yaml", "exclusions.yaml"]) {
    await writeFile(path.join(source, file), `${file}\n`);
  }
  await writeFile(path.join(source, "contract.json"), JSON.stringify({ hubApiRevision: 2, workspaceApiRevision: 1 }));
  return { root, site, history, source };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("contract publication dry runs", () => {
  test("edge names the validated commit and cannot alter latest or history", async () => {
    const { root, site, history } = await fixture();
    const output = path.join(root, "output");
    await publish({ mode: "edge", site, history, output, commit });
    expect(await readFile(path.join(output, "api", "latest", "marker"), "utf8")).toBe("released");
    expect(await readFile(path.join(output, "api", "revisions", "hub-1_workspace-1", "marker"), "utf8")).toBe("immutable");
    await writeFile(path.join(site, "api", "edge", "contract.json"), JSON.stringify({ sourceCommit: "f".repeat(40) }));
    await expect(publish({ mode: "edge", site, history, output, commit })).rejects.toThrow("does not match validated commit");
  });

  test("release preserves history, creates an immutable pair, and advances latest atomically", async () => {
    const { root, site, history, source } = await fixture();
    const bundle = path.join(root, "bundle");
    const output = path.join(root, "output");
    await createReleaseBundle(source, bundle, commit, "2026-08-13T00:00:00.000Z", "0.5.1");
    await publish({ mode: "release", site, history, output, bundle, commit });
    expect(await readFile(path.join(output, "api", "revisions", "hub-1_workspace-1", "marker"), "utf8")).toBe("immutable");
    expect(await readFile(path.join(output, "api", "latest", "openapi.yaml"), "utf8")).toBe("openapi.yaml\n");
    expect(await readFile(path.join(output, "api", "revisions", "hub-2_workspace-1_v0.5.1", "openapi.yaml"), "utf8")).toBe("openapi.yaml\n");
    const metadata = JSON.parse(await readFile(path.join(output, "api", "latest", "contract.json"), "utf8"));
    expect(metadata.sourceCommit).toBe(commit);
    expect(metadata.productVersion).toBe("0.5.1");
  });

  test("unchanged API revisions can publish a later product release", async () => {
    const { root, site, history, source } = await fixture();
    const firstBundle = path.join(root, "first-bundle");
    const firstOutput = path.join(root, "first-output");
    await createReleaseBundle(source, firstBundle, commit, "2026-08-13T00:00:00.000Z", "0.5.1");
    await publish({ mode: "release", site, history, output: firstOutput, bundle: firstBundle, commit });

    const laterCommit = "abcdef0123456789abcdef0123456789abcdef01";
    const laterBundle = path.join(root, "later-bundle");
    const laterOutput = path.join(root, "later-output");
    await createReleaseBundle(source, laterBundle, laterCommit, "2026-08-20T00:00:00.000Z", "0.5.2");
    await publish({ mode: "release", site, history: firstOutput, output: laterOutput, bundle: laterBundle, commit: laterCommit });
    expect(await Bun.file(path.join(laterOutput, "api", "revisions", "hub-2_workspace-1_v0.5.1", "contract.json")).exists()).toBe(true);
    expect(await Bun.file(path.join(laterOutput, "api", "revisions", "hub-2_workspace-1_v0.5.2", "contract.json")).exists()).toBe(true);
  });
});
