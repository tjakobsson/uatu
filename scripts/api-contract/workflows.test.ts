import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = path.resolve(import.meta.dir, "..", "..");
const shaAction = /^[^@]+@[0-9a-f]{40}$/;

async function workflow(name: string): Promise<Record<string, any>> {
  return parseYaml(await readFile(path.join(root, ".github", "workflows", name), "utf8"));
}

describe("API publication workflows", () => {
  test("pins every external action and isolates Pages write permission", async () => {
    for (const name of ["pages.yml", "api-release.yml"]) {
      const document = await workflow(name);
      expect(document.permissions).toEqual({});
      for (const job of Object.values(document.jobs) as any[]) {
        for (const step of job.steps) {
          if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(shaAction);
        }
      }
      expect(document.jobs.deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
    }
  });

  test("edge consumes the validated run artifact and cannot invoke release mode", async () => {
    const document = await workflow("pages.yml");
    const steps = document.jobs.assemble.steps as any[];
    const checkout = steps.find(step => step.name === "Check out validated source");
    const download = steps.find(step => step.name === "Download exact validated site artifact");
    const assemble = steps.find(step => step.name === "Assemble edge without changing release history");
    expect(checkout.with.ref).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(download.with["run-id"]).toBe("${{ github.event.workflow_run.id }}");
    expect(download.with.name).toContain("${{ github.event.workflow_run.head_sha }}");
    expect(assemble.run).toContain("--mode=edge");
    expect(assemble.run).not.toContain("--mode=release");
  });

  test("only tagged publication advances latest and persists history", async () => {
    const document = await workflow("api-release.yml");
    expect(document.on.push.tags).toEqual(["v*"]);
    const steps = document.jobs.assemble.steps as any[];
    expect(steps.find(step => step.name === "Assemble immutable revision and latest").run).toContain("--mode=release");
    expect(steps.find(step => step.name === "Persist release publication history").run).toContain("HEAD:pages-history");
  });
});
