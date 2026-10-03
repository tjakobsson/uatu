import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenCodeService } from "../chat/opencode/opencode-service";
import { createOpenCodeV1Provider } from "../chat/opencode/v1/provider";
import { createOpenCodeV2Provider } from "../chat/opencode/v2/provider";
import { createAccountRuntimeFactory } from "./agent-account-runtime";

/**
 * Agent accounts against a real OpenCode of each generation (design D2, D6).
 * Gated like src/chat/opencode/real-opencode.integration.test.ts:
 *
 *   UATU_REAL_OPENCODE=1                       the gate
 *   UATU_REAL_OPENCODE_V1=/path/to/opencode    a 1.x binary
 *   UATU_REAL_OPENCODE_V2=/path/to/opencode    a 2.x binary
 *
 * Every run gets its own HOME and XDG roots, so nothing touches the
 * developer's own OpenCode logins. A dummy Groq key is saved and removed;
 * nothing calls a model.
 *
 * What is proved: the Hub's account runtime starts the installed OpenCode and
 * picks the adapter for its generation; a key saved through it is seen by a
 * second OpenCode server on the same store (a running workspace's); and the
 * removal replayed on that second server takes the provider's models out of
 * its catalog.
 */
const enabled = process.env.UATU_REAL_OPENCODE === "1";
const roots: string[] = [];

type Generation = { label: string; binary?: string; expected?: 1 | 2 };

function generations(): Generation[] {
  const named: Generation[] = [];
  if (process.env.UATU_REAL_OPENCODE_V1) named.push({ label: "1.x", binary: process.env.UATU_REAL_OPENCODE_V1, expected: 1 });
  if (process.env.UATU_REAL_OPENCODE_V2) named.push({ label: "2.x", binary: process.env.UATU_REAL_OPENCODE_V2, expected: 2 });
  return named.length > 0 ? named : [{ label: "PATH" }];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function isolated(generation: Generation) {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-real-accounts-"));
  roots.push(root);
  const directories = Object.fromEntries(["hub", "workspace", "config", "data", "state", "cache", "bin"].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map(directory => mkdir(directory)));
  const configPath = path.join(directories.config!, "opencode.json");
  await writeFile(configPath, JSON.stringify({ autoupdate: false, share: "disabled" }), "utf8");
  if (generation.binary) await symlink(generation.binary, path.join(directories.bin!, "opencode"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, {
    ...(generation.binary ? { PATH: `${directories.bin}${path.delimiter}${process.env.PATH ?? ""}` } : {}),
    HOME: root,
    XDG_CONFIG_HOME: directories.config!,
    XDG_DATA_HOME: directories.data!,
    XDG_STATE_HOME: directories.state!,
    XDG_CACHE_HOME: directories.cache!,
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: directories.config!,
  });
  delete env.GROQ_API_KEY;
  return { env, hubDirectory: directories.hub!, workspace: directories.workspace! };
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    last = await read();
  }
  return last;
}

for (const generation of generations()) {
  describe.skipIf(!enabled)(`Agent accounts on real OpenCode (${generation.label})`, () => {
    test("a key saved by the Hub reaches a running workspace's server, and a replayed removal takes it out", async () => {
      const { env, hubDirectory, workspace } = await isolated(generation);
      const runtime = createAccountRuntimeFactory({ cwd: hubDirectory, env })("opencode");
      const workspaceServer = new OpenCodeService({ workspacePath: workspace, env });
      try {
        const started = await runtime.start();
        expect(started.state).toBe("ready");
        if (started.state !== "ready") return;
        if (generation.expected) expect(started.generation).toBe(generation.expected);
        const adapter = started.adapter;

        // The catalog loads a moment after a 2.x server answers ready.
        const before = await eventually(() => adapter.status(), status => status.targets.some(target => target.id === "groq"));
        const groq = before.targets.find(target => target.id === "groq")!;
        expect(groq.connected).toBe(false);
        const keyMethod = groq.methods.find(method => method.kind === "key");
        expect(keyMethod).toBeDefined();
        console.log(`[${generation.label}] ${started.version}: ${before.targets.length} providers; groq methods ${groq.methods.map(method => method.kind).join(", ")}`);

        // A workspace's own server, started before the login, on the same store.
        expect((await workspaceServer.status()).state).toBe("ready");
        const connection = workspaceServer.currentConnection()!;
        const provider = connection.generation === 2
          ? createOpenCodeV2Provider({ endpoint: connection.endpoint, password: connection.password, directory: workspace })
          : createOpenCodeV1Provider({ endpoint: connection.endpoint, password: connection.password, directory: workspace });
        const groqModels = async () => (await provider.listModels()).filter(model => model.selection.providerId === "groq").length;
        expect(await groqModels()).toBe(0);

        await adapter.connectKey("groq", keyMethod!.id, "gsk-uatu-integration-dummy", {});
        const after = await eventually(() => adapter.status(), status => status.targets.find(target => target.id === "groq")?.connected === true);
        const saved = after.targets.find(target => target.id === "groq")!;
        expect(saved.connected).toBe(true);
        expect(JSON.stringify(after)).not.toContain("gsk-uatu-integration-dummy");

        // Seen by the workspace's server without a restart (design D6).
        expect(await eventually(groqModels, count => count > 0)).toBeGreaterThan(0);

        // Logged out through the Hub where this OpenCode can remove logins,
        // then replayed on the workspace's server.
        if (adapter.capabilities.logout) {
          const credential = saved.credentials.find(entry => entry.removable);
          expect(credential).toBeDefined();
          await adapter.logout("groq", credential!.id);
          await provider.accountsChanged?.({ kind: "removed", target: "groq", credential: credential!.id });
          expect(await eventually(groqModels, count => count === 0)).toBe(0);
          const out = await eventually(() => adapter.status(), status => status.targets.find(target => target.id === "groq")?.connected === false);
          expect(out.targets.find(target => target.id === "groq")?.connected).toBe(false);
        } else {
          console.log(`[${generation.label}] this OpenCode cannot remove saved logins; logout is not offered`);
        }
      } finally {
        await workspaceServer.dispose();
        await runtime.stop();
      }
    }, 120_000);
  });
}
