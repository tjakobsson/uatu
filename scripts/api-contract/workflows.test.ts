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
      if (name === "pages.yml") {
        expect(document.jobs.deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
      } else {
        // The release deploy job also pushes pages-history from inside the
        // deploy lock, so it additionally needs contents: write.
        expect(document.jobs.deploy.permissions).toEqual({ pages: "write", "id-token": "write", contents: "write", actions: "read" });
      }
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

  test("only a successful Release run advances latest from its exact commit", async () => {
    const release = await workflow("release.yml");
    const document = await workflow("api-release.yml");
    expect(release.jobs["update-tap"]["continue-on-error"]).toBe(true);
    expect(document.on.workflow_run).toEqual({ workflows: ["Release"], types: ["completed"] });
    expect(document.jobs.bundle.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(document.jobs.bundle.steps.find((step: any) => step.name === "Check out tagged source").with.ref)
      .toBe("${{ github.event.workflow_run.head_sha }}");
    expect(document.jobs.bundle.steps.find((step: any) => step.name === "Create immutable release bundle").run)
      .toContain("Release $tag is not published");
    const steps = document.jobs.assemble.steps as any[];
    expect(steps.find(step => step.name === "Assemble immutable revision and latest").run).toContain("--mode=release");
    expect(document.jobs.deploy.steps.find((step: any) => step.name === "Persist release publication history").run)
      .toContain("HEAD:pages-history");
  });

  test("a release deploy cannot roll a newer edge deployment back", async () => {
    // The release assembles the newest successful main CI's validated site
    // (verified to name that run's commit) instead of unconditionally
    // rebuilding everything from the tagged SHA, falling back to the
    // tag-built site only when the newer artifact is unavailable.
    const document = await workflow("api-release.yml");
    const steps = document.jobs.assemble.steps as any[];
    const select = steps.find(step => step.name === "Prefer the newest validated main site");
    expect(select.run).toContain("pages-edge-$head_sha");
    expect(select.run).toContain("falling back to the tag-built site");
    expect(select.run).toContain("sourceCommit");
    // Only a strict descendant of the tag may replace the tag-built site —
    // the latest successful main CI run can predate the tag when the tag's
    // own CI is still running or failed.
    expect(select.run).toContain("/compare/");
    expect(select.run).toContain('"$ancestry" != "ahead"');
    const assemble = steps.find(step => step.name === "Assemble immutable revision and latest");
    expect(assemble.run).toContain("--site=${{ steps.site.outputs.dir }}");
    expect(steps.indexOf(select)).toBeLessThan(steps.indexOf(assemble));
  });

  test("a cancelled release publication is re-run automatically", async () => {
    // GitHub keeps one pending slot per concurrency group and replaces it,
    // so back-to-back edge deploys can cancel a pending release deploy even
    // with cancel-in-progress: false. The retry workflow re-runs cancelled
    // publications, bounded so a persistent failure cannot loop forever.
    const retry = await workflow("api-release-retry.yml");
    expect(retry.on.workflow_run).toEqual({ workflows: ["Publish released API contract"], types: ["completed"] });
    expect(retry.permissions).toEqual({});
    expect(retry.jobs.retry.if).toContain("github.event.workflow_run.conclusion == 'cancelled'");
    expect(retry.jobs.retry.if).toContain("github.event.workflow_run.run_attempt < 5");
    expect(retry.jobs.retry.permissions).toEqual({ actions: "write" });
    expect(retry.jobs.retry.steps[0].run).toContain("/rerun");
  });

  test("history writes and the edge staleness guard both hold the deploy lock", async () => {
    // Every pages-history write must happen inside the github-pages
    // concurrency lock, and BEFORE deploy-pages (push-first self-heals a
    // failed deployment; deploy-first would open a rollback window). The
    // edge deploy validates its assembled history snapshot under the same
    // lock, so a release publication can never be silently rolled back by a
    // concurrent edge run that assembled earlier.
    const apiRelease = await workflow("api-release.yml");
    const releaseSteps = apiRelease.jobs.deploy.steps.map((step: any) => step.name);
    expect(apiRelease.jobs.deploy.concurrency.group).toBe("github-pages");
    expect(releaseSteps.indexOf("Persist release publication history"))
      .toBeLessThan(releaseSteps.indexOf("Deploy released Pages artifact"));
    // The assemble job no longer pushes and must not hold write permission.
    expect(apiRelease.jobs.assemble.permissions.contents).toBe("read");

    const pages = await workflow("pages.yml");
    expect(pages.jobs.assemble.outputs["history-sha"]).toContain("steps.history.outputs.sha");
    const guard = pages.jobs.deploy.steps.find((step: any) => step.name === "Refuse to deploy a stale history snapshot");
    const guardIndex = pages.jobs.deploy.steps.indexOf(guard);
    expect(guard.run).toContain("pages-history advanced");
    expect(guardIndex).toBeLessThan(pages.jobs.deploy.steps.findIndex((step: any) => step.name === "Deploy Pages artifact"));
  });

  test("workflow_run triggers reject fork lookalikes", async () => {
    // head_branch alone is fork-spoofable: a fork PR whose source branch is
    // named main satisfies it. Both privileged consumers must also require a
    // push event originating from this repository.
    const pages = await workflow("pages.yml");
    for (const condition of [
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
    ]) {
      expect(pages.jobs.assemble.if).toContain(condition);
    }
    const apiRelease = await workflow("api-release.yml");
    for (const condition of [
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
    ]) {
      expect(apiRelease.jobs.bundle.if).toContain(condition);
    }
  });

  test("a queued release publication cannot be collapsed away by an edge run", async () => {
    // One pending run per concurrency group: sharing a workflow-level group
    // would let a later edge run silently cancel a queued release
    // publication. Only the deploy jobs serialize on the shared group.
    const pages = await workflow("pages.yml");
    const apiRelease = await workflow("api-release.yml");
    expect(pages.concurrency.group).not.toBe(apiRelease.concurrency.group);
    expect(pages.concurrency["cancel-in-progress"]).toBe(false);
    expect(apiRelease.concurrency["cancel-in-progress"]).toBe(false);
    expect(pages.jobs.deploy.concurrency.group).toBe("github-pages");
    expect(apiRelease.jobs.deploy.concurrency.group).toBe("github-pages");
  });

  test("checkouts that never push do not persist credentials", async () => {
    for (const name of ["pages.yml", "api-release.yml", "ci.yml", "release.yml"]) {
      const document = await workflow(name);
      for (const [jobName, job] of Object.entries(document.jobs) as [string, any][]) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("actions/checkout@")) continue;
          // The pages-history checkout in api-release's deploy job pushes
          // back with its persisted token; every other checkout must stay
          // credential-free.
          const pushesBack = name === "api-release.yml" && jobName === "deploy" && step.with?.ref === "pages-history";
          if (!pushesBack) expect(step.with?.["persist-credentials"]).toBe(false);
        }
      }
    }
  });

  test("contract validation runs the full test:api set everywhere", async () => {
    // ci.yml and api-release.yml previously hand-listed test paths and
    // drifted from test:api; both must invoke the one package script.
    const ci = await workflow("ci.yml");
    const apiRelease = await workflow("api-release.yml");
    const ciRuns = (Object.values(ci.jobs) as any[]).flatMap(job => (job.steps ?? []).map((step: any) => step.run ?? ""));
    expect(ciRuns.some(run => run.includes("bun run test:api"))).toBe(true);
    expect(ciRuns.some(run => run.includes("bun run site:check"))).toBe(true);
    const releaseRuns = apiRelease.jobs.bundle.steps.map((step: any) => step.run ?? "");
    expect(releaseRuns.some((run: string) => run.includes("bun run test:api"))).toBe(true);
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    for (const target of ["api/contract.test.ts", "api/route-coverage.test.ts", "src/hub/hub.integration.test.ts", "src/shared/api-revisions.test.ts"]) {
      expect(packageJson.scripts["test:api"]).toContain(target);
    }
  });

  test("compatibility gate also covers pushes to main", async () => {
    const ci = await workflow("ci.yml");
    const validate = (Object.values(ci.jobs) as any[]).flatMap(job => job.steps ?? [])
      .find((step: any) => step.name === "Enforce compatibility against the base contract");
    expect(validate.if).toContain("github.event_name == 'push'");
    expect(validate.env.BASE_SHA).toContain("github.event.before");
    expect(validate.run).toContain("--base-operations");
    expect(validate.run).toContain("--base-exclusions");
  });
});
