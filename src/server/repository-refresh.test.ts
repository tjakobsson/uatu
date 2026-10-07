import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRepositoryRefresh } from "./repository-refresh";
import { safeGit } from "../document/git-data";

async function until(check: () => boolean) {
  const deadline = performance.now() + 8000;
  while (!check()) { if (performance.now() > deadline) throw new Error("repository event did not arrive"); await Bun.sleep(10); }
}

test("stopped collection cannot replace retained results or publish late", async () => {
  const gate = Promise.withResolvers<void>();
  let publications = 0;
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => { publications++; },
    collect: async () => { await gate.promise; return []; },
  });
  const work = refresh.refresh();
  expect(publications).toBe(1);
  refresh.stop();
  gate.resolve(); await work;
  expect(publications).toBe(1);
  expect(refresh.freshness.generation).toBe(0);
});

test("repeated requests during collection retain only one follow-up", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {},
    collect: async () => { if (++calls <= 2) await gate.promise; return []; },
  });
  try {
    const first = refresh.refresh();
    for (let i = 0; i < 20; i++) refresh.request();
    expect(calls).toBe(2);
    gate.resolve(); await first;
    await until(() => refresh.freshness.generation === 2);
    expect(calls).toBe(4);
  } finally { gate.resolve(); refresh.stop(); }
});

test("Git observation timers are shared and released with demand", () => {
  const timer = { unref() {} } as ReturnType<typeof setInterval>;
  const set = spyOn(globalThis, "setInterval").mockReturnValue(timer);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, collect: async () => [] });
  try {
    refresh.demand(true); refresh.demand(true);
    expect(set).toHaveBeenCalledTimes(1);
    refresh.demand(false);
    expect(clear).toHaveBeenCalledWith(timer);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally { refresh.stop(); set.mockRestore(); clear.mockRestore(); }
});

test("metadata-only commits in a linked worktree refresh Git without file events", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-repository-probe-"));
  const main = path.join(directory, "main");
  const linked = path.join(directory, "linked");
  await mkdir(main);
  const git = async (cwd: string, args: string[]) => { const result = await safeGit(cwd, args); if (!result.ok) throw new Error(result.stderr); return result; };
  let probes = 0;
  let collections = 0;
  const refresh = createRepositoryRefresh({ entries: [{ kind: "dir", absolutePath: linked }], roots: () => [], publish: () => {},
    collect: async () => { collections++; return []; }, probeIntervalMs: 30, onProbe: () => { probes++; },
  });
  try {
    await git(main, ["init", "--initial-branch=main"]);
    await writeFile(path.join(main, "README.md"), "# Unchanged document\n");
    await git(main, ["add", "."]);
    const commit = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit"];
    await git(main, [...commit, "-m", "initial"]);
    await git(main, ["worktree", "add", "-b", "feature", linked]);
    refresh.demand(true);
    await until(() => probes > 0 && refresh.freshness.status === "ready");
    const generation = refresh.freshness.generation;
    await git(linked, [...commit, "--allow-empty", "-m", "metadata only"]);
    await until(() => refresh.freshness.generation > generation);
    expect(collections).toBeGreaterThanOrEqual(4);
    expect(await readFile(path.join(linked, "README.md"), "utf8")).toBe("# Unchanged document\n");
  } finally { refresh.stop(); await rm(directory, { recursive: true, force: true }); }
}, 15000);
