import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Presentation hints, not tool permissions or changes to the user's prompt. */
export const CHAT_PRESENTATION_GUIDANCE = `Uatu chat can show visuals when helpful: use standard Markdown images such as ![description](workspace-relative/path.png), with PNG, JPG, JPEG, or SVG files saved in permitted workspace locations. Fenced svg blocks also preview while retaining their original source. Use self-contained diagrams: remote images/resources, scripts, foreignObject, and external SVG dependencies are not displayed. Keep visuals within 10 MiB each and 8 per message. Finish creating a file before embedding it: the first capture is immutable, so later changes need a new image occurrence. Native tool image blocks are not automatically extracted; embed the saved workspace file instead.`;

/** Preserve inline settings; other config sources remain OpenCode's responsibility. */
export function withPresentationInstructions(content: string | undefined, file: string): string {
  let config: unknown;
  try { config = content === undefined ? {} : Bun.JSONC.parse(content); }
  catch { throw new Error("Uatu cannot add chat guidance: OPENCODE_CONFIG_CONTENT is not valid JSON/JSONC."); }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Uatu cannot add chat guidance: OPENCODE_CONFIG_CONTENT must be an object.");
  }
  const record = config as Record<string, unknown>;
  const instructions = record.instructions;
  if (instructions !== undefined && (!Array.isArray(instructions) || instructions.some(entry => typeof entry !== "string"))) {
    throw new Error("Uatu cannot add chat guidance: inline instructions must be an array of strings.");
  }
  return JSON.stringify({ ...record, instructions: [...(instructions as string[] | undefined ?? []), file] });
}

/** Materialized from bundled text for the separate CLI process, never in user config. */
export async function preparePresentationGuidanceFile(env: NodeJS.ProcessEnv): Promise<string> {
  const stateHome = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state");
  const directory = path.resolve(stateHome, "uatu", "chat-presentation");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await sweepStaleGuidance(directory);
  // Each service owns its file; no shared file can be partially overwritten by
  // another workspace or a different Uatu build.
  const owned = await fs.mkdtemp(path.join(directory, "session-"));
  const file = path.join(owned, "instructions.md");
  try {
    await fs.writeFile(path.join(owned, "owner.json"), JSON.stringify({ kind: "uatu-chat-presentation", version: 1, pid: process.pid }), { mode: 0o600, flag: "wx" });
    await fs.writeFile(file, CHAT_PRESENTATION_GUIDANCE, { mode: 0o600, flag: "wx" });
    return file;
  } catch (error) {
    await fs.rm(owned, { recursive: true, force: true });
    throw error;
  }
}

async function sweepStaleGuidance(directory: string): Promise<void> {
  // Bound optional startup housekeeping. Never infer staleness from elapsed
  // time or delete another live process's instructions (including PID reuse).
  let inspected = 0;
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (inspected++ >= 256) break;
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const owned = path.join(directory, entry.name);
    try {
      const ownerPath = path.join(owned, "owner.json");
      if (!(await fs.lstat(ownerPath)).isFile()) continue;
      const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Record<string, unknown>;
      if (owner.kind !== "uatu-chat-presentation" || owner.version !== 1
        || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
      try { process.kill(owner.pid, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      const files = await fs.readdir(owned);
      if (files.some(name => name !== "owner.json" && name !== "instructions.md")) continue;
      await fs.rm(owned, { recursive: true, force: true });
    } catch {
      // Unknown ownership, races and inaccessible files are not deletion authority.
    }
  }
}

export async function removePresentationGuidanceFile(file: string): Promise<void> {
  await fs.rm(path.dirname(file), { recursive: true, force: true });
}
