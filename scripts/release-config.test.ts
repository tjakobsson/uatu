import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = path.resolve(import.meta.dir, "..");

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Release Please configuration", () => {
  test("starts from the published package version and exposes only user-facing sections", async () => {
    const config = JSON.parse(await read("release-please-config.json"));
    const manifest = JSON.parse(await read(".release-please-manifest.json"));
    const pkg = JSON.parse(await read("package.json"));
    const component = config.packages["."];

    expect(manifest["."]).toBe(pkg.version);
    expect(manifest["."]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(component["release-type"]).toBe("node");
    expect(component.draft).toBe(true);
    expect(component["force-tag-creation"]).toBe(true);
    expect(component["include-component-in-tag"]).toBe(false);
    expect(component["include-v-in-tag"]).toBe(true);

    const sections = Object.fromEntries(
      component["changelog-sections"].map((entry: { type: string; hidden?: boolean }) => [
        entry.type,
        entry.hidden ?? false,
      ]),
    );
    expect(sections).toMatchObject({
      feat: false,
      fix: false,
      perf: false,
      docs: true,
      refactor: true,
      test: true,
      build: true,
      ci: true,
      chore: true,
    });
  });

  test("bootstraps the changelog through v0.1.1", async () => {
    const changelog = await read("CHANGELOG.md");
    expect(changelog).toContain("compare/v0.1.0...v0.1.1");
    expect(changelog).toContain("releases/tag/v0.1.0");
    expect(changelog).not.toContain("## Unreleased");
  });

  test("runs the pinned action on main with the dedicated token", async () => {
    const workflow = parseYaml(await read(".github/workflows/release-please.yml"));
    const step = workflow.jobs["release-please"].steps[0];

    expect(workflow.on.push.branches).toContain("main");
    expect(step.uses).toMatch(/^googleapis\/release-please-action@[0-9a-f]{40}$/);
    expect(step.with.token).toBe("${{ secrets.RELEASE_PLEASE_TOKEN }}");
    expect(step.with["config-file"]).toBe("release-please-config.json");
    expect(step.with["manifest-file"]).toBe(".release-please-manifest.json");
  });
});

describe("artifact publication workflow", () => {
  test("guards the tag and publishes only after smoke, attestation, and upload", async () => {
    const workflow = parseYaml(await read(".github/workflows/release.yml"));
    const steps = workflow.jobs.release.steps as Array<{ name: string; run?: string }>;
    const names = steps.map(step => step.name);
    const tagGuard = steps.find(step => step.name === "Verify tag matches package.json version")!;
    const releaseProbe = steps.find(step => step.name === "Verify GitHub Release exists")!;
    const upload = steps.find(step => step.name === "Upload release assets")!;
    const publish = steps.find(step => step.name === "Publish GitHub Release")!;

    expect(workflow.on.push.tags).toContain("v*");
    expect(tagGuard.run).toContain('expected="v$(jq -r .version package.json)"');
    expect(releaseProbe.run).toContain("gh release view");
    expect(upload.run).toContain("gh release upload");
    expect(upload.run).toContain("--clobber");
    expect(publish.run).toContain("--draft=false");
    expect(names.indexOf("Smoke-test the linux-x64 binary")).toBeLessThan(names.indexOf("Upload release assets"));
    expect(names.indexOf("Attest build provenance")).toBeLessThan(names.indexOf("Upload release assets"));
    expect(names.indexOf("Upload release assets")).toBeLessThan(names.indexOf("Publish GitHub Release"));
    expect(workflow.jobs["update-tap"].needs).toBe("release");
    expect(workflow.jobs["update-tap"].permissions.contents).toBe("read");
  });
});
