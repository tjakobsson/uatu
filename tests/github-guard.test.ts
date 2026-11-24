// Guards for the GitHub integration's boundaries (design D6, D15):
// - the e2e server serves pull requests from the in-memory fake only, never
//   the real `gh` transport;
// - nothing on the file-observation path can reach the GitHub service, so a
//   file edit never becomes a GitHub request (only the route table imports
//   src/github, and the browser asks).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

function sources(directory: string): string[] {
  return readdirSync(path.join(root, directory), { recursive: true, encoding: "utf8" })
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(directory, file));
}

describe("GitHub boundaries", () => {
  test("the e2e server never constructs the real gh transport", () => {
    const server = readFileSync(path.join(root, "tests/e2e/server.ts"), "utf8");
    // The real service may run there, but only over the transport-level fake.
    expect(server).not.toMatch(/GhTransport|githubServiceFromEnvironment|src\/github\/gh"/);
    expect(server).toContain("e2eGithubTransport = new FakeGitHub()");
    expect(server).toContain("new GitHubApi(e2eGithubTransport)");
    expect(server).toContain("FakeGithubService");
  });

  test("only the route table and the CLI import src/github from server-side code", () => {
    const importers = [...sources("src/server"), ...sources("src/document"), ...sources("src/hub"), "src/cli.ts"]
      .filter(file => /from "\.\.?\/(?:\.\.\/)*github\//.test(readFileSync(path.join(root, file), "utf8")));
    expect(importers.sort()).toEqual(["src/cli.ts", "src/server/routes.ts"]);
  });
});
