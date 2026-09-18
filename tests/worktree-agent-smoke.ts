// Manual, model-backed compatibility check. Not part of bun test: it uses the
// installed agents and their configured accounts. Run only with user consent:
// bun run tests/worktree-agent-smoke.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRegistry } from "../src/hub/registry";
import { WorktreeService } from "../src/hub/worktree-service";
import { WorktreeJournal, WorktreeProvenanceStore } from "../src/hub/worktree-journal";
import { OpenCodeService } from "../src/chat/opencode/opencode-service";
import { listTranscriptSessions, readSessionTranscript, sessionTranscriptPath } from "../src/chat/claude/transcript";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-agent-smoke-")));
const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
// A nested SDK marker belongs to the caller, not to these independent sessions.
delete env.CLAUDECODE;
delete env.OPENCODE;
delete env.OPENCODE_PID;
delete env.OPENCODE_SERVER_PASSWORD;
async function run(args: string[], cwd = root, timeout = 120_000) {
  const child = Bun.spawn(args, { cwd, env: { ...env, PWD: cwd }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr.slice(-2000)} ${stdout.slice(-2000)}`);
    return stdout;
  } finally { clearTimeout(timer); }
}
const report: Record<string, unknown> = { date: new Date().toISOString(), root };
try {
  const parent = path.join(root, "atlas");
  await mkdir(parent);
  await run(["git", "init", "--initial-branch=main"], parent);
  await writeFile(path.join(parent, "checkout-marker.txt"), "parent-checkout\n");
  await run(["git", "add", "."], parent);
  await run(["git", "-c", "user.name=Uatu Test", "-c", "user.email=uatu@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "initial"], parent);
  const registry = new WorkspaceRegistry(path.join(root, "registry.json"));
  await registry.load();
  const entry = await registry.register(parent);
  const service = new WorktreeService({ registry, sessions: { isRunning: () => false },
    journal: new WorktreeJournal(path.join(root, "journal.json")),
    provenance: new WorktreeProvenanceStore(path.join(root, "provenance.json")),
    registrar: { async register(input) {
      const child = await registry.register(input.path, "local", input.displayName);
      return { workspaceId: child.id, started: false };
    } },
  });
  const trees: string[] = [];
  for (const name of ["one", "two"]) {
    const result = await service.create("smoke", { sourceWorkspaceId: entry.id, mode: "new-branch", branch: `smoke/${name}`, base: { kind: "local", ref: "main" } });
    assert(result.ok && result.checkout);
    trees.push(result.checkout.path);
    await writeFile(path.join(result.checkout.path, "checkout-marker.txt"), `checkout-${name}\n`);
  }
  const prompt = "Compatibility smoke test. Read checkout-marker.txt using the Read tool. Report its exact contents and your current working directory. Do not edit anything. Keep your answer to two lines.";
  const selected = process.argv[2];
  if (!selected || selected === "claude") {
    report.claudeVersion = (await run(["claude", "--version"])).trim();
    const flags = ["--print", "--output-format", "json", "--model", "haiku", "--max-budget-usd", "1", "--setting-sources", "", "--strict-mcp-config", "--permission-mode", "dontAsk", "--tools=Read,Agent", "--allowedTools=Read,Agent"];
    const first = JSON.parse(await run(["claude", ...flags, prompt], trees[0]));
    assert(!first.is_error, JSON.stringify(first));
    assert(first.result.includes("checkout-one") && first.result.includes(trees[0]));
    const second = JSON.parse(await run(["claude", ...flags, prompt], trees[1]));
    assert(!second.is_error && second.result.includes("checkout-two") && second.result.includes(trees[1]));
    assert.notEqual(first.session_id, second.session_id);
    const resumed = JSON.parse(await run(["claude", ...flags, "--resume", first.session_id, prompt], trees[0]));
    assert(!resumed.is_error && resumed.session_id === first.session_id && resumed.result.includes("checkout-one"));
    const delegated = JSON.parse(await run(["claude", ...flags, "--resume", first.session_id,
      "Use one general-purpose subagent to read checkout-marker.txt in its inherited directory and report the contents and cwd. Do not request isolated worktree mode or edit files. Report the subagent's answer."], trees[0]));
    assert(!delegated.is_error && delegated.result.includes("checkout-one"));
    const transcript = await readSessionTranscript(sessionTranscriptPath(trees[0]!, first.session_id));
    assert(transcript.entries.some(entry => Array.isArray(entry.message.content) && entry.message.content.some(
      (block: { type?: string; name?: string }) => block.type === "tool_use" && ["Agent", "Task"].includes(block.name ?? ""))), "No native subagent tool call was recorded");
    const listedOne = (await listTranscriptSessions(trees[0]!)).sessions.map(session => session.id);
    const listedTwo = (await listTranscriptSessions(trees[1]!)).sessions.map(session => session.id);
    assert(listedOne.includes(first.session_id) && !listedOne.includes(second.session_id));
    assert(listedTwo.includes(second.session_id) && !listedTwo.includes(first.session_id));
    const native = JSON.parse(await run(["claude", ...flags, "--worktree", "native-smoke", prompt], parent));
    assert(!native.is_error && native.result.includes("parent-checkout") && native.result.includes("native-smoke"));
    const nativeCheckout = (await service.inventory(entry.id)).checkouts.find(tree => tree.path.includes("/.claude/worktrees/native-smoke"));
    assert(nativeCheckout?.ownership === "external" && !nativeCheckout.registered);
    report.claude = { newDirectories: [trees[0], trees[1]], distinctSessions: true, resumedSameSession: true,
      uatuTranscriptFiltering: true, recordedSubagentTool: true, nativeDiscoveredExternal: true,
      inheritedSubagent: delegated.result, nativeWorktree: native.result, costUsd: [first, second, resumed, delegated, native].reduce((n, r) => n + (r.total_cost_usd ?? 0), 0) };
    console.log(JSON.stringify({ claude: report.claude }));
  }
  if (!selected || selected === "opencode") {
    report.opencodeVersion = (await run(["opencode", "--version"])).trim();
    async function turn(cwd: string, message: string, session?: string) {
      const output = await run(["opencode", "run", "--pure", "--dir", cwd, "--format", "json", ...(session ? ["--session", session] : []), message], cwd);
      const events = output.trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
      const text = events.filter(e => e.type === "text").map(e => e.part.text).join("\n");
      const id = events.find(e => e.sessionID)?.sessionID;
      assert(id && text, output.slice(-2000));
      return { id, text, tools: events.filter(e => e.type === "tool_use").map(e => e.part.tool) };
    }
    const first = await turn(trees[0]!, prompt);
    assert(first.text.includes("checkout-one") && first.text.includes(trees[0]!), JSON.stringify(first));
    const second = await turn(trees[1]!, prompt);
    assert(second.text.includes("checkout-two") && second.text.includes(trees[1]!), JSON.stringify(second));
    assert.notEqual(first.id, second.id);
    const resumed = await turn(trees[0]!, prompt, first.id);
    assert(resumed.id === first.id && resumed.text.includes("checkout-one"));
    const delegated = await turn(trees[0]!, "Use one general subagent with the task tool to read checkout-marker.txt and report its inherited current directory and marker. Do not edit files or create a worktree. Return the subagent's answer.", first.id);
    assert(delegated.text.includes("checkout-one") && delegated.tools.includes("task"));
    const exported = JSON.parse(await run(["opencode", "export", first.id], trees[0]));
    assert.equal(exported.info.directory, trees[0]);
    report.opencode = { newDirectories: [trees[0], trees[1]], distinctSessions: true, resumedSameSession: true,
      storedDirectory: exported.info.directory, inheritedSubagent: delegated.text };
    console.log(JSON.stringify({ opencode: report.opencode }));
  }
  if (!selected || selected === "opencode" || selected === "opencode-native") {
    const home = path.join(root, "native-home");
    await mkdir(home);
    const runtime = new OpenCodeService({ workspacePath: parent, env: {
      ...env, HOME: home, PWD: parent, XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
    } });
    try {
      assert.equal((await runtime.status()).state, "ready");
      const connection = runtime.currentConnection()!;
      const response = await fetch(`${connection.endpoint}/experimental/worktree?directory=${encodeURIComponent(parent)}`, {
        method: "POST", headers: { "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}` },
        body: JSON.stringify({ name: "native-smoke" }), signal: AbortSignal.timeout(30_000),
      });
      const native = await response.json() as { directory: string; branch: string };
      assert(response.ok, JSON.stringify(native));
      const deadline = Date.now() + 15_000;
      let inventory = await service.inventory(entry.id);
      while (!inventory.checkouts.some(tree => tree.path === native.directory) && Date.now() < deadline) {
        await Bun.sleep(100);
        inventory = await service.inventory(entry.id);
      }
      const discovered = inventory.checkouts.find(tree => tree.path === native.directory);
      assert(discovered, JSON.stringify({ native, inventory }));
      assert.equal(discovered.ownership, "external");
      assert.equal(discovered.registered, false);
      assert.equal(await Bun.file(path.join(trees[0]!, "checkout-marker.txt")).text(), "checkout-one\n");
      report.opencodeNative = { directory: native.directory, branch: native.branch,
        discoveredExternal: true, registered: false, uatuCheckoutPreserved: true,
        removalOrResetCalled: false };
    } finally { await runtime.dispose(); }
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true });
}
