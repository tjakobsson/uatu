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

  test("edge cannot smuggle a dotfile into api/latest", async () => {
    const { root, site, history } = await fixture();
    const output = path.join(root, "output");
    await mkdir(path.join(site, "api", "latest"), { recursive: true });
    await writeFile(path.join(site, "api", "latest", ".hidden"), "sneaky");
    await expect(publish({ mode: "edge", site, history, output, commit }))
      .rejects.toThrow("edge publication attempted to modify api/latest");
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

  test("release refuses a bundle whose files do not match SHA256SUMS.json", async () => {
    const { root, site, history, source } = await fixture();
    const bundle = path.join(root, "bundle");
    const output = path.join(root, "output");
    await createReleaseBundle(source, bundle, commit, "2026-08-13T00:00:00.000Z", "0.5.1");
    await writeFile(path.join(bundle, "openapi.yaml"), "tampered\n");
    await expect(publish({ mode: "release", site, history, output, bundle, commit }))
      .rejects.toThrow("does not match SHA256SUMS.json");
  });

  test("rerunning an older release cannot roll latest backward", async () => {
    const { root, site, history, source } = await fixture();
    const newerBundle = path.join(root, "newer-bundle");
    const newerOutput = path.join(root, "newer-output");
    await createReleaseBundle(source, newerBundle, commit, "2026-08-20T00:00:00.000Z", "0.6.0");
    await publish({ mode: "release", site, history, output: newerOutput, bundle: newerBundle, commit });

    const olderCommit = "abcdef0123456789abcdef0123456789abcdef01";
    const olderBundle = path.join(root, "older-bundle");
    const olderOutput = path.join(root, "older-output");
    await createReleaseBundle(source, olderBundle, olderCommit, "2026-08-13T00:00:00.000Z", "0.5.1");
    await expect(publish({ mode: "release", site, history: newerOutput, output: olderOutput, bundle: olderBundle, commit: olderCommit }))
      .rejects.toThrow("refusing to roll api/latest back");
  });

  test("prerelease ordering guards latest: stable beats its prereleases, prereleases order by identifier", async () => {
    const { root, site, history, source } = await fixture();
    const stableBundle = path.join(root, "stable-bundle");
    const stableOutput = path.join(root, "stable-output");
    await createReleaseBundle(source, stableBundle, commit, "2026-08-20T00:00:00.000Z", "0.6.0");
    await publish({ mode: "release", site, history, output: stableOutput, bundle: stableBundle, commit });

    // A rerun of the prerelease publication must not replace the stable one.
    const betaCommit = "abcdef0123456789abcdef0123456789abcdef01";
    const betaBundle = path.join(root, "beta-bundle");
    await createReleaseBundle(source, betaBundle, betaCommit, "2026-08-15T00:00:00.000Z", "0.6.0-beta.1");
    await expect(publish({ mode: "release", site, history: stableOutput, output: path.join(root, "beta-output"), bundle: betaBundle, commit: betaCommit }))
      .rejects.toThrow("refusing to roll api/latest back");

    // Forward prerelease progression stays allowed.
    const beta2Commit = "1234567890abcdef1234567890abcdef12345678";
    const beta2Bundle = path.join(root, "beta2-bundle");
    const beta1Output = path.join(root, "beta1-output");
    await createReleaseBundle(source, path.join(root, "beta1-bundle"), betaCommit, "2026-08-15T00:00:00.000Z", "0.7.0-beta.1");
    await publish({ mode: "release", site, history: stableOutput, output: beta1Output, bundle: path.join(root, "beta1-bundle"), commit: betaCommit });
    await createReleaseBundle(source, beta2Bundle, beta2Commit, "2026-08-16T00:00:00.000Z", "0.7.0-beta.2");
    await publish({ mode: "release", site, history: beta1Output, output: path.join(root, "beta2-output"), bundle: beta2Bundle, commit: beta2Commit });
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
