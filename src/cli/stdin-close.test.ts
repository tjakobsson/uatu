// Integration coverage for --exit-on-stdin-close: spawn the real CLI with a
// piped stdin and verify the flag couples the server's lifetime to the pipe —
// and that without the flag it deliberately does not. Uses `bun src/cli.ts`
// (not the compiled binary) so the suite has no build-step dependency.

import { describe, expect, test } from "bun:test";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const DOCS = path.join(REPO_ROOT, "testdata", "watch-docs");

type Served = {
  proc: ReturnType<typeof Bun.spawn>;
  exited: Promise<number>;
};

// Start `uatu serve` on an ephemeral port with stdin piped, resolving once the
// URL line appears on stdout (the ready signal wrappers rely on).
async function serveWithPipedStdin(extraArgs: string[]): Promise<Served> {
  const proc = Bun.spawn(
    ["bun", path.join(REPO_ROOT, "src", "cli.ts"), "serve", DOCS, "--no-open", "--no-watchdog", "--port", "0", ...extraArgs],
    { cwd: REPO_ROOT, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 30_000;
  while (!/http:\/\/\S+/.test(output)) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`server never printed a URL; output so far: ${output}`);
    }
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
  }
  reader.releaseLock();
  return { proc, exited: proc.exited };
}

describe("--exit-on-stdin-close", () => {
  test("closing stdin shuts the server down cleanly", async () => {
    const { proc, exited } = await serveWithPipedStdin(["--exit-on-stdin-close"]);
    proc.stdin.end();
    const code = await exited;
    expect(code).toBe(0);
  }, 40_000);

  test("without the flag the server survives stdin close", async () => {
    const { proc, exited } = await serveWithPipedStdin([]);
    proc.stdin.end();
    // Give an (incorrect) EOF-coupled shutdown ample time to happen.
    const raced = await Promise.race([
      exited.then(() => "exited" as const),
      Bun.sleep(2_000).then(() => "alive" as const),
    ]);
    expect(raced).toBe("alive");
    proc.kill("SIGTERM");
    await exited;
  }, 40_000);
});
