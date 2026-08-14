import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = path.resolve(import.meta.dir, "..", "..");
const workflowsDir = path.join(root, ".github", "workflows");
const shaAction = /^[^@]+@[0-9a-f]{40}$/;

async function workflow(name: string): Promise<Record<string, any>> {
  return parseYaml(await readFile(path.join(workflowsDir, name), "utf8"));
}

async function allWorkflows(): Promise<[string, Record<string, any>][]> {
  const names = (await readdir(workflowsDir)).filter(name => name.endsWith(".yml")).sort();
  return Promise.all(names.map(async name => [name, await workflow(name)] as [string, Record<string, any>]));
}

function steps(document: Record<string, any>): { job: string; step: any }[] {
  return Object.entries(document.jobs ?? {}).flatMap(([job, definition]: [string, any]) =>
    (definition.steps ?? []).map((step: any) => ({ job, step })));
}

describe("repository workflows", () => {
  test("pins every external action to a full commit SHA", async () => {
    const unpinned: string[] = [];
    for (const [name, document] of await allWorkflows()) {
      for (const { step } of steps(document)) {
        if (step.uses && !step.uses.startsWith("./") && !shaAction.test(step.uses)) unpinned.push(`${name}: ${step.uses}`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  test("grants no write scope at the workflow level", async () => {
    // Write scopes belong in the job that needs them, never in the block
    // every job inherits.
    const offenders: string[] = [];
    for (const [name, document] of await allWorkflows()) {
      if (document.permissions === undefined) {
        offenders.push(`${name}: no workflow-level permissions block`);
        continue;
      }
      const values = typeof document.permissions === "string"
        ? [document.permissions]
        : Object.values(document.permissions);
      for (const value of values) {
        if (String(value).includes("write")) offenders.push(`${name}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no workflow checks out a ref derived from event payload data", async () => {
    // Scorecard's Dangerous-Workflow check is syntactic: it flags any
    // actions/checkout `ref:` naming github.event.* under workflow_run or
    // pull_request_target, and it cannot see the `if:` guards that make such
    // a checkout safe. The publication pipeline used to trip it three times.
    // Privileged work now runs on trusted triggers against a fixed ref, so
    // the pattern is structurally absent rather than argued away.
    const offenders: string[] = [];
    for (const [name, document] of await allWorkflows()) {
      for (const trigger of Object.keys(document.on ?? {})) {
        if (trigger === "workflow_run" || trigger === "pull_request_target") offenders.push(`${name}: on.${trigger}`);
      }
      for (const { job, step } of steps(document)) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        if (String(step.with?.ref ?? "").includes("github.event.")) offenders.push(`${name}/${job}: ref ${step.with.ref}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("Pages validates the contract and the built site before deploying", async () => {
    const pages = await workflow("pages.yml");
    expect(Object.keys(pages.on)).toEqual(["push", "workflow_dispatch"]);
    expect(pages.on.push.branches).toEqual(["main"]);
    expect(pages.permissions).toEqual({});
    // Cancelling loses no state, but it does lose a valid deployment when the
    // run that replaced it then fails: the site would sit older than a commit
    // that was ready to publish, with nothing scheduled to retry it.
    expect(pages.concurrency).toEqual({ group: "github-pages", "cancel-in-progress": false });
    expect(Object.keys(pages.jobs)).toEqual(["deploy"]);
    expect(pages.jobs.deploy.permissions).toEqual({ pages: "write", "id-token": "write", contents: "read" });
    // workflow_dispatch checks out the ref the dispatcher picked, so without
    // this guard an unmerged branch could be published straight to the public
    // site, bypassing the contract checks that are enforced at the merge layer
    // and therefore never ran on that ref.
    expect(pages.jobs.deploy.if).toBe("github.ref == 'refs/heads/main'");

    const names = pages.jobs.deploy.steps.map((step: any) => step.name);
    const order = (label: string) => names.indexOf(label);
    expect(order("Validate the contract being published")).toBeGreaterThan(-1);
    expect(order("Validate the contract being published")).toBeLessThan(order("Build the site"));
    expect(order("Build the site")).toBeLessThan(order("Check the built site"));
    expect(order("Check the built site")).toBeLessThan(order("Deploy to Pages"));

    const validate = pages.jobs.deploy.steps.find((step: any) => step.name === "Validate the contract being published");
    expect(validate.run).toContain("bun run api:validate");
    expect(validate.run).toContain("structural.ts");
    const upload = pages.jobs.deploy.steps.find((step: any) => step.uses?.startsWith("actions/upload-pages-artifact@"));
    expect(upload.with.path).toBe("site/dist");
  });

  test("checkouts do not persist credentials", async () => {
    // No workflow pushes from a checkout anymore, so this holds without
    // exception: a persisted token would sit in .git/config while bun
    // install and the test suites run.
    for (const name of ["pages.yml", "ci.yml", "release.yml"]) {
      const document = await workflow(name);
      for (const { job, step } of steps(document)) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        expect(`${name}/${job}: ${step.with?.["persist-credentials"]}`).toBe(`${name}/${job}: false`);
      }
    }
  });

  test("contract validation runs the full test:api set in CI", async () => {
    // ci.yml previously hand-listed test paths and drifted from test:api;
    // it must invoke the one package script.
    const ci = await workflow("ci.yml");
    const ciRuns = steps(ci).map(({ step }) => step.run ?? "");
    expect(ciRuns.some(run => run.includes("bun run test:api"))).toBe(true);
    expect(ciRuns.some(run => run.includes("bun run site:check"))).toBe(true);
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    for (const target of ["api/contract.test.ts", "api/route-coverage.test.ts", "src/hub/hub.integration.test.ts", "src/shared/api-revisions.test.ts"]) {
      expect(packageJson.scripts["test:api"]).toContain(target);
    }
  });

  test("compatibility gate also covers pushes to main", async () => {
    const ci = await workflow("ci.yml");
    const validate = steps(ci).map(({ step }) => step)
      .find((step: any) => step.name === "Enforce compatibility against the base contract");
    expect(validate.if).toContain("github.event_name == 'push'");
    expect(validate.env.BASE_SHA).toContain("github.event.before");
    expect(validate.run).toContain("--base-operations");
    expect(validate.run).toContain("--base-exclusions");
  });
});
